import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTripRepository } from "../src/services/trip/tripRepository.js";
import { TripService, TripError } from "../src/services/trip/tripService.js";
import { InMemoryMessageQueue } from "../src/shared/messageBus.js";
import { LocationService } from "../src/services/location/locationService.js";
import { DispatchService } from "../src/services/dispatch/dispatchService.js";
import { offsetMeters } from "./helpers.js";

const CAIRO = { lat: 30.0444, lng: 31.2357 };
// تأخير عشوائي في "قاعدة البيانات" عشان الطلبات تتداخل فعلاً
const jitter = () => Math.random() * 8;

async function setup(drivers: number) {
  const bus = new InMemoryMessageQueue();
  const repo = new InMemoryTripRepository({ latencyMs: jitter });
  const trips = new TripService(repo, bus);
  const location = new LocationService();
  for (let i = 0; i < drivers; i++) location.updateLocation(`d${i}`, offsetMeters(CAIRO, 100 + i * 30, 50));
  const dispatch = new DispatchService(bus, location, trips, { fanout: drivers }).start();
  const trip = await trips.requestTrip("r1", CAIRO, offsetMeters(CAIRO, 3000, 2000));
  await bus.drain(); // dispatch بعت العروض
  return { bus, repo, trips, location, dispatch, trip };
}

test("CAS at repository level: only one of many concurrent writers with the same version wins", async () => {
  const repo = new InMemoryTripRepository({ latencyMs: jitter });
  const trips = new TripService(repo, new InMemoryMessageQueue());
  const trip = await trips.requestTrip("r1", CAIRO, offsetMeters(CAIRO, 1000, 0));
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) => trips.assignDriver(trip.id, `d${i}`, trip.version)),
  );
  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1);
  const stored = await repo.get(trip.id);
  assert.equal(stored!.status, "accepted");
  assert.equal(stored!.driverId, winners[0]!.driverId);
  assert.equal(stored!.version, 2);
});

test("two drivers accept the same request at the same moment → exactly one gets it", async () => {
  for (let run = 0; run < 30; run++) {
    const { dispatch, trip, location, repo, bus } = await setup(2);
    assert.deepEqual(dispatch.offeredDrivers(trip.id).sort(), ["d0", "d1"]);
    const [a, b] = await Promise.all([dispatch.accept(trip.id, "d0"), dispatch.accept(trip.id, "d1")]);
    const oks = [a, b].filter((r) => r.ok);
    assert.equal(oks.length, 1, `run ${run}: expected exactly one winner`);
    const loser = [a, b].find((r) => !r.ok)!;
    assert.equal(loser.ok === false && loser.reason, "already_taken");
    const winnerId = a.ok ? "d0" : "d1";
    const loserId = a.ok ? "d1" : "d0";
    const stored = await repo.get(trip.id);
    assert.equal(stored!.driverId, winnerId);
    // الكسبان بقى مشغول، والخسران رجع متاح
    assert.equal(location.getLocation(winnerId)!.status, "busy");
    assert.equal(location.getLocation(loserId)!.status, "available");
    dispatch.stop();
    await bus.drain();
  }
});

test("ten drivers stampede → one winner, nine released", async () => {
  const { dispatch, trip, location } = await setup(10);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => dispatch.accept(trip.id, `d${i}`)));
  assert.equal(results.filter((r) => r.ok).length, 1);
  const busy = [...Array(10).keys()].filter((i) => location.getLocation(`d${i}`)!.status === "busy");
  assert.equal(busy.length, 1);
  dispatch.stop();
});

test("one driver cannot hold two trips at once", async () => {
  const bus = new InMemoryMessageQueue();
  const trips = new TripService(new InMemoryTripRepository({ latencyMs: jitter }), bus);
  const location = new LocationService();
  location.updateLocation("d0", offsetMeters(CAIRO, 100, 0));
  const dispatch = new DispatchService(bus, location, trips).start();
  const t1 = await trips.requestTrip("r1", CAIRO, offsetMeters(CAIRO, 2000, 0));
  const t2 = await trips.requestTrip("r2", CAIRO, offsetMeters(CAIRO, 0, 2000));
  await bus.drain();
  const [a, b] = await Promise.all([dispatch.accept(t1.id, "d0"), dispatch.accept(t2.id, "d0")]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  const failed = [a, b].find((r) => !r.ok)!;
  assert.equal(failed.ok === false && failed.reason, "driver_busy");
  dispatch.stop();
});

test("rider cancels at the same moment the driver taps 'arrived' → state stays consistent", async () => {
  for (let run = 0; run < 20; run++) {
    const { dispatch, trip, trips, repo } = await setup(1);
    await dispatch.accept(trip.id, "d0");
    const [arrive, cancel] = await Promise.allSettled([trips.arrive(trip.id, "d0"), trips.cancel(trip.id, "rider", "r1")]);
    const final = (await repo.get(trip.id))!;
    // الاتنين مسموحين من accepted؛ مهما كان الترتيب النتيجة لازم تكون منطقية
    if (final.status === "cancelled") {
      assert.equal(cancel.status, "fulfilled");
      // لو arrive كسب الأول، cancel بيتعمل من driver_arrived (مسموح) → الاتنين ينجحوا؛ غير كده arrive يفشل
      if (arrive.status === "rejected") assert.equal((arrive.reason as TripError).code, "invalid_transition");
    } else {
      assert.fail(`unexpected final state ${final.status}`);
    }
    assert.ok(final.version >= 3);
    dispatch.stop();
  }
});

test("driver who was not offered the trip cannot accept it", async () => {
  const { dispatch, trip } = await setup(1);
  const r = await dispatch.accept(trip.id, "intruder");
  assert.deepEqual(r, { ok: false, reason: "not_offered" });
  dispatch.stop();
});
