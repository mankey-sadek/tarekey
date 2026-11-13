import { test } from "node:test";
import assert from "node:assert/strict";
import { DriverLocationStore } from "../src/services/location/driverLocationStore.js";
import { LocationService } from "../src/services/location/locationService.js";
import { haversineMeters } from "../src/shared/geo.js";
import { offsetMeters } from "./helpers.js";

const CAIRO = { lat: 30.0444, lng: 31.2357 };

test("H3 nearest search matches brute force on 5,000 random drivers", () => {
  const store = new DriverLocationStore({ resolution: 9 });
  const all: { id: string; p: { lat: number; lng: number } }[] = [];
  for (let i = 0; i < 5000; i++) {
    const p = offsetMeters(CAIRO, (Math.random() - 0.5) * 30_000, (Math.random() - 0.5) * 30_000);
    store.upsert(`d${i}`, p);
    all.push({ id: `d${i}`, p });
  }
  for (let q = 0; q < 50; q++) {
    const origin = offsetMeters(CAIRO, (Math.random() - 0.5) * 20_000, (Math.random() - 0.5) * 20_000);
    const got = store.findNearest(origin, { limit: 5, maxRings: 40 }).map((d) => d.driverId);
    const expected = all
      .map((d) => ({ id: d.id, dist: haversineMeters(origin, d.p) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 5)
      .map((d) => d.id);
    assert.equal(got[0], expected[0], "closest driver must be exact");
    assert.ok(got.filter((id) => expected.includes(id)).length >= 4, "top-5 must (almost) match");
  }
});

test("moving a driver moves it between H3 cells", () => {
  const store = new DriverLocationStore();
  const a = store.upsert("d1", CAIRO);
  const b = store.upsert("d1", offsetMeters(CAIRO, 2000, 0));
  assert.notEqual(a.cell, b.cell);
  assert.equal(store.size, 1);
  assert.equal(store.findNearest(CAIRO, { limit: 1, maxRings: 1 }).length, 0); // مابقاش في الخلية القديمة
  assert.equal(store.findNearest(offsetMeters(CAIRO, 2000, 0), { limit: 1 })[0].driverId, "d1");
});

test("busy and stale drivers are never returned", () => {
  let now = 1_000_000;
  const store = new DriverLocationStore({ staleAfterMs: 30_000, now: () => now });
  store.upsert("busy", offsetMeters(CAIRO, 50, 0));
  store.upsert("stale", offsetMeters(CAIRO, 60, 0));
  store.upsert("ok", offsetMeters(CAIRO, 900, 0));
  assert.ok(store.tryReserve("busy"));
  now += 20_000;
  store.upsert("ok", offsetMeters(CAIRO, 900, 0)); // ده بس اللي لسه بيبعت
  store.upsert("busy", offsetMeters(CAIRO, 50, 0));
  now += 15_000;
  const ids = store.findNearest(CAIRO, { limit: 5 }).map((d) => d.driverId);
  assert.deepEqual(ids, ["ok"]);
  assert.deepEqual(store.evictStale(), ["stale"]);
});

test("tryReserve is check-and-set", () => {
  const store = new DriverLocationStore();
  store.upsert("d1", CAIRO);
  assert.equal(store.tryReserve("d1"), true);
  assert.equal(store.tryReserve("d1"), false);
  store.release("d1");
  assert.equal(store.tryReserve("d1"), true);
  assert.equal(store.tryReserve("ghost"), false);
});

test("location updates are throttled per driver", () => {
  let now = 0;
  const svc = new LocationService({ minUpdateIntervalMs: 500, now: () => now });
  assert.equal(svc.updateLocation("d1", CAIRO), true);
  now += 100;
  assert.equal(svc.updateLocation("d1", CAIRO), false);
  now += 500;
  assert.equal(svc.updateLocation("d1", CAIRO), true);
  assert.deepEqual(svc.stats, { accepted: 2, throttled: 1 });
});

test("max distance filter", () => {
  const store = new DriverLocationStore();
  store.upsert("far", offsetMeters(CAIRO, 8000, 0));
  assert.equal(store.findNearest(CAIRO, { limit: 1, maxDistanceMeters: 5000, maxRings: 40 }).length, 0);
});
