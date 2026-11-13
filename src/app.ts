import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { InMemoryMessageQueue } from "./shared/messageBus.js";
import { LocationService } from "./services/location/locationService.js";
import { DispatchService, type DispatchOptions } from "./services/dispatch/dispatchService.js";
import { InMemoryTripRepository, type TripRepository } from "./services/trip/tripRepository.js";
import { TripService } from "./services/trip/tripService.js";
import { FakePaymentGateway, PaymentService, type PaymentGateway } from "./services/payment/paymentService.js";
import { AccountingService } from "./services/accounting/accountingService.js";
import { RatingService } from "./services/rating/ratingService.js";
import { NotificationService } from "./services/notification/notificationService.js";
import { WsGateway } from "./gateway/wsGateway.js";

export interface AppOptions {
  dispatch?: DispatchOptions;
  tripRepo?: TripRepository;
  paymentGateway?: PaymentGateway;
  location?: ConstructorParameters<typeof LocationService>[0];
  log?: (line: string) => void;
}

/**
 * بيجمّع كل الخدمات. كل خدمة هنا ممكن تتشال وتشتغل في process لوحدها:
 * التواصل بينهم إما عبر الطابور (async) أو عبر interface صغير (sync) يتبدل بـ gRPC/HTTP.
 */
export function createApp(opts: AppOptions = {}) {
  const bus = new InMemoryMessageQueue({ logger: opts.log, baseBackoffMs: 20 });
  const location = new LocationService({ minUpdateIntervalMs: 500, ...opts.location });
  const trips = new TripService(opts.tripRepo ?? new InMemoryTripRepository(), bus);
  const dispatch = new DispatchService(bus, location, trips, opts.dispatch).start();
  const notifications = new NotificationService(bus).start();
  const payments = new PaymentService(bus, opts.paymentGateway ?? new FakePaymentGateway()).start();
  const ratings = new RatingService(bus).start();
  const gateway = new WsGateway({
    bus, location, dispatch, trips, notifications,
    monitorStats: () => ({
      platformRevenueCents: accounting.balance("platform:revenue"),
      ledgerEntries: accounting.ledger.length,
      notificationsSent: notifications.sent.length,
      deadLetters: bus.deadLetters.length,
    }),
  });
  const accounting = new AccountingService(bus, 0.2, (driverId, tripId, amountCents) =>
    gateway.send("driver", driverId, { type: "earning", tripId, amountCents }),
  ).start();

  const dist = (f: string) => new URL(`../ui/dist/${f}`, import.meta.url);
  const uiFile = dist("fi-tari2ak.html");
  const dashboardFile = new URL("../ui/dashboard.html", import.meta.url);
  const h3File = new URL("../node_modules/h3-js/dist/h3-js.umd.js", import.meta.url);
  const evictTimer = setInterval(() => location.store.evictStale(), 10_000);
  evictTimer.unref();

  const http: Server = createServer((req, res) => {
    if (req.url === "/health") return void res.end("ok");
    if (req.url === "/stats") {
      res.setHeader("content-type", "application/json");
      return void res.end(
        JSON.stringify({
          onlineDrivers: location.onlineDrivers,
          wsConnections: gateway.connections,
          openOffers: dispatch.openOffers,
          locationUpdates: location.stats,
          deadLetters: bus.deadLetters.length,
        }),
      );
    }
    const files: Record<string, [URL, string]> = {
      "/": [dashboardFile, "text/html; charset=utf-8"],
      "/dashboard": [dashboardFile, "text/html; charset=utf-8"],
      "/prototype": [uiFile, "text/html; charset=utf-8"],
      "/app": [uiFile, "text/html; charset=utf-8"],
      "/vendor/h3.js": [h3File, "text/javascript; charset=utf-8"],
      // التطبيقين المنفصلين (متوصلين بالسيرفر ده) + ملفات التثبيت على الموبايل
      "/rider": [dist("rider.html"), "text/html; charset=utf-8"],
      "/captain": [dist("captain.html"), "text/html; charset=utf-8"],
      "/apps": [dist("index.html"), "text/html; charset=utf-8"],
    };
    const STATIC: Record<string, string> = {
      ".html": "text/html; charset=utf-8", ".webmanifest": "application/manifest+json",
      ".png": "image/png", ".js": "text/javascript; charset=utf-8",
    };
    const path = (req.url ?? "").split("?")[0];
    const m = /^\/(rider\.html|captain\.html|rider\.webmanifest|captain\.webmanifest|sw\.js|[a-z0-9-]+\.png)$/.exec(path);
    if (m) files[path] = [dist(m[1]), STATIC[m[1].slice(m[1].lastIndexOf("."))]];
    const f = files[path];
    if (f && existsSync(f[0])) {
      res.setHeader("content-type", f[1]);
      return void res.end(readFileSync(f[0]));
    }
    res.statusCode = 404;
    res.end("not found");
  });
  http.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws")) return void socket.destroy();
    gateway.wss.handleUpgrade(req, socket, head, (ws) => gateway.wss.emit("connection", ws, req));
  });

  return {
    bus, location, trips, dispatch, notifications, payments, ratings, accounting, gateway, http,
    /** لو البورت مشغول بيجرب اللي بعده (لحد ١٠ محاولات) */
    listen(port = 0): Promise<number> {
      return new Promise((resolve, reject) => {
        let tries = 0;
        const attempt = (p: number) => {
          http.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE" && port !== 0 && ++tries < 10) attempt(p + 1);
            else reject(err);
          });
          http.listen(p, () => resolve((http.address() as { port: number }).port));
        };
        attempt(port);
      });
    },
    async close() {
      clearInterval(evictTimer);
      dispatch.stop();
      gateway.close();
      await new Promise((r) => http.close(r));
    },
  };
}
export type App = ReturnType<typeof createApp>;
