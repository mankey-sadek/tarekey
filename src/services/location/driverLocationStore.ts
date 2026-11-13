import { gridDisk, latLngToCell } from "h3-js";
import { haversineMeters, type LatLng } from "../../shared/geo.js";

export type DriverStatus = "available" | "busy";

export interface DriverLocation extends LatLng {
  driverId: string;
  cell: string;
  status: DriverStatus;
  updatedAt: number;
}

export interface NearbyDriver extends DriverLocation {
  distanceMeters: number;
}

export interface DriverLocationStoreOptions {
  /** دقة H3. 9 = خلية سداسية ضلعها ~174 متر تقريباً */
  resolution?: number;
  /** أي لوكيشن أقدم من كده يعتبر السواق مش متاح (قفل الأبلكيشن/النت فصل) */
  staleAfterMs?: number;
  now?: () => number;
}

/**
 * مخزن مؤقت في الميموري لأماكن السواقين، متفهرس بـ H3.
 *
 *  - drivers: driverId -> آخر لوكيشن
 *  - cells:   H3 cell  -> مجموعة السواقين اللي جوه الخلية دي
 *
 * لما سواق يتحرك من خلية لخلية، بنشيله من القديمة ونحطه في الجديدة (O(1)).
 * البحث عن أقرب سواق بيلف في حلقات (rings) حوالين خلية الزبون بدل ما يلف على كل السواقين.
 */
export class DriverLocationStore {
  private readonly drivers = new Map<string, DriverLocation>();
  private readonly cells = new Map<string, Set<string>>();
  readonly resolution: number;
  private readonly staleAfterMs: number;
  private readonly now: () => number;

  constructor(opts: DriverLocationStoreOptions = {}) {
    this.resolution = opts.resolution ?? 9;
    this.staleAfterMs = opts.staleAfterMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  upsert(driverId: string, pos: LatLng): DriverLocation {
    const cell = latLngToCell(pos.lat, pos.lng, this.resolution);
    const prev = this.drivers.get(driverId);
    if (prev && prev.cell !== cell) this.removeFromCell(prev.cell, driverId);
    const loc: DriverLocation = {
      driverId,
      lat: pos.lat,
      lng: pos.lng,
      cell,
      status: prev?.status ?? "available",
      updatedAt: this.now(),
    };
    this.drivers.set(driverId, loc);
    let set = this.cells.get(cell);
    if (!set) this.cells.set(cell, (set = new Set()));
    set.add(driverId);
    return loc;
  }

  remove(driverId: string): void {
    const prev = this.drivers.get(driverId);
    if (!prev) return;
    this.removeFromCell(prev.cell, driverId);
    this.drivers.delete(driverId);
  }

  get(driverId: string): DriverLocation | undefined {
    return this.drivers.get(driverId);
  }

  all(): IterableIterator<DriverLocation> {
    return this.drivers.values();
  }

  /** آخر عملية بحث — للعرض في لوحة المراقبة */
  lastSearch: { seq: number; origin: LatLng; rings: string[][]; scanned: number; found: number; ms: number } | null = null;
  private searchSeq = 0;

  get size(): number {
    return this.drivers.size;
  }

  /**
   * حجز السواق بشكل ذري (check-and-set): ينجح بس لو السواق "available".
   * ده بيمنع إن نفس السواق يقبل رحلتين في نفس الوقت.
   */
  tryReserve(driverId: string): boolean {
    const d = this.drivers.get(driverId);
    if (!d || d.status !== "available") return false;
    d.status = "busy";
    return true;
  }

  release(driverId: string): void {
    const d = this.drivers.get(driverId);
    if (d) d.status = "available";
  }

  /**
   * أقرب سواقين متاحين.
   * بنوسّع الحلقات k = 0, 1, 2 ... لحد ما نلاقي عدد كفاية، وبعدها نوسع حلقة زيادة
   * عشان الخلايا السداسية مش دواير مظبوطة (ممكن سواق في الحلقة اللي بعدها يبقى أقرب فعلياً)،
   * وفي الآخر بنرتب بالمسافة الحقيقية (haversine).
   */
  findNearest(
    origin: LatLng,
    opts: { limit?: number; maxRings?: number; maxDistanceMeters?: number } = {},
  ): NearbyDriver[] {
    const limit = opts.limit ?? 5;
    const maxRings = opts.maxRings ?? 15;
    const maxDistance = opts.maxDistanceMeters ?? Infinity;
    const originCell = latLngToCell(origin.lat, origin.lng, this.resolution);
    const visited = new Set<string>();
    const found: NearbyDriver[] = [];
    const now = this.now();
    const t0 = performance.now();
    const rings: string[][] = [];
    let extraRingDone = false;

    for (let k = 0; k <= maxRings; k++) {
      const ring: string[] = [];
      rings.push(ring);
      for (const cell of gridDisk(originCell, k)) {
        if (visited.has(cell)) continue;
        visited.add(cell);
        ring.push(cell);
        const ids = this.cells.get(cell);
        if (!ids) continue;
        for (const id of ids) {
          const d = this.drivers.get(id)!;
          if (d.status !== "available") continue;
          if (now - d.updatedAt > this.staleAfterMs) continue;
          const distanceMeters = haversineMeters(origin, d);
          if (distanceMeters > maxDistance) continue;
          found.push({ ...d, distanceMeters });
        }
      }
      if (found.length >= limit) {
        if (extraRingDone) break;
        extraRingDone = true;
      }
    }
    const result = found.sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, limit);
    this.lastSearch = { seq: ++this.searchSeq, origin, rings, scanned: visited.size, found: found.length, ms: performance.now() - t0 };
    return result;
  }

  /** يشيل السواقين اللي مبعتوش لوكيشن من فترة */
  evictStale(): string[] {
    const now = this.now();
    const evicted: string[] = [];
    for (const [id, d] of this.drivers) {
      if (d.status === "available" && now - d.updatedAt > this.staleAfterMs) {
        this.remove(id);
        evicted.push(id);
      }
    }
    return evicted;
  }

  private removeFromCell(cell: string, driverId: string) {
    const set = this.cells.get(cell);
    if (!set) return;
    set.delete(driverId);
    if (set.size === 0) this.cells.delete(cell);
  }
}
