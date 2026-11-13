import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const app = createApp({ log: (l) => console.log(l) });
app.listen(port).then((p) => {
  console.log(`🚗 في طريقك — server on http://localhost:${p}  (WebSocket: ws://localhost:${p}/ws?role=driver&id=...)`);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => app.close().then(() => process.exit(0)));
