import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { FakePaymentGateway } from "../src/services/payment/paymentService.js";
import { TestClient } from "./ws-client.js";
import { offsetMeters, sleep } from "./helpers.js";

const CAIRO = { lat: 30.0444, lng: 31.2357 };

async function boot(paymentFailures = 0) {
  const payment = new FakePaymentGateway(paymentFailures);
  const app = createApp({ paymentGateway: payment, location: { minUpdateIntervalMs: 0 } });
  const port = await app.listen(0);
  return { app, payment, base: `ws://127.0.0.1:${port}` };
}

test("full trip over WebSocket: request → offer → race → lifecycle → payment, notifications, accounting, rating", async () => {
  const { app, payment, base } = await boot(2); // بوابة الدفع هتفشل مرتين → retry
  try {
    const d1 = await TestClient.connect(base, "driver", "d1");
    const d2 = await TestClient.connect(base, "driver", "d2");
    const far = await TestClient.connect(base, "driver", "far");
    const rider = await TestClient.connect(base, "rider", "r1");

    d1.send({ type: "location", ...offsetMeters(CAIRO, 300, 0) });
    d2.send({ type: "location", ...offsetMeters(CAIRO, 0, 400) });
    far.send({ type: "location", ...offsetMeters(CAIRO, 40_000, 0) });
    await sleep(50);
    assert.equal(app.location.onlineDrivers, 3);

    const req = await rider.request({ type: "request_trip", pickup: CAIRO, dropoff: offsetMeters(CAIRO, 3000, 4000), rideType: "comfort" });
    assert.equal(req.type, "ack");
    const tripId = req.trip.id;

    // العرض بيوصل للاتنين القريبين بس
    const [o1, o2] = await Promise.all([
      d1.waitFor((m) => m.type === "trip_offer"),
      d2.waitFor((m) => m.type === "trip_offer"),
    ]);
    assert.equal(o1.offer.tripId, tripId);
    assert.equal(o2.offer.tripId, tripId);
    await sleep(30);
    assert.equal(far.inbox.filter((m) => m.type === "trip_offer").length, 0);

    // السباق: الاتنين يقبلوا في نفس اللحظة
    const [a1, a2] = await Promise.all([d1.request({ type: "accept", tripId }), d2.request({ type: "accept", tripId })]);
    const results = [a1.result, a2.result];
    assert.equal(results.filter((r) => r.ok).length, 1);
    const [winner, loser] = a1.result.ok ? [d1, d2] : [d2, d1];
    const winnerId = a1.result.ok ? "d1" : "d2";
    assert.equal((a1.result.ok ? a2 : a1).result.reason, "already_taken");
    await loser.waitFor((m) => m.type === "offer_withdrawn" && m.reason === "taken");

    // الزبون عرف إن الرحلة اتقبلت
    const upd = await rider.waitFor((m) => m.type === "trip_update" && m.trip.status === "accepted");
    assert.equal(upd.trip.driverId, winnerId);

    // ممنوع تبدأ قبل ما توصل
    const early = await winner.request({ type: "start", tripId });
    assert.equal(early.code, "invalid_transition");
    // ممنوع الخسران يلمس الرحلة
    const hijack = await loser.request({ type: "arrive", tripId });
    assert.equal(hijack.code, "forbidden");

    assert.equal((await winner.request({ type: "arrive", tripId })).trip.status, "driver_arrived");
    await rider.waitFor((m) => m.type === "notification" && m.title.includes("وصل"));
    assert.equal((await winner.request({ type: "start", tripId })).trip.status, "started");
    // الزبون مايقدرش يلغي بعد ما الرحلة بدأت
    assert.equal((await rider.request({ type: "cancel", tripId })).code, "invalid_transition");

    const done = await winner.request({ type: "complete", tripId });
    assert.equal(done.trip.status, "completed");
    const fare = done.trip.fareCents;

    // كل اللي بعد كده async من الطابور
    const earning = await winner.waitFor((m) => m.type === "earning", 3000);
    assert.equal(earning.amountCents, fare - Math.round(fare * 0.2));
    await rider.waitFor((m) => m.type === "notification" && m.title.includes("الدفع"));
    assert.equal(payment.charges.length, 1, "charged exactly once despite 2 gateway failures");
    assert.equal(app.accounting.balance("rider:r1"), -fare);
    assert.equal(app.accounting.balance(`driver:${winnerId}`) + app.accounting.balance("platform:revenue"), fare);

    assert.equal((await rider.request({ type: "rate", tripId, stars: 5 })).type, "ack");
    await app.bus.drain();
    assert.equal(app.ratings.average(winnerId), 5);

    // الكابتن رجع متاح بعد الرحلة
    assert.equal(app.location.getLocation(winnerId)!.status, "available");
    for (const c of [d1, d2, far, rider]) c.close();
  } finally {
    await app.close();
  }
});

test("driver disconnect removes it from the in-memory index", async () => {
  const { app, base } = await boot();
  try {
    const d = await TestClient.connect(base, "driver", "dx");
    d.send({ type: "location", ...CAIRO });
    await sleep(30);
    assert.equal(app.location.onlineDrivers, 1);
    d.close();
    await sleep(50);
    assert.equal(app.location.onlineDrivers, 0);
  } finally {
    await app.close();
  }
});

test("no drivers nearby → trip cancelled by system and rider notified", async () => {
  const { app, base } = await boot();
  try {
    const rider = await TestClient.connect(base, "rider", "lonely");
    const r = await rider.request({ type: "request_trip", pickup: CAIRO, dropoff: offsetMeters(CAIRO, 1000, 0) });
    const upd = await rider.waitFor((m) => m.type === "trip_update" && m.trip.status === "cancelled");
    assert.equal(upd.trip.id, r.trip.id);
    assert.equal(upd.trip.cancelledBy, "system");
    rider.close();
  } finally {
    await app.close();
  }
});

test("offer expiry moves to the next nearest drivers", async () => {
  const app = createApp({ location: { minUpdateIntervalMs: 0 }, dispatch: { fanout: 1, offerTtlMs: 80 } });
  const base = `ws://127.0.0.1:${await app.listen(0)}`;
  try {
    const near = await TestClient.connect(base, "driver", "near");
    const next = await TestClient.connect(base, "driver", "next");
    near.send({ type: "location", ...offsetMeters(CAIRO, 100, 0) });
    next.send({ type: "location", ...offsetMeters(CAIRO, 900, 0) });
    const rider = await TestClient.connect(base, "rider", "r");
    await sleep(30);
    await rider.request({ type: "request_trip", pickup: CAIRO, dropoff: offsetMeters(CAIRO, 1000, 1000) });
    await near.waitFor((m) => m.type === "trip_offer");
    await near.waitFor((m) => m.type === "offer_withdrawn" && m.reason === "expired");
    const o = await next.waitFor((m) => m.type === "trip_offer");
    const acc = await next.request({ type: "accept", tripId: o.offer.tripId });
    assert.equal(acc.result.ok, true);
    for (const c of [near, next, rider]) c.close();
  } finally {
    await app.close();
  }
});

test("bad input is rejected", async () => {
  const { app, base } = await boot();
  try {
    const d = await TestClient.connect(base, "driver", "d");
    const bad = await d.request({ type: "location", lat: 999, lng: 0 });
    assert.equal(bad.code, "bad_request");
    const r = await TestClient.connect(base, "rider", "r");
    assert.equal((await r.request({ type: "rate", tripId: "nope", stars: 9 })).code, "bad_request");
    d.close();
    r.close();
  } finally {
    await app.close();
  }
});
