import { randomUUID } from "node:crypto";
import { haversineMeters, type LatLng } from "../../shared/geo.js";
import {
  Topics,
  type TripCancelledEvent,
  type TripCompletedEvent,
  type TripRatedEvent,
  type TripRequestedEvent,
  type TripStatusChangedEvent,
} from "../../shared/contracts.js";
import type { MessageQueue } from "../../shared/messageBus.js";
import { InvalidTransitionError, nextState, type TripEvent } from "./stateMachine.js";
import type { HistoryQuery, Trip, TripRepository } from "./tripRepository.js";

export type TripErrorCode = "not_found" | "forbidden" | "invalid_transition" | "conflict" | "bad_request";

export class TripError extends Error {
  constructor(
    readonly code: TripErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TripError";
  }
}

export const RIDE_TYPES = { eco: 1, comfort: 1.35, xl: 1.7 } as const;
export type RideType = keyof typeof RIDE_TYPES;

/** تسعيرة بسيطة: فتح عداد ١٥ ج + ٧ ج/كم (بالقرش) × معامل نوع العربية */
export function calculateFareCents(pickup: LatLng, dropoff: LatLng, rideType: RideType = "eco"): number {
  const km = haversineMeters(pickup, dropoff) / 1000;
  return Math.round((1500 + km * 700) * RIDE_TYPES[rideType]);
}

/** أكواد الخصم: نسبة مئوية بحد أقصى، وكل زبون يستخدم الكود مرة واحدة */
export const PROMO_CODES: Record<string, { percent: number; maxCents: number; label: string }> = {
  FITARI2AK: { percent: 20, maxCents: 3000, label: "خصم ٢٠٪ لحد ٣٠ ج.م" },
  WELCOME50: { percent: 50, maxCents: 5000, label: "خصم ٥٠٪ لحد ٥٠ ج.م على أول رحلة" },
};

export interface TripRequestOptions {
  pickupName?: string;
  dropoffName?: string;
  promoCode?: string;
}

/**
 * Trip Service — صاحب بيانات الرحلة الوحيد.
 * أي تغيير في حالة رحلة لازم يعدي من هنا، ولازم يكون:
 *   1) انتقال مسموح في الـ state machine
 *   2) Conditional Update (status + version) — مفيش "آخر واحد يكتب يكسب"
 */
export class TripService {
  constructor(
    private readonly repo: TripRepository,
    private readonly bus: MessageQueue,
    private readonly newId: () => string = () => "t_" + randomUUID().slice(0, 8),
  ) {}

  async requestTrip(
    riderId: string,
    pickup: LatLng,
    dropoff: LatLng,
    rideType: RideType = "eco",
    opts: TripRequestOptions = {},
  ): Promise<Trip> {
    if (!(rideType in RIDE_TYPES)) throw new TripError("bad_request", `Unknown ride type ${rideType}`);
    const fullFare = calculateFareCents(pickup, dropoff, rideType);
    const promo = opts.promoCode ? await this.checkPromo(riderId, opts.promoCode) : null;
    const discountCents = promo ? Math.min(promo.maxCents, Math.round((fullFare * promo.percent) / 100)) : 0;
    const label = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : undefined);
    const now = Date.now();
    const trip: Trip = {
      id: this.newId(),
      riderId,
      driverId: null,
      pickup,
      dropoff,
      status: "requested",
      version: 1,
      fareCents: fullFare - discountCents,
      rideType,
      cancelledBy: null,
      pickupName: label(opts.pickupName),
      dropoffName: label(opts.dropoffName),
      promoCode: promo ? promo.code : null,
      discountCents,
      riderStars: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.insert(trip);
    this.bus.publish<TripRequestedEvent>(Topics.TripRequested, { tripId: trip.id, riderId, pickup, dropoff, fareCents: trip.fareCents!, rideType });
    this.publishStatus(trip, "none");
    return trip;
  }

  get(tripId: string) {
    return this.repo.get(tripId);
  }

  /** تاريخ الرحلات (الأحدث الأول) — الزبون بيشوف رحلاته، والكابتن الرحلات اللي اتعينت له */
  history(role: "rider" | "driver", userId: string, opts: HistoryQuery = {}): Promise<Trip[]> {
    return this.repo.listByUser(role, userId, opts);
  }

  /**
   * يتأكد إن الكود موجود وإن الزبون ماستخدموش قبل كده في رحلة مالغيتش.
   * WELCOME50 لأول رحلة مكتملة بس.
   */
  async checkPromo(riderId: string, rawCode: string) {
    const code = String(rawCode).trim().toUpperCase();
    const promo = PROMO_CODES[code];
    if (!promo) throw new TripError("bad_request", "invalid_promo");
    const past = await this.repo.listByUser("rider", riderId, { limit: 100 });
    if (past.some((t) => t.promoCode === code && t.status !== "cancelled")) throw new TripError("bad_request", "promo_used");
    if (code === "WELCOME50" && past.some((t) => t.status === "completed")) throw new TripError("bad_request", "promo_first_trip_only");
    return { code, ...promo };
  }

  /**
   * تعيين سواق — ده المكان اللي بيتحل فيه سباق القبول.
   * expectedVersion هي النسخة اللي السواق "شافها" لما قرا الرحلة.
   *   UPDATE trips SET status='accepted', driver_id=$driver, version=version+1
   *    WHERE id=$id AND status='requested' AND version=$expectedVersion
   * @returns الرحلة بعد التحديث، أو null لو حد سبقه
   */
  async assignDriver(tripId: string, driverId: string, expectedVersion: number): Promise<Trip | null> {
    const updated = await this.repo.compareAndSet(
      tripId,
      { status: "requested", version: expectedVersion },
      { status: nextState("requested", "accept"), driverId },
    );
    if (updated) this.publishStatus(updated, "requested");
    return updated;
  }

  arrive(tripId: string, driverId: string) {
    return this.transition(tripId, "arrive", { driverId });
  }

  start(tripId: string, driverId: string) {
    return this.transition(tripId, "start", { driverId });
  }

  async complete(tripId: string, driverId: string): Promise<Trip> {
    const trip = await this.transition(tripId, "complete", { driverId });
    // الرد بيرجع للكابتن فوراً — الدفع/الإشعارات/التقييم/الحسابات كلها بتشتغل من الطابور
    this.bus.publish<TripCompletedEvent>(Topics.TripCompleted, {
      tripId: trip.id,
      riderId: trip.riderId,
      driverId: trip.driverId!,
      fareCents: trip.fareCents!,
    });
    return trip;
  }

  async cancel(tripId: string, by: "rider" | "driver" | "system", actorId?: string, reason?: string): Promise<Trip> {
    const actor = by === "rider" ? { riderId: actorId } : by === "driver" ? { driverId: actorId } : {};
    const trip = await this.transition(tripId, "cancel", actor, { cancelledBy: by });
    this.bus.publish<TripCancelledEvent>(Topics.TripCancelled, {
      tripId,
      riderId: trip.riderId,
      driverId: trip.driverId,
      by,
      reason,
    });
    return trip;
  }

  async rate(tripId: string, riderId: string, stars: number, comment?: string): Promise<void> {
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new TripError("bad_request", "stars must be 1..5");
    const trip = await this.repo.get(tripId);
    if (!trip) throw new TripError("not_found", "Trip not found");
    if (trip.riderId !== riderId) throw new TripError("forbidden", "Not your trip");
    if (trip.status !== "completed") throw new TripError("invalid_transition", "Trip is not completed");
    if (trip.riderStars) throw new TripError("conflict", "already_rated");
    // بنحفظ التقييم على الرحلة نفسها (CAS برضه، عشان لو اتبعت مرتين في نفس اللحظة يتحسب مرة)
    const saved = await this.repo.compareAndSet(tripId, { status: "completed", version: trip.version }, { riderStars: stars });
    if (!saved) throw new TripError("conflict", "already_rated");
    this.bus.publish<TripRatedEvent>(Topics.TripRated, { tripId, riderId, driverId: trip.driverId!, stars, comment });
  }

  /**
   * انتقال عام: اقرا → اتأكد إن الانتقال مسموح → CAS.
   * لو الـ CAS فشل (حد غيّر الرحلة في النص، مثلاً الزبون لغى في نفس لحظة "وصلت")
   * بنعيد القراءة؛ ولو الحالة الجديدة مش بتسمح → invalid_transition.
   */
  private async transition(
    tripId: string,
    event: TripEvent,
    actor: { driverId?: string; riderId?: string },
    patch: Partial<Trip> = {},
  ): Promise<Trip> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const trip = await this.repo.get(tripId);
      if (!trip) throw new TripError("not_found", "Trip not found");
      if ("driverId" in actor && trip.driverId !== actor.driverId) {
        throw new TripError("forbidden", "Driver is not assigned to this trip");
      }
      if ("riderId" in actor && trip.riderId !== actor.riderId) throw new TripError("forbidden", "Not your trip");
      let to;
      try {
        to = nextState(trip.status, event);
      } catch (e) {
        if (e instanceof InvalidTransitionError) throw new TripError("invalid_transition", e.message);
        throw e;
      }
      const updated = await this.repo.compareAndSet(
        tripId,
        { status: trip.status, version: trip.version },
        { ...patch, status: to },
      );
      if (updated) {
        this.publishStatus(updated, trip.status);
        return updated;
      }
    }
    throw new TripError("conflict", "Trip is being modified concurrently, retry");
  }

  private publishStatus(trip: Trip, from: string) {
    this.bus.publish<TripStatusChangedEvent>(Topics.TripStatusChanged, {
      trip,
      tripId: trip.id,
      riderId: trip.riderId,
      driverId: trip.driverId,
      from,
      to: trip.status,
      version: trip.version,
    });
  }
}
