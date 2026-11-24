import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { InMemoryTripRepository } from "../src/services/trip/tripRepository.js";
import { calculateFareCents } from "../src/services/trip/tripService.js";
import { TestClient } from "./ws-client.js";
import { offsetMeters, sleep } from "./helpers.js";

const CAIRO = { lat: 30.0444, lng: 31.2357 };

async function boot() {
  const app = createApp({ location: { minUpdateIntervalMs: 0 } });
  const port = await app.listen(0);
  return { app, base: `ws://127.0.0.1:${port}` };
}

/** رحلة كاملة من الطلب للنهاية — بترجع رقم الرحلة */
async function rideToEnd(rider: TestClient, driver: TestClient, extra: object = {}) {
  const req = await rider.request({ type: "request_trip", pickup: CAIRO, dropoff: offsetMeters(CAIRO, 2000, 1500), ...extra });
  assert.equal(req.type, "ack", JSON.stringify(req));
  const tripId = req.trip.id;
  await driver.waitFor((m) => m.type === "trip_offer" && m.offer.tripId === tripId);
  assert.equal((await driver.request({ type: "accept", tripId })).result.ok, true);
  for (const step of ["arrive", "start", "complete"]) assert.equal((await driver.request({ type: step, tripId })).type, "ack");
  return req.trip;
}

test("تاريخ الرحلات: الزبون والكابتن بيشوفوا رحلاتهم بالأسامي والتقييم والصافي", async () => {
  const { app, base } = await boot();
  try {
    const driver = await TestClient.connect(base, "driver", "d-hist");
    const rider = await TestClient.connect(base, "rider", "r-hist");
    const other = await TestClient.connect(base, "rider", "r-other");
    driver.send({ type: "profile", name: "كابتن أحمد", car: "نيسان صني", plate: "س م ع ١٢٣" });
    rider.send({ type: "profile", name: "منى" });
    driver.send({ type: "location", ...offsetMeters(CAIRO, 200, 0) });
    await sleep(30);

    const done = await rideToEnd(rider, driver, { pickupName: "التحرير", dropoffName: "الزمالك" });

    // رحلة تانية الزبون يلغيها قبل ما حد يقبل
    const req2 = await rider.request({ type: "request_trip", pickup: CAIRO, dropoff: offsetMeters(CAIRO, 500, 500), dropoffName: "جاردن سيتي" });
    await rider.request({ type: "cancel", tripId: req2.trip.id });

    // التقييم بيتحفظ على الرحلة، ومينفعش يتقيّم مرتين
    assert.equal((await rider.request({ type: "rate", tripId: done.id, stars: 4 })).type, "ack");
    const again = await rider.request({ type: "rate", tripId: done.id, stars: 1 });
    assert.equal(again.code, "conflict");

    await sleep(150); // الدفع والحسابات بيشتغلوا من الطابور

    const rh = await rider.request({ type: "history" });
    assert.equal(rh.type, "ack");
    assert.deepEqual(rh.trips.map((t: any) => t.status), ["cancelled", "completed"]); // الأحدث الأول
    const c = rh.trips[1];
    assert.equal(c.pickupName, "التحرير");
    assert.equal(c.dropoffName, "الزمالك");
    assert.equal(c.riderStars, 4);
    assert.equal(c.driverProfile.name, "كابتن أحمد");
    assert.equal(c.driverProfile.plate, "س م ع ١٢٣");
    assert.equal(rh.trips[0].cancelledBy, "rider");

    // الكابتن بيشوف الرحلة اللي اتعينت له بس، ومعاها الصافي بعد عمولة ٢٠٪
    const dh = await driver.request({ type: "history" });
    assert.equal(dh.trips.length, 1);
    assert.equal(dh.trips[0].id, done.id);
    assert.equal(dh.trips[0].riderName, "منى");
    assert.equal(dh.trips[0].netCents, done.fareCents - Math.round(done.fareCents * 0.2));

    // زبون تاني مايشوفش رحلات حد
    assert.equal((await other.request({ type: "history" })).trips.length, 0);
    for (const c of [driver, rider, other]) c.close();
  } finally {
    await app.close();
  }
});

test("أكواد الخصم: الخصم بيتحسب صح، والكود مرة واحدة لكل زبون", async () => {
  const { app, base } = await boot();
  try {
    const driver = await TestClient.connect(base, "driver", "d-promo");
    const rider = await TestClient.connect(base, "rider", "r-promo");
    driver.send({ type: "location", ...offsetMeters(CAIRO, 200, 0) });
    await sleep(30);

    assert.equal((await rider.request({ type: "check_promo", code: "NOPE" })).message, "invalid_promo");
    const ok = await rider.request({ type: "check_promo", code: " fitari2ak " });
    assert.equal(ok.promo.code, "FITARI2AK");
    assert.equal(ok.promo.percent, 20);

    const full = calculateFareCents(CAIRO, offsetMeters(CAIRO, 2000, 1500), "eco");
    const trip = await rideToEnd(rider, driver, { promoCode: "FITARI2AK" });
    const discount = Math.min(3000, Math.round(full * 0.2));
    assert.equal(trip.discountCents, discount);
    assert.equal(trip.fareCents, full - discount);
    assert.equal(trip.promoCode, "FITARI2AK");

    // الكود اتستخدم خلاص، و WELCOME50 لأول رحلة بس
    assert.equal((await rider.request({ type: "check_promo", code: "FITARI2AK" })).message, "promo_used");
    assert.equal((await rider.request({ type: "check_promo", code: "WELCOME50" })).message, "promo_first_trip_only");
    const bad = await rider.request({ type: "request_trip", pickup: CAIRO, dropoff: offsetMeters(CAIRO, 900, 0), promoCode: "FITARI2AK" });
    assert.equal(bad.type, "error");
    driver.close();
    rider.close();
  } finally {
    await app.close();
  }
});

test("المستودع: الترتيب والصفحات (limit + before)", async () => {
  const repo = new InMemoryTripRepository();
  const base = { pickup: CAIRO, dropoff: CAIRO, status: "completed" as const, version: 1, fareCents: 100, cancelledBy: null, updatedAt: 0 };
  for (let i = 1; i <= 5; i++) await repo.insert({ ...base, id: `t${i}`, riderId: "r", driverId: i % 2 ? "d" : "x", createdAt: i * 1000 });
  const page1 = await repo.listByUser("rider", "r", { limit: 2 });
  assert.deepEqual(page1.map((t) => t.id), ["t5", "t4"]);
  const page2 = await repo.listByUser("rider", "r", { limit: 2, before: page1.at(-1)!.createdAt });
  assert.deepEqual(page2.map((t) => t.id), ["t3", "t2"]);
  assert.deepEqual((await repo.listByUser("driver", "d")).map((t) => t.id), ["t5", "t3", "t1"]);
  assert.deepEqual(await repo.listByUser("driver", "nobody"), []);
});
