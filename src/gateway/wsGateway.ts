import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { isValidLatLng } from "../shared/geo.js";
import {
  Topics,
  type OfferCreatedEvent,
  type OfferWithdrawnEvent,
  type TripStatusChangedEvent,
} from "../shared/contracts.js";
import type { MessageQueue } from "../shared/messageBus.js";
import type { LocationService } from "../services/location/locationService.js";
import type { DispatchService } from "../services/dispatch/dispatchService.js";
import { TripError, type RideType, type TripService } from "../services/trip/tripService.js";
import type { NotificationService } from "../services/notification/notificationService.js";
import type { AuthService } from "../services/auth/authService.js";

type Role = "driver" | "rider" | "monitor";
interface Client {
  ws: WebSocket;
  role: Role;
  id: string;
  alive: boolean;
}

export interface GatewayDeps {
  bus: MessageQueue;
  location: LocationService;
  dispatch: DispatchService;
  trips: TripService;
  notifications: NotificationService;
  /** اسم النسخة — كل نسخة gateway بتشترك في الطابور بـ group خاص بيها */
  instanceId?: string;
  /** أرقام إضافية تتبعت للوحة المراقبة كل ثانية */
  monitorStats?: () => object;
  /** بيتأكد من التوكنات (?token=…) */
  auth?: AuthService;
  /** لو true: الزبون والكابتن لازم توكن، و ?role&id لوحدهم مرفوضين */
  requireAuth?: boolean;
  /** لو متحدد: لوحة المراقبة لازم ?key=… أو توكن صالح. لو مش متحدد: المراقبة مفتوحة */
  monitorKey?: string;
}

/**
 * WebSocket Gateway — القناة المفتوحة بين الأبلكيشن والسيرفر.
 *
 *   ws://host/ws?token=<JWT>              (الـ role والـ id بيطلعوا من التوكن — شوف AuthService)
 *   ws://host/ws?role=driver&id=d_123     (للتجربة بس، لما requireAuth = false)
 *
 * Driver → server:  location | accept | decline | arrive | start | complete | cancel
 * Rider  → server:  request_trip | cancel | rate
 * Server → client:  hello | trip_offer | offer_withdrawn | trip_update | notification | earning | ack | error
 *
 * الـ gateway مابيعملش أي business logic: بيترجم الرسايل لنداءات على الخدمات،
 * وبيسمع أحداث الطابور ويبعتها للي متصل عنده بس. ده بيخليه stateless ويتعمله scale أفقي.
 */
export class WsGateway {
  readonly wss: WebSocketServer;
  private readonly clients = new Map<string, Client>(); // `${role}:${id}` -> client
  private heartbeat?: NodeJS.Timeout;
  private snapshotTimer?: NodeJS.Timeout;
  private readonly monitors = new Set<WebSocket>();
  /** آخر حالة لكل رحلة شغالة — عشان لوحة المراقبة لما تفتح تلاقي الصورة كاملة */
  private readonly activeTrips = new Map<string, unknown>();
  private lastSearchSent = 0;
  private lastLocCount = 0;
  stats = { messagesIn: 0, locationUpdates: 0 };
  /** بيانات العرض (اسم الزبون، عربية الكابتن، أسماء الأماكن) — مش جزء من منطق الرحلة */
  private readonly profiles = new Map<string, { name: string; car?: string; plate?: string }>();
  private readonly tripLabels = new Map<string, { pickupName?: string; dropoffName?: string }>();

  constructor(private readonly deps: GatewayDeps) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => this.onConnection(ws, req));
    this.subscribe();
    this.heartbeat = setInterval(() => this.ping(), 15_000);
    this.heartbeat.unref?.();
    this.snapshotTimer = setInterval(() => this.broadcastSnapshot(), 1000);
    this.snapshotTimer.unref?.();
  }

  get connections() {
    return this.clients.size;
  }

  send(role: Role, id: string, msg: unknown): boolean {
    const c = this.clients.get(`${role}:${id}`);
    if (!c || c.ws.readyState !== WebSocket.OPEN) return false;
    c.ws.send(JSON.stringify(msg));
    return true;
  }

  close() {
    clearInterval(this.heartbeat);
    clearInterval(this.snapshotTimer);
    for (const m of this.monitors) m.terminate();
    for (const c of this.clients.values()) c.ws.terminate();
    this.wss.close();
  }

  private subscribe() {
    const { bus, notifications } = this.deps;
    const group = `gateway:${this.deps.instanceId ?? "1"}`;
    bus.subscribe<OfferCreatedEvent>(Topics.OfferCreated, group, (m) => {
      const o = m.payload;
      this.send("driver", o.driverId, {
        type: "trip_offer",
        offer: { ...o, riderName: this.profiles.get(`rider:${o.riderId}`)?.name, ...this.tripLabels.get(o.tripId) },
      });
    });
    bus.subscribe<OfferWithdrawnEvent>(Topics.OfferWithdrawn, group, (m) => {
      for (const id of m.payload.driverIds) {
        this.send("driver", id, { type: "offer_withdrawn", tripId: m.payload.tripId, reason: m.payload.reason });
      }
    });
    bus.subscribe<TripStatusChangedEvent>(Topics.TripStatusChanged, group, (m) => {
      const { trip } = m.payload;
      if (trip.status === "completed" || trip.status === "cancelled") this.activeTrips.delete(trip.id);
      else this.activeTrips.set(trip.id, trip);
      const driver = trip.driverId ? this.deps.location.getLocation(trip.driverId) : undefined;
      const msg = {
        type: "trip_update",
        trip,
        driverLocation: driver ? { lat: driver.lat, lng: driver.lng } : null,
        driverProfile: trip.driverId ? this.profiles.get(`driver:${trip.driverId}`) ?? null : null,
        riderName: this.profiles.get(`rider:${trip.riderId}`)?.name ?? null,
        ...this.tripLabels.get(trip.id),
      };
      if (trip.status === "completed" || trip.status === "cancelled") this.tripLabels.delete(trip.id);
      this.send("rider", trip.riderId, msg);
      if (trip.driverId) this.send("driver", trip.driverId, msg);
    });
    // لوحة المراقبة: كل أحداث الطابور بتتبعتلها
    for (const topic of Object.values(Topics)) {
      bus.subscribe(topic, `${group}:monitor`, (m) => {
        if (this.monitors.size) this.broadcast({ type: "event", topic, payload: m.payload, at: Date.now() });
      });
    }
    notifications.addSink((n) => {
      const msg = { type: "notification", title: n.title, body: n.body };
      this.send("rider", n.userId, msg) || this.send("driver", n.userId, msg);
    });
  }

  /** مين اللي بيتصل؟ من التوكن لو موجود، أو من ?role&id لو السيرفر مش طالب توثيق */
  private identify(url: URL): { role: Role; id: string } | { error: string } {
    const token = url.searchParams.get("token");
    const askedRole = url.searchParams.get("role");
    if (token) {
      const claims = this.deps.auth?.verifyToken(token);
      if (!claims) return { error: "invalid or expired token" };
      // توكن الزبون/الكابتن يفتح كمان قناة مراقبة (عشان يشوف العربيات على الخريطة)
      return askedRole === "monitor" ? { role: "monitor", id: claims.id } : claims;
    }
    const id = url.searchParams.get("id") ?? "";
    if (askedRole === "monitor") {
      const { monitorKey } = this.deps;
      if (monitorKey && url.searchParams.get("key") !== monitorKey) return { error: "monitor key required" };
      return { role: "monitor", id: /^[\w-]{1,64}$/.test(id) ? id : "monitor" };
    }
    if (this.deps.requireAuth) return { error: "token required" };
    if ((askedRole !== "driver" && askedRole !== "rider") || !/^[\w-]{1,64}$/.test(id)) return { error: "role and id are required" };
    return { role: askedRole, id };
  }

  private onConnection(ws: WebSocket, req: IncomingMessage) {
    const who = this.identify(new URL(req.url ?? "/", "http://localhost"));
    if ("error" in who) {
      ws.close(4001, who.error);
      return;
    }
    const { role, id } = who;
    if (role === "monitor") {
      this.monitors.add(ws);
      ws.on("close", () => this.monitors.delete(ws));
      ws.send(JSON.stringify({ type: "hello", role, id, activeTrips: [...this.activeTrips.values()] }));
      this.broadcastSnapshot();
      return;
    }
    const key = `${role}:${id}`;
    this.clients.get(key)?.ws.close(4002, "replaced by a new connection");
    const client: Client = { ws, role, id, alive: true };
    this.clients.set(key, client);

    ws.on("pong", () => (client.alive = true));
    ws.on("message", (raw) => this.onMessage(client, raw.toString()));
    ws.on("close", () => {
      if (this.clients.get(key) !== client) return;
      this.clients.delete(key);
      if (role === "driver") this.deps.location.driverOffline(id);
    });
    ws.send(JSON.stringify({ type: "hello", role, id }));
  }

  private setProfile(c: Client, msg: any) {
    const clean = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 40) : undefined);
    const name = clean(msg.name);
    if (!name) throw new TripError("bad_request", "name is required");
    this.profiles.set(`${c.role}:${c.id}`, { name, car: clean(msg.car), plate: clean(msg.plate) });
    return {};
  }

  private async onMessage(c: Client, raw: string) {
    this.stats.messagesIn++;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.reply(c, undefined, { type: "error", code: "bad_json" });
    }
    const reqId = msg?.reqId;
    try {
      const result =
        msg?.type === "profile"
          ? this.setProfile(c, msg)
          : c.role === "driver"
            ? await this.driverMessage(c.id, msg)
            : await this.riderMessage(c.id, msg);
      if (result !== undefined) this.reply(c, reqId, { type: "ack", of: msg.type, ...result });
    } catch (err) {
      const code = err instanceof TripError ? err.code : "internal";
      const message = err instanceof Error ? err.message : String(err);
      this.reply(c, reqId, { type: "error", of: msg?.type, code, message });
    }
  }

  private async driverMessage(driverId: string, msg: any): Promise<object | undefined> {
    const { location, dispatch, trips } = this.deps;
    switch (msg.type) {
      case "location": {
        // الـ hot path: مفيش رد عشان نوفر باندويدث
        if (!isValidLatLng(msg)) throw new TripError("bad_request", "invalid lat/lng");
        location.updateLocation(driverId, { lat: msg.lat, lng: msg.lng });
        this.stats.locationUpdates++;
        return undefined;
      }
      case "accept":
        return { result: await dispatch.accept(String(msg.tripId), driverId) };
      case "decline":
        await dispatch.decline(String(msg.tripId), driverId);
        return {};
      case "arrive":
        return { trip: await trips.arrive(String(msg.tripId), driverId) };
      case "start":
        return { trip: await trips.start(String(msg.tripId), driverId) };
      case "complete":
        return { trip: await trips.complete(String(msg.tripId), driverId) };
      case "cancel":
        return { trip: await trips.cancel(String(msg.tripId), "driver", driverId) };
      default:
        throw new TripError("bad_request", `unknown message type ${msg.type}`);
    }
  }

  private async riderMessage(riderId: string, msg: any): Promise<object | undefined> {
    const { trips } = this.deps;
    switch (msg.type) {
      case "request_trip": {
        if (!isValidLatLng(msg.pickup) || !isValidLatLng(msg.dropoff)) {
          throw new TripError("bad_request", "pickup and dropoff must be {lat,lng}");
        }
        const trip = await trips.requestTrip(riderId, msg.pickup, msg.dropoff, (msg.rideType ?? "eco") as RideType);
        const label = (v: unknown) => (typeof v === "string" ? v.slice(0, 60) : undefined);
        this.tripLabels.set(trip.id, { pickupName: label(msg.pickupName), dropoffName: label(msg.dropoffName) });
        return { trip };
      }
      case "cancel":
        return { trip: await trips.cancel(String(msg.tripId), "rider", riderId) };
      case "rate":
        await trips.rate(String(msg.tripId), riderId, Number(msg.stars), msg.comment);
        return {};
      default:
        throw new TripError("bad_request", `unknown message type ${msg.type}`);
    }
  }

  private broadcast(msg: object) {
    const data = JSON.stringify(msg);
    for (const m of this.monitors) if (m.readyState === WebSocket.OPEN) m.send(data);
  }

  /** صورة كل ثانية: مكان وحالة كل سواق + آخر بحث H3 + أرقام */
  private broadcastSnapshot() {
    if (!this.monitors.size) return;
    const { location } = this.deps;
    const drivers = [];
    for (const d of location.store.all()) drivers.push([d.driverId, +d.lat.toFixed(6), +d.lng.toFixed(6), d.status === "busy" ? 1 : 0]);
    const ls = location.store.lastSearch;
    const search = ls && ls.seq !== this.lastSearchSent ? ls : null;
    if (ls) this.lastSearchSent = ls.seq;
    const locPerSec = this.stats.locationUpdates - this.lastLocCount;
    this.lastLocCount = this.stats.locationUpdates;
    this.broadcast({
      type: "snapshot",
      at: Date.now(),
      drivers,
      search,
      stats: {
        wsConnections: this.clients.size,
        locationUpdatesPerSec: locPerSec,
        openOffers: this.deps.dispatch.openOffers,
        ...this.deps.monitorStats?.(),
      },
    });
  }

  private reply(c: Client, reqId: unknown, msg: object) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(reqId !== undefined ? { ...msg, reqId } : msg));
  }

  private ping() {
    for (const [key, c] of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        this.clients.delete(key);
        if (c.role === "driver") this.deps.location.driverOffline(c.id);
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }
}
