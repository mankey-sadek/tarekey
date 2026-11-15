import { randomBytes } from "node:crypto";
import { createApp } from "./app.js";
import { ConsoleSmsSender } from "./services/auth/authService.js";

const port = Number(process.env.PORT ?? 8080);
const production = process.env.NODE_ENV === "production";
if (!process.env.JWT_SECRET) console.warn("⚠️  JWT_SECRET مش متحدد: هستخدم سر عشوائي، وكل التوكنات هتبطل لما السيرفر يعيد التشغيل.");
const monitorKey = process.env.MONITOR_KEY ?? randomBytes(12).toString("base64url");

const app = createApp({
  log: (l) => console.log(l),
  requireAuth: process.env.AUTH !== "off",
  monitorKey,
  auth: {
    secret: process.env.JWT_SECRET,
    // لحد ما يتوصل مزود SMS حقيقي: الكود بيتطبع في اللوج، وبيرجع في الرد برّه الإنتاج
    sms: new ConsoleSmsSender((l) => console.log(l)),
    exposeDevCode: !production,
  },
});
app.listen(port).then((p) => {
  console.log(`🚗 في طريقك — server on http://localhost:${p}  (WebSocket: ws://localhost:${p}/ws?token=...)`);
  console.log(`   Dashboard: http://localhost:${p}/?key=${monitorKey}`);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => app.close().then(() => process.exit(0)));
