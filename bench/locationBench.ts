/**
 * اختبار حمل: ٥٠٠٠ سواق متصلين، كل واحد بيبعت لوكيشن كل ٣ ثواني،
 * وفي نفس الوقت طلبات رحلات بتدور على أقرب سواق.
 *
 *   npm run bench            ← على الـ Location Service مباشرة (الـ hot path)
 *   npm run bench -- --ws    ← عبر WebSocket حقيقي (٥٠٠٠ اتصال)
 */
import { LocationService } from "../src/services/location/locationService.js";
import { createApp } from "../src/app.js";
import WebSocket from "ws";

const DRIVERS = 5000;
const CAIRO = { lat: 30.0444, lng: 31.2357 };
const rnd = () => ({ lat: CAIRO.lat + (Math.random() - 0.5) * 0.3, lng: CAIRO.lng + (Math.random() - 0.5) * 0.3 });
const pct = (a: number[], p: number) => a.sort((x, y) => x - y)[Math.floor(a.length * p)];

function inMemory() {
  const svc = new LocationService();
  const pos = Array.from({ length: DRIVERS }, rnd);
  for (let i = 0; i < DRIVERS; i++) svc.updateLocation(`d${i}`, pos[i]);

  const UPDATES = 1_000_000;
  let t = performance.now();
  for (let i = 0; i < UPDATES; i++) {
    const k = i % DRIVERS;
    pos[k] = { lat: pos[k].lat + (Math.random() - 0.5) * 1e-4, lng: pos[k].lng + (Math.random() - 0.5) * 1e-4 };
    svc.updateLocation(`d${k}`, pos[k]);
  }
  const upMs = performance.now() - t;

  const lat: number[] = [];
  for (let i = 0; i < 10_000; i++) {
    t = performance.now();
    svc.findNearest(rnd(), 3, 5000);
    lat.push(performance.now() - t);
  }
  const mem = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`\n📍 Location Service in-memory — ${DRIVERS} drivers`);
  console.log(`  updates:  ${Math.round(UPDATES / (upMs / 1000)).toLocaleString()} /s  (المطلوب ≈ ${Math.round(DRIVERS / 3).toLocaleString()} /s)`);
  console.log(`  nearest:  p50 ${pct(lat, 0.5).toFixed(3)}ms · p99 ${pct(lat, 0.99).toFixed(3)}ms`);
  console.log(`  heap:     ${mem.toFixed(0)} MB`);
}

async function overWebSocket() {
  const app = createApp({ location: { minUpdateIntervalMs: 0 } });
  const port = await app.listen(0);
  const url = `ws://127.0.0.1:${port}/ws?role=driver&id=`;
  console.log(`\n🔌 WebSocket — opening ${DRIVERS} driver connections…`);
  const sockets: WebSocket[] = [];
  for (let i = 0; i < DRIVERS; i += 250) {
    await Promise.all(
      Array.from({ length: Math.min(250, DRIVERS - i) }, (_, j) => new Promise<void>((res, rej) => {
        const ws = new WebSocket(url + `d${i + j}`);
        ws.once("message", () => res());
        ws.once("error", rej);
        sockets.push(ws);
      })),
    );
  }
  console.log(`  connected: ${app.gateway.connections}`);
  const seconds = 6;
  const start = app.gateway.stats.locationUpdates;
  const t0 = Date.now();
  // كل سواق يبعت كل ٣ ثواني، متوزعين على الوقت
  const timers = sockets.map((ws, i) => {
    const send = () => ws.readyState === 1 && ws.send(JSON.stringify({ type: "location", ...rnd() }));
    const t = setTimeout(() => { send(); (timers as any)[i] = setInterval(send, 3000); }, Math.random() * 3000);
    return t;
  });
  const lat: number[] = [];
  const searcher = setInterval(() => {
    const t = performance.now();
    app.location.findNearest(rnd(), 3, 5000);
    lat.push(performance.now() - t);
  }, 10);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  clearInterval(searcher);
  timers.forEach((t) => { clearTimeout(t as any); clearInterval(t as any); });
  const got = app.gateway.stats.locationUpdates - start;
  console.log(`  location msgs: ${got.toLocaleString()} in ${((Date.now() - t0) / 1000).toFixed(1)}s ≈ ${Math.round(got / seconds).toLocaleString()} /s`);
  console.log(`  online in H3 index: ${app.location.onlineDrivers}`);
  console.log(`  nearest during load: p50 ${pct(lat, 0.5).toFixed(3)}ms · p99 ${pct(lat, 0.99).toFixed(3)}ms`);
  console.log(`  heap: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB`);
  sockets.forEach((s) => s.terminate());
  await app.close();
}

inMemory();
if (process.argv.includes("--ws")) await overWebSocket();
