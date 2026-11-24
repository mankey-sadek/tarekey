import type { Trip } from "../../shared/contracts.js";
import type { TripState } from "./stateMachine.js";

export type { Trip };

export interface CasCondition {
  status: TripState;
  version: number;
}

/**
 * طبقة التخزين. الـ interface ده async عشان يبقى زي قاعدة بيانات حقيقية،
 * والتطبيق الحالي في الميموري (InMemoryTripRepository).
 *
 * أهم دالة هي compareAndSet = الـ Conditional Update:
 *
 *   UPDATE trips
 *      SET status = :newStatus, driver_id = :driverId, version = version + 1
 *    WHERE id = :id AND status = :expectedStatus AND version = :expectedVersion;
 *
 * لو rowCount = 0 يبقى حد تاني سبقك وغيّر الرحلة → العملية تفشل بأمان.
 */
export interface TripRepository {
  insert(trip: Trip): Promise<void>;
  get(id: string): Promise<Trip | undefined>;
  compareAndSet(
    id: string,
    expected: CasCondition,
    patch: Partial<Omit<Trip, "id" | "version">>,
  ): Promise<Trip | null>;
  /**
   * تاريخ رحلات زبون أو كابتن، الأحدث الأول.
   *   SELECT * FROM trips WHERE rider_id = $1 AND created_at < $before ORDER BY created_at DESC LIMIT $limit
   * (index على (rider_id, created_at) و (driver_id, created_at))
   */
  listByUser(role: "rider" | "driver", userId: string, opts?: HistoryQuery): Promise<Trip[]>;
}

export interface HistoryQuery {
  limit?: number;
  /** للصفحة اللي بعدها: هات الرحلات اللي اتعملت قبل الوقت ده */
  before?: number;
}

export interface InMemoryRepoOptions {
  /** تأخير وهمي (ms) يحاكي رحلة الشبكة لقاعدة البيانات — مفيد في اختبارات السباق */
  latencyMs?: () => number;
}

export class InMemoryTripRepository implements TripRepository {
  private readonly trips = new Map<string, Trip>();
  /** فهرس بسيط زي الـ index في قاعدة البيانات: `rider:<id>` / `driver:<id>` → أرقام الرحلات بالترتيب */
  private readonly byUser = new Map<string, string[]>();
  private readonly latency: () => number;

  constructor(opts: InMemoryRepoOptions = {}) {
    this.latency = opts.latencyMs ?? (() => 0);
  }

  private async delay() {
    const ms = this.latency();
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }

  async insert(trip: Trip): Promise<void> {
    await this.delay();
    if (this.trips.has(trip.id)) throw new Error(`Trip ${trip.id} already exists`);
    this.trips.set(trip.id, { ...trip });
    this.index(`rider:${trip.riderId}`, trip.id);
    if (trip.driverId) this.index(`driver:${trip.driverId}`, trip.id);
  }

  private index(key: string, tripId: string) {
    const list = this.byUser.get(key);
    if (!list) this.byUser.set(key, [tripId]);
    else if (!list.includes(tripId)) list.push(tripId);
  }

  async listByUser(role: "rider" | "driver", userId: string, opts: HistoryQuery = {}): Promise<Trip[]> {
    await this.delay();
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);
    const ids = this.byUser.get(`${role}:${userId}`) ?? [];
    return ids
      .map((id) => this.trips.get(id)!)
      .filter((t) => opts.before === undefined || t.createdAt < opts.before)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((t) => structuredClone(t));
  }

  async get(id: string): Promise<Trip | undefined> {
    await this.delay();
    const t = this.trips.get(id);
    return t ? structuredClone(t) : undefined;
  }

  async compareAndSet(
    id: string,
    expected: CasCondition,
    patch: Partial<Omit<Trip, "id" | "version">>,
  ): Promise<Trip | null> {
    await this.delay();
    // ↓↓ الجزء ده متزامن بالكامل (مفيش await) فهو ذري في Node.js — زي صف واحد في DB ↓↓
    const current = this.trips.get(id);
    if (!current) return null;
    if (current.status !== expected.status || current.version !== expected.version) {
      return null;
    }
    const updated: Trip = {
      ...current,
      ...patch,
      id,
      version: current.version + 1,
      updatedAt: Date.now(),
    };
    this.trips.set(id, updated);
    if (updated.driverId) this.index(`driver:${updated.driverId}`, id);
    return structuredClone(updated);
  }
}
