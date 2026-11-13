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
}

export interface InMemoryRepoOptions {
  /** تأخير وهمي (ms) يحاكي رحلة الشبكة لقاعدة البيانات — مفيد في اختبارات السباق */
  latencyMs?: () => number;
}

export class InMemoryTripRepository implements TripRepository {
  private readonly trips = new Map<string, Trip>();
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
    return structuredClone(updated);
  }
}
