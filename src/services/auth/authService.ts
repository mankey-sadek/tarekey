import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Auth Service: تسجيل الدخول برقم الموبايل + كود تحقق (OTP)، وبعدها توكن JWT موقّع.
 *
 *   1. POST /auth/otp     {phone, role}        → بنبعت كود من ٦ أرقام في SMS
 *   2. POST /auth/verify  {phone, role, code}  → لو الكود صح بنرجع {token, id}
 *   3. ws://host/ws?token=…                    → الـ gateway بيطلّع الـ role والـ id من التوكن نفسه
 *
 * كده محدش يقدر يدخل بـ id حد تاني، لأن التوكن متوقّع بسر السيرفر (HS256) ومالوش لازمة من غير الكود.
 * الكود نفسه مش متخزن: متخزن الـ HMAC بتاعه بس، وليه مدة صلاحية وعدد محاولات محدود.
 */
export type AuthRole = "rider" | "driver";
export interface AuthClaims { role: AuthRole; id: string }

/** مزود الرسايل. في الإنتاج يتبدل بـ Twilio / Vonage / مزود مصري */
export interface SmsSender {
  send(phone: string, text: string): Promise<void>;
}
/** بديل مؤقت لمزود SMS: بيحتفظ بالرسايل، ولو اديته log بيطبعها (عشان تقدر تجرب npm start من غير مزود) */
export class ConsoleSmsSender implements SmsSender {
  readonly sent: Array<{ phone: string; text: string }> = [];
  constructor(private readonly log?: (line: string) => void) {}
  async send(phone: string, text: string) {
    this.sent.push({ phone, text });
    this.log?.(`📩 SMS → ${phone}: ${text}`);
  }
}

export interface AuthOptions {
  /** سر توقيع التوكنات. لو مش موجود بيتعمل واحد عشوائي (التوكنات بتبطل لما السيرفر يعيد التشغيل) */
  secret?: string;
  sms?: SmsSender;
  /** نرجّع الكود في الرد (للتجربة من غير SMS حقيقي). لازم يبقى false في الإنتاج */
  exposeDevCode?: boolean;
  otpTtlMs?: number;
  tokenTtlMs?: number;
  maxAttempts?: number;
  resendCooldownMs?: number;
  now?: () => number;
}

export type OtpResult =
  | { ok: true; expiresInMs: number; devCode?: string }
  | { ok: false; code: "invalid_phone" | "invalid_role" | "too_soon"; retryInMs?: number };
export type VerifyResult =
  | { ok: true; token: string; id: string; role: AuthRole; expiresAt: number }
  | { ok: false; code: "invalid_phone" | "invalid_role" | "no_code" | "expired" | "invalid_code" | "too_many_attempts" };

const PHONE = /^01\d{9}$/;
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const isRole = (r: unknown): r is AuthRole => r === "rider" || r === "driver";

export class AuthService {
  private readonly secret: Buffer;
  private readonly sms: SmsSender;
  private readonly now: () => number;
  private readonly otpTtl: number;
  private readonly tokenTtl: number;
  private readonly maxAttempts: number;
  private readonly cooldown: number;
  readonly exposeDevCode: boolean;
  /** `${role}:${phone}` → الكود المستني */
  private readonly pending = new Map<string, { hash: Buffer; expiresAt: number; sentAt: number; attempts: number }>();

  constructor(opts: AuthOptions = {}) {
    this.secret = opts.secret ? Buffer.from(opts.secret) : randomBytes(32);
    this.sms = opts.sms ?? new ConsoleSmsSender();
    this.now = opts.now ?? Date.now;
    this.otpTtl = opts.otpTtlMs ?? 5 * 60_000;
    this.tokenTtl = opts.tokenTtlMs ?? 30 * 24 * 3600_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.cooldown = opts.resendCooldownMs ?? 30_000;
    this.exposeDevCode = opts.exposeDevCode ?? false;
  }

  /** الـ id اللي التطبيق بيستخدمه لكل رقم: r-01xxxxxxxxx أو d-01xxxxxxxxx */
  static idFor(role: AuthRole, phone: string) {
    return `${role === "rider" ? "r" : "d"}-${phone}`;
  }

  async requestOtp(phone: unknown, role: unknown): Promise<OtpResult> {
    if (typeof phone !== "string" || !PHONE.test(phone)) return { ok: false, code: "invalid_phone" };
    if (!isRole(role)) return { ok: false, code: "invalid_role" };
    const key = `${role}:${phone}`, now = this.now();
    const prev = this.pending.get(key);
    if (prev && now - prev.sentAt < this.cooldown) return { ok: false, code: "too_soon", retryInMs: this.cooldown - (now - prev.sentAt) };

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.pending.set(key, { hash: this.hmac(`otp:${key}:${code}`), expiresAt: now + this.otpTtl, sentAt: now, attempts: 0 });
    await this.sms.send(phone, `كود الدخول لـ «في طريقك»: ${code}`);
    return { ok: true, expiresInMs: this.otpTtl, ...(this.exposeDevCode ? { devCode: code } : {}) };
  }

  verifyOtp(phone: unknown, role: unknown, code: unknown): VerifyResult {
    if (typeof phone !== "string" || !PHONE.test(phone)) return { ok: false, code: "invalid_phone" };
    if (!isRole(role)) return { ok: false, code: "invalid_role" };
    const key = `${role}:${phone}`, p = this.pending.get(key), now = this.now();
    if (!p) return { ok: false, code: "no_code" };
    if (now > p.expiresAt) return this.pending.delete(key), { ok: false, code: "expired" };
    if (p.attempts >= this.maxAttempts) return { ok: false, code: "too_many_attempts" };
    p.attempts++;
    const given = this.hmac(`otp:${key}:${typeof code === "string" ? code.trim() : ""}`);
    if (!timingSafeEqual(given, p.hash)) return { ok: false, code: p.attempts >= this.maxAttempts ? "too_many_attempts" : "invalid_code" };
    this.pending.delete(key); // الكود يتستخدم مرة واحدة بس
    const id = AuthService.idFor(role, phone);
    const expiresAt = now + this.tokenTtl;
    return { ok: true, token: this.issueToken(role, id, expiresAt), id, role, expiresAt };
  }

  /** بيطلع توكن مباشرة (للسيميوليتر والاختبارات؛ التطبيقات بتعدي على الـ OTP) */
  issueToken(role: AuthRole, id: string, expiresAt = this.now() + this.tokenTtl): string {
    const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64url(JSON.stringify({ sub: id, role, iat: Math.floor(this.now() / 1000), exp: Math.floor(expiresAt / 1000) }));
    return `${head}.${body}.${b64url(this.hmac(`${head}.${body}`))}`;
  }

  /** بيرجع صاحب التوكن، أو null لو التوقيع غلط أو التوكن خلص */
  verifyToken(token: unknown): AuthClaims | null {
    if (typeof token !== "string" || token.length > 2048) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [head, body, sig] = parts;
    const expected = this.hmac(`${head}.${body}`);
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const h = JSON.parse(Buffer.from(head, "base64url").toString());
      const c = JSON.parse(Buffer.from(body, "base64url").toString());
      if (h.alg !== "HS256" || !isRole(c.role) || typeof c.sub !== "string" || !/^[\w-]{1,64}$/.test(c.sub)) return null;
      if (typeof c.exp !== "number" || c.exp * 1000 <= this.now()) return null;
      return { role: c.role, id: c.sub };
    } catch {
      return null;
    }
  }

  private hmac(s: string) {
    return createHmac("sha256", this.secret).update(s).digest();
  }
}
