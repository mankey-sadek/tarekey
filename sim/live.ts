/**
 * npm run dev
 * يشغّل السيرفر + محاكاة مستمرة (سواقين بيتحركوا وزباين بيطلبوا رحلات طول الوقت)،
 * وتفتح http://localhost:8080 تتفرج على العمليات لحظة بلحظة.
 */
import { createApp } from "../src/app.js";
import { TestClient } from "../test/ws-client.js";
import { offsetMeters, sleep } from "../test/helpers.js";
import { haversineMeters, type LatLng } from "../src/shared/geo.js";

const CAIRO = { lat: 30.0444, lng: 31.2357 };
const DRIVERS = Number(process.env.DRIVERS ?? 80);
const PORT = Number(process.env.PORT ?? 8080);
const SPEED = Number(process.env.SPEED ?? 70); // متر/ثانية (المحاكاة متسرّعة)
const AREA = 5000; // نص قطر المنطقة بالمتر

// التوثيق شغال زي الإنتاج، بس كود الـ OTP بيظهر في التطبيق نفسه (مفيش SMS حقيقي هنا)
const app = createApp({
  location: { minUpdateIntervalMs: 0 }, dispatch: { fanout: 3, offerTtlMs: 8000 },
  requireAuth: true, auth: { exposeDevCode: true, secret: process.env.JWT_SECRET },
});
const port = await app.listen(PORT);
console.log(`\n🚗 في طريقك — live simulation`);
console.log(`   Dashboard:  http://localhost:${port}/`);
console.log(`   Apps:       http://localhost:${port}/app        ← شاشات الزبون والكابتن متوصلة بالسيرفر`);
console.log(`   Rider:      http://localhost:${port}/rider      ← تطبيق الزبون لوحده`);
console.log(`   Captain:    http://localhost:${port}/captain    ← تطبيق الكابتن لوحده`);
console.log(`   Prototype:  http://localhost:${port}/prototype  ← نفس الشاشات بمحاكاة داخلية`);
console.log(`   ${DRIVERS} drivers, new ride request every ~2.5s. Ctrl+C to stop.\n`);

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randomPoint = (): LatLng => offsetMeters(CAIRO, rand(-AREA, AREA), rand(-AREA, AREA));
function step(p: LatLng, target: LatLng, meters: number): LatLng {
  const d = haversineMeters(p, target);
  if (d <= meters) return { ...target };
  const t = meters / d;
  return { lat: p.lat + (target.lat - p.lat) * t, lng: p.lng + (target.lng - p.lng) * t };
}

type Phase = "cruise" | "toPickup" | "waiting" | "toDropoff";
interface Driver {
  id: string;
  ws: TestClient;
  pos: LatLng;
  target: LatLng;
  phase: Phase;
  trip?: { id: string; pickup: LatLng; dropoff: LatLng };
}

const drivers: Driver[] = [];
for (let i = 0; i < DRIVERS; i++) {
  const id = `d${String(i).padStart(3, "0")}`;
  const ws = await TestClient.connect(`ws://127.0.0.1:${port}`, "driver", id, app.auth.issueToken("driver", id));
  const d: Driver = { id, ws, pos: randomPoint(), target: randomPoint(), phase: "cruise" };
  ws.ws.on("message", (raw) => onDriverMessage(d, JSON.parse(raw.toString())));
  drivers.push(d);
}

async function onDriverMessage(d: Driver, m: any) {
  if (m.type !== "trip_offer" || d.phase !== "cruise") return;
  const o = m.offer;
  if (Math.random() < 0.12) {
    await sleep(rand(500, 2000));
    d.ws.send({ type: "decline", tripId: o.tripId });
    return;
  }
  // أحياناً كذا سواق بيقبلوا في نفس اللحظة تقريباً → سباق حقيقي على الـ CAS
  await sleep(Math.random() < 0.5 ? rand(0, 30) : rand(300, 3000));
  if (d.phase !== "cruise") return;
  const r = await d.ws.request({ type: "accept", tripId: o.tripId });
  if (r.result?.ok) {
    d.phase = "toPickup";
    d.trip = { id: o.tripId, pickup: o.pickup, dropoff: o.dropoff };
    d.target = o.pickup;
  }
}

async function tripStep(d: Driver, type: string) {
  const r = await d.ws.request({ type, tripId: d.trip!.id });
  if (r.type === "error") {
    d.phase = "cruise";
    d.trip = undefined;
    d.target = randomPoint();
    return false;
  }
  return true;
}

async function arrivedAtPickup(d: Driver) {
  d.phase = "waiting";
  if (!(await tripStep(d, "arrive"))) return;
  await sleep(rand(1500, 4000));
  if (d.phase !== "waiting" || !(await tripStep(d, "start"))) return;
  d.phase = "toDropoff";
  d.target = d.trip!.dropoff;
}

async function arrivedAtDropoff(d: Driver) {
  d.phase = "waiting";
  await tripStep(d, "complete");
  d.phase = "cruise";
  d.trip = undefined;
  d.target = randomPoint();
}

// الحركة + إرسال اللوكيشن كل ثانية (كل سواق بيكمل خطوات رحلته لوحده من غير ما يعطّل الباقيين)
setInterval(() => {
  for (const d of drivers) {
    const speed = d.phase === "cruise" ? SPEED * 0.4 : SPEED;
    if (d.phase !== "waiting") d.pos = step(d.pos, d.target, speed);
    d.ws.send({ type: "location", ...d.pos });
    if (d.phase === "waiting" || haversineMeters(d.pos, d.target) > 1) continue;
    if (d.phase === "cruise") d.target = randomPoint();
    else if (d.phase === "toPickup") void arrivedAtPickup(d);
    else if (d.phase === "toDropoff") void arrivedAtDropoff(d);
  }
}, 1000);

// الزباين: طلب جديد كل ~٢.٥ ثانية
let riderSeq = 0;
async function rider() {
  const id = `r${String(++riderSeq).padStart(4, "0")}`;
  const c = await TestClient.connect(`ws://127.0.0.1:${port}`, "rider", id, app.auth.issueToken("rider", id));
  const pickup = offsetMeters(CAIRO, rand(-AREA * 0.8, AREA * 0.8), rand(-AREA * 0.8, AREA * 0.8));
  const dropoff = offsetMeters(pickup, rand(-2500, 2500), rand(-2500, 2500));
  const types = ["eco", "eco", "eco", "comfort", "xl"];
  const r = await c.request({ type: "request_trip", pickup, dropoff, rideType: types[Math.floor(Math.random() * types.length)] });
  const tripId = r.trip?.id;
  if (!tripId) return c.close();
  // ٧٪ من الزباين بيلغوا وهما مستنيين
  if (Math.random() < 0.07) {
    await sleep(rand(2000, 6000));
    await c.request({ type: "cancel", tripId });
  }
  try {
    const end = await c.waitFor((m) => m.type === "trip_update" && ["completed", "cancelled"].includes(m.trip.status), 600_000);
    if (end.trip.status === "completed") {
      await sleep(rand(500, 3000));
      await c.request({ type: "rate", tripId, stars: Math.random() < 0.8 ? 5 : Math.random() < 0.7 ? 4 : 3 });
    }
  } catch {
    /* timeout */
  }
  c.close();
}
setInterval(() => void rider().catch(() => {}), 2500);
void rider();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    drivers.forEach((d) => d.ws.close());
    await app.close();
    process.exit(0);
  });
}
