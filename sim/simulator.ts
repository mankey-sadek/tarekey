/**
 * سيميوليتر في الترمينال: بيشغّل السيرفر الحقيقي ويوصل بيه سواقين وزباين وهميين على WebSocket.
 *   npm run sim
 */
import { createApp } from "../src/app.js";
import { TestClient } from "../test/ws-client.js";
import { offsetMeters, sleep } from "../test/helpers.js";
import { Topics } from "../src/shared/contracts.js";

const CAIRO = { lat: 30.0444, lng: 31.2357 };
const DRIVERS = 60;
const RIDERS = 5;
const c = { dim: "\x1b[2m", g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", b: "\x1b[36m", m: "\x1b[35m", x: "\x1b[0m" };
const log = (tag: string, color: string, msg: string) => console.log(`${c.dim}${new Date().toISOString().slice(11, 23)}${c.x} ${color}${tag.padEnd(7)}${c.x} ${msg}`);

const app = createApp({ location: { minUpdateIntervalMs: 0 }, dispatch: { fanout: 3, offerTtlMs: 4000 }, requireAuth: true });
const port = await app.listen(Number(process.env.PORT ?? 0));
const base = `ws://127.0.0.1:${port}`;
log("SERVER", c.b, `listening on ${port} — UI: http://localhost:${port}/`);

// نتفرج على الطابور
app.bus.subscribe<any>(Topics.PaymentCaptured, "sim-log", (m) => log("PAY", c.g, `${m.payload.tripId} charged ${(m.payload.amountCents / 100).toFixed(2)} EGP`));
app.bus.subscribe<any>(Topics.TripRated, "sim-log", (m) => log("RATE", c.m, `${m.payload.driverId} ★${m.payload.stars}`));

// ---------- السواقين ----------
interface SimDriver { id: string; ws: TestClient; pos: { lat: number; lng: number }; busy: boolean }
const drivers: SimDriver[] = [];
for (let i = 0; i < DRIVERS; i++) {
  const id = `d${String(i).padStart(2, "0")}`;
  const ws = await TestClient.connect(base, "driver", id, app.auth.issueToken("driver", id));
  const d: SimDriver = { id, ws, pos: offsetMeters(CAIRO, (Math.random() - 0.5) * 6000, (Math.random() - 0.5) * 6000), busy: false };
  drivers.push(d);
  ws.ws.on("message", (raw) => onDriverMsg(d, JSON.parse(raw.toString())));
}
const locTimer = setInterval(() => {
  for (const d of drivers) {
    if (!d.busy) d.pos = offsetMeters(d.pos, (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60);
    d.ws.send({ type: "location", ...d.pos });
  }
}, 1000);
await sleep(1100);
log("H3", c.m, `${app.location.onlineDrivers} drivers in memory, indexed by H3 res ${app.location.store.resolution}`);

async function onDriverMsg(d: SimDriver, m: any) {
  if (m.type === "trip_offer") {
    log("OFFER", c.y, `→ ${d.id} trip ${m.offer.tripId} (${m.offer.distanceMeters}m away)`);
    // كلهم بيحاولوا يقبلوا تقريباً في نفس اللحظة → سباق حقيقي
    await sleep(Math.random() * 15);
    const r = await d.ws.request({ type: "accept", tripId: m.offer.tripId });
    if (r.result?.ok) {
      log("CAS", c.g, `✓ ${d.id} won trip ${m.offer.tripId} (version → ${r.result.version})`);
      d.busy = true;
      void drive(d, m.offer);
    } else log("CAS", c.r, `✗ ${d.id} lost ${m.offer.tripId}: ${r.result?.reason}`);
  }
}

async function drive(d: SimDriver, offer: any) {
  const step = async (type: string) => {
    await sleep(400 + Math.random() * 400);
    const r = await d.ws.request({ type, tripId: offer.tripId });
    if (r.type === "error") log("FSM", c.r, `${d.id} ${type} → ${r.code}`);
    else log("FSM", c.b, `${offer.tripId}: ${type} → ${r.trip.status}`);
    return r.type !== "error";
  };
  d.pos = offer.pickup;
  if (!(await step("arrive"))) return void (d.busy = false);
  if (!(await step("start"))) return void (d.busy = false);
  d.pos = offer.dropoff;
  await step("complete");
  d.busy = false;
}

// ---------- الزباين ----------
await Promise.all(
  Array.from({ length: RIDERS }, async (_, i) => {
    const rider = await TestClient.connect(base, "rider", `r${i}`, app.auth.issueToken("rider", `r${i}`));
    await sleep(i * 300);
    const pickup = offsetMeters(CAIRO, (Math.random() - 0.5) * 4000, (Math.random() - 0.5) * 4000);
    const dropoff = offsetMeters(pickup, (Math.random() - 0.5) * 8000, (Math.random() - 0.5) * 8000);
    const r = await rider.request({ type: "request_trip", pickup, dropoff, rideType: "eco" });
    log("RIDER", c.b, `r${i} requested ${r.trip.id} — fare ${(r.trip.fareCents / 100).toFixed(2)} EGP`);
    const done = await rider.waitFor((m) => m.type === "trip_update" && ["completed", "cancelled"].includes(m.trip.status), 20000);
    if (done.trip.status === "completed") {
      await rider.request({ type: "rate", tripId: r.trip.id, stars: 4 + Math.round(Math.random()) });
    }
  }),
);

await sleep(800);
await app.bus.drain();
const revenue = app.accounting.balance("platform:revenue");
log("DONE", c.g, `ledger entries: ${app.accounting.ledger.length}, platform revenue ${(revenue / 100).toFixed(2)} EGP, notifications sent: ${app.notifications.sent.length}, dead letters: ${app.bus.deadLetters.length}`);
clearInterval(locTimer);
drivers.forEach((d) => d.ws.close());
await app.close();
process.exit(0);
