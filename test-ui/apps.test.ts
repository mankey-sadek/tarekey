// اختبارات الشاشات: بنفتح تطبيق الزبون وتطبيق الكابتن في متصفح حقيقي (Chromium)
// متوصلين بالسيرفر الحقيقي، ونمشي رحلة كاملة زي ما المستخدم بيعملها بإيده.
// الخرايط والطرق (OSM / OSRM / Nominatim) بنقفلها عشان الاختبار مايعتمدش على النت.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { createApp, type App } from "../src/app.js";

const TAHRIR = { latitude: 30.0444, longitude: 31.2357 };
let app: App, port: number, browser: Browser;

before(async () => {
  app = createApp({});
  port = await app.listen(0);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await app?.close();
});

/** صفحة جديدة بموبايل وهمي واقف في التحرير، وأي خطأ JavaScript بيتسجل */
async function open(path: string) {
  const ctx = await browser.newContext({
    viewport: { width: 400, height: 850 },
    geolocation: TAHRIR,
    permissions: ["geolocation"],
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  await page.goto(`http://localhost:${port}${path}`);
  return { page, errors, close: () => ctx.close() };
}

async function riderLogin(r: Page, phone: string) {
  await r.fill("#rLogin [name=name]", "زبون تست");
  await r.fill("#rLogin [name=phone]", phone);
  await r.click("#rLogin button[type=submit]");
}
async function captainLogin(d: Page, phone: string) {
  await d.fill("#dLogin [name=name]", "كابتن تست");
  await d.fill("#dLogin [name=phone]", phone);
  await d.fill("#dLogin [name=plate]", "أ ب ج ١٢٣");
  await d.click("#dLogin button[type=submit]");
}
/** يختار أول مكان من نتايج البحث (أول عنصر هو «استخدم مكاني الحالي») ويطلب */
async function requestRide(r: Page) {
  await r.locator("#rResults > *").nth(2).click();
  await r.click("#rReq");
}
const riderTitle = (r: Page) => r.locator("#riderSheet h3").first().innerText();

test("كل الصفحات بتفتح من غير أخطاء JavaScript", async () => {
  for (const path of ["/", "/rider", "/captain", "/apps", "/prototype"]) {
    const { page, errors, close } = await open(path);
    await page.waitForTimeout(800);
    assert.deepEqual(errors, [], `أخطاء في ${path}`);
    await close();
  }
});

test("رحلة كاملة: الزبون يطلب، الكابتن يقبل ويوصّل، والزبون يقيّم", { timeout: 60_000 }, async () => {
  const d = await open("/captain");
  const r = await open("/rider");
  await captainLogin(d.page, "01111111111");
  await d.page.click("#dOnline");
  await riderLogin(r.page, "01000000000");
  await requestRide(r.page);

  // الطلب يوصل للكابتن ويقبله
  await d.page.waitForSelector("#dAccept", { timeout: 10_000 });
  await d.page.click("#dAccept");
  await r.page.waitForFunction(() => /الكابتن/.test(document.querySelector("#riderSheet h3")?.textContent ?? ""));

  // الكابتن يدوس وصلت ← ابدأ ← إنهاء (كل زرار بيتفعل لما العربية توصل)
  const seen: string[] = [];
  for (let i = 0; i < 100 && !(await r.page.locator("#rRate").count()); i++) {
    const btn = d.page.locator("#dAct");
    if ((await btn.count()) && (await btn.isEnabled())) {
      seen.push((await btn.innerText()).trim());
      await btn.click();
    }
    await d.page.waitForTimeout(300);
  }
  assert.equal(await riderTitle(r.page), "وصلت بالسلامة 🎉");
  assert.deepEqual(seen.map((s) => s.split(" ")[0]), ["وصلت", "ابدأ", "إنهاء"]);

  // السيرفر حسب للكابتن نصيبه من الأجرة (٨٠٪) والمنصة عمولتها
  await waitUntil(() => app.accounting.balance("driver:d-01111111111") > 0);
  assert.ok(app.accounting.balance("platform:revenue") > 0);

  // التقييم بـ ٥ نجوم ويرجع للشاشة الرئيسية
  await r.page.click('#riderSheet [data-s="5"]');
  await r.page.click("#rRate");
  await r.page.waitForFunction(() => /رايح فين/.test(document.querySelector("#riderSheet h3")?.textContent ?? ""));
  await waitUntil(() => app.ratings.average("d-01111111111") === 5);

  assert.deepEqual([...d.errors, ...r.errors], []);
  await d.close();
  await r.close();
});

test("الزبون يلغي والعرض لسه عند الكابتن، فالعرض يتسحب من الكابتن", { timeout: 30_000 }, async () => {
  const d = await open("/captain");
  const r = await open("/rider");
  await captainLogin(d.page, "01222222222");
  await d.page.click("#dOnline");
  await riderLogin(r.page, "01000000001");
  await requestRide(r.page);
  await d.page.waitForSelector("#dAccept", { timeout: 10_000 });
  await r.page.waitForFunction(() => (document.querySelector("#rCancel") as HTMLButtonElement | null)?.disabled === false);
  await r.page.click("#rCancel");

  await r.page.waitForFunction(() => /اتلغت/.test(document.querySelector("#riderSheet h3")?.textContent ?? ""));
  assert.match(await r.page.locator("#riderSheet").innerText(), /إنت لغيت الرحلة/);
  // الكابتن العرض اختفى عنده ورجع مستني طلبات
  await d.page.waitForSelector("#dOnline", { timeout: 5_000 });
  assert.equal(await d.page.locator("#dAccept").count(), 0);

  await r.page.click("#rAgain");
  assert.equal(await riderTitle(r.page), "رايح فين؟");
  assert.deepEqual([...d.errors, ...r.errors], []);
  await d.close();
  await r.close();
});

test("الكابتن الوحيد يرفض، فالزبون يعرف إن مفيش كباتن", { timeout: 30_000 }, async () => {
  const d = await open("/captain");
  const r = await open("/rider");
  await captainLogin(d.page, "01333333333");
  await d.page.click("#dOnline");
  await riderLogin(r.page, "01000000002");
  await requestRide(r.page);
  await d.page.waitForSelector("#dDecline", { timeout: 10_000 });
  await d.page.click("#dDecline");

  await d.page.waitForSelector("#dOnline");
  assert.match(await d.page.locator("#dOnline").innerText(), /أونلاين/);
  await r.page.waitForFunction(() => /اتلغت/.test(document.querySelector("#riderSheet h3")?.textContent ?? ""));
  assert.match(await r.page.locator("#riderSheet").innerText(), /مفيش كباتن قريبين/);
  assert.deepEqual([...d.errors, ...r.errors], []);
  await d.close();
  await r.close();
});

async function waitUntil(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("waitUntil timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}
