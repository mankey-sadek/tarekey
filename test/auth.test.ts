import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthService, ConsoleSmsSender } from "../src/services/auth/authService.js";
import { createApp } from "../src/app.js";
import { TestClient } from "./ws-client.js";
import WebSocket from "ws";

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}
const codeFrom = (sms: ConsoleSmsSender) => /(\d{6})/.exec(sms.sent.at(-1)!.text)![1];

test("OTP: الكود الصح بيدي توكن، والتوكن بيرجع نفس الشخص", async () => {
  const sms = new ConsoleSmsSender();
  const auth = new AuthService({ sms });
  const r = await auth.requestOtp("01012345678", "rider");
  assert.equal(r.ok, true);
  assert.equal("devCode" in r, false, "الكود مايرجعش في الرد غير لو exposeDevCode");
  const v = auth.verifyOtp("01012345678", "rider", codeFrom(sms));
  assert.ok(v.ok);
  assert.equal(v.id, "r-01012345678");
  assert.deepEqual(auth.verifyToken(v.token), { role: "rider", id: "r-01012345678" });
  // الكود يتستخدم مرة واحدة بس
  assert.deepEqual(auth.verifyOtp("01012345678", "rider", codeFrom(sms)), { ok: false, code: "no_code" });
});

test("OTP: رقم غلط، كود غلط، محاولات كتير، وكود منتهي", async () => {
  const c = clock();
  const sms = new ConsoleSmsSender();
  const auth = new AuthService({ sms, now: c.now, maxAttempts: 3, otpTtlMs: 60_000, resendCooldownMs: 10_000 });
  assert.deepEqual(await auth.requestOtp("12345", "rider"), { ok: false, code: "invalid_phone" });
  assert.deepEqual(await auth.requestOtp("01012345678", "admin"), { ok: false, code: "invalid_role" });

  await auth.requestOtp("01012345678", "driver");
  const good = codeFrom(sms), bad = good === "000000" ? "111111" : "000000";
  // كود الكابتن مايدخلش كزبون
  assert.deepEqual(auth.verifyOtp("01012345678", "rider", good), { ok: false, code: "no_code" });
  assert.equal((auth.verifyOtp("01012345678", "driver", bad) as any).code, "invalid_code");
  assert.equal((auth.verifyOtp("01012345678", "driver", bad) as any).code, "invalid_code");
  assert.equal((auth.verifyOtp("01012345678", "driver", bad) as any).code, "too_many_attempts");
  // حتى الكود الصح بقى مقفول بعد المحاولات
  assert.equal((auth.verifyOtp("01012345678", "driver", good) as any).code, "too_many_attempts");

  // مايقدرش يطلب كود جديد على طول
  const again = await auth.requestOtp("01012345678", "driver");
  assert.equal(again.ok, false);
  assert.equal((again as any).code, "too_soon");
  c.t += 10_001;
  assert.equal((await auth.requestOtp("01012345678", "driver")).ok, true);

  // الكود بيخلص بعد دقيقة
  c.t += 60_001;
  assert.deepEqual(auth.verifyOtp("01012345678", "driver", codeFrom(sms)), { ok: false, code: "expired" });
});

test("التوكن: التلاعب أو سر تاني أو انتهاء الصلاحية = مرفوض", () => {
  const c = clock();
  const auth = new AuthService({ secret: "s1", now: c.now, tokenTtlMs: 60_000 });
  const t = auth.issueToken("driver", "d-01011111111");
  assert.deepEqual(auth.verifyToken(t), { role: "driver", id: "d-01011111111" });

  // نغيّر الـ id جوه التوكن من غير ما نعيد التوقيع
  const [h, , s] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "d-01099999999", role: "driver", exp: 9e9 })).toString("base64url");
  assert.equal(auth.verifyToken(`${h}.${forged}.${s}`), null);
  // alg: none
  const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  assert.equal(auth.verifyToken(`${none}.${t.split(".")[1]}.`), null);
  assert.equal(new AuthService({ secret: "s2", now: c.now }).verifyToken(t), null);
  assert.equal(auth.verifyToken("garbage"), null);
  assert.equal(auth.verifyToken(undefined), null);

  c.t += 61_000;
  assert.equal(auth.verifyToken(t), null);
});

async function post(port: number, path: string, body: object) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
/** بيحاول يتصل ويرجع كود القفل لو اترفض، أو "hello" لو اتقبل */
function tryConnect(url: string): Promise<{ closed?: number; hello?: any }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "hello") (resolve({ hello: m }), ws.close());
    });
    ws.on("close", (code) => resolve({ closed: code }));
  });
}

test("السيرفر: OTP على HTTP، والـ WebSocket مايقبلش غير توكن", async () => {
  const app = createApp({ requireAuth: true, monitorKey: "k", auth: { exposeDevCode: true } });
  const port = await app.listen(0);
  const base = `ws://127.0.0.1:${port}/ws`;
  try {
    const otp = await post(port, "/auth/otp", { phone: "01012345678", role: "rider" });
    assert.equal(otp.status, 200);
    assert.match(otp.body.devCode, /^\d{6}$/);
    assert.equal((await post(port, "/auth/otp", { phone: "01012345678", role: "rider" })).status, 429);
    assert.equal((await post(port, "/auth/verify", { phone: "01012345678", role: "rider", code: "x" })).status, 400);
    const ok = await post(port, "/auth/verify", { phone: "01012345678", role: "rider", code: otp.body.devCode });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.id, "r-01012345678");

    // من غير توكن مرفوض، حتى لو كتب id حد تاني
    assert.equal((await tryConnect(`${base}?role=rider&id=r-01012345678`)).closed, 4001);
    assert.equal((await tryConnect(`${base}?token=bad`)).closed, 4001);
    // التوكن بيحدد الشخص، والـ id اللي في الرابط ملوش لازمة
    const c = await tryConnect(`${base}?token=${ok.body.token}&role=driver&id=d-01099999999`);
    assert.deepEqual([c.hello.role, c.hello.id], ["rider", "r-01012345678"]);

    // لوحة المراقبة: بالمفتاح أو بتوكن
    assert.equal((await tryConnect(`${base}?role=monitor&id=x`)).closed, 4001);
    assert.equal((await tryConnect(`${base}?role=monitor&id=x&key=k`)).hello.role, "monitor");
    assert.equal((await tryConnect(`${base}?role=monitor&token=${ok.body.token}`)).hello.role, "monitor");

    // الزبون المتوثق يقدر يطلب رحلة فعلاً
    const rider = await TestClient.connect(`ws://127.0.0.1:${port}`, "rider", "ignored", ok.body.token);
    const res = await rider.request({ type: "request_trip", pickup: { lat: 30.0444, lng: 31.2357 }, dropoff: { lat: 30.05, lng: 31.24 } });
    assert.equal(res.type, "ack");
    rider.close();
  } finally {
    await app.close();
  }
});
