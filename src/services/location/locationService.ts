import type { LatLng } from "../../shared/geo.js";
import { DriverLocationStore, type NearbyDriver } from "./driverLocationStore.js";

export interface LocationServiceOptions {
  /** أقل فترة بين تحديثين لنفس السواق — بيحمي السيرفر لو أبلكيشن بعت بسرعة زيادة */
  minUpdateIntervalMs?: number;
  resolution?: number;
  staleAfterMs?: number;
  now?: () => number;
}

/**
 * Location Service — خدمة تتبع الأماكن.
 * مسؤولة عن: استقبال لوكيشن السواقين (من الـ WebSocket gateway)، تخزينها في الميموري
 * مفهرسة بـ H3، والرد على "مين أقرب سواق متاح؟"، وحالة السواق (متاح/مشغول).
 *
 * ده الـ hot path: مفيش I/O ولا قاعدة بيانات، كله O(1) في الميموري.
 * مع 5,000 سواق بيبعتوا كل 3 ثواني ≈ 1,700 تحديث/ثانية — ده رقم صغير جداً لـ Map في الميموري
 * (شوف bench/locationBench.ts).
 */
export class LocationService {
  readonly store: DriverLocationStore;
  private readonly minInterval: number;
  private readonly now: () => number;
  private readonly lastAccepted = new Map<string, number>();
  stats = { accepted: 0, throttled: 0 };

  constructor(opts: LocationServiceOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.minInterval = opts.minUpdateIntervalMs ?? 0;
    this.store = new DriverLocationStore({
      resolution: opts.resolution,
      staleAfterMs: opts.staleAfterMs,
      now: this.now,
    });
  }

  /** @returns false لو التحديث اتجاهل بسبب الـ throttling */
  updateLocation(driverId: string, pos: LatLng): boolean {
    const t = this.now();
    const last = this.lastAccepted.get(driverId);
    if (this.minInterval > 0 && last !== undefined && t - last < this.minInterval) {
      this.stats.throttled++;
      return false;
    }
    this.lastAccepted.set(driverId, t);
    this.store.upsert(driverId, pos);
    this.stats.accepted++;
    return true;
  }

  driverOffline(driverId: string): void {
    this.lastAccepted.delete(driverId);
    // لو السواق في رحلة مانشيلوش (ممكن النت فصل لحظة)؛ الـ stale eviction هيتعامل
    if (this.store.get(driverId)?.status !== "busy") this.store.remove(driverId);
  }

  findNearest(origin: LatLng, limit: number, maxDistanceMeters: number): NearbyDriver[] {
    return this.store.findNearest(origin, { limit, maxDistanceMeters });
  }

  tryReserve(driverId: string): boolean {
    return this.store.tryReserve(driverId);
  }

  release(driverId: string): void {
    this.store.release(driverId);
  }

  getLocation(driverId: string) {
    return this.store.get(driverId);
  }

  get onlineDrivers(): number {
    return this.store.size;
  }
}
