import {
  Topics,
  type AcceptAttemptEvent,
  type OfferCreatedEvent,
  type OfferWithdrawnEvent,
  type TripCancelledEvent,
  type TripCompletedEvent,
  type TripRequestedEvent,
} from "../../shared/contracts.js";
import type { MessageQueue } from "../../shared/messageBus.js";
import type { LocationService } from "../location/locationService.js";
import type { TripService } from "../trip/tripService.js";

export type AcceptResult =
  | { ok: true; tripId: string; driverId: string; version: number }
  | { ok: false; reason: "not_offered" | "already_taken" | "driver_busy" | "not_found" };

export interface DispatchOptions {
  /** نبعت الطلب لكام سواق في نفس الوقت */
  fanout?: number;
  searchRadiusMeters?: number;
  offerTtlMs?: number;
  /** لو محدش قبل، نوسّع لسواقين تانيين كام مرة قبل ما نلغي */
  maxRounds?: number;
}

interface OfferState {
  event: TripRequestedEvent;
  drivers: Map<string, number>; // driverId -> distance
  excluded: Set<string>;
  round: number;
  timer: NodeJS.Timeout;
}

/**
 * Dispatch Service — توزيع الطلبات.
 *  1. يسمع trip.requested
 *  2. يسأل Location Service عن أقرب N سواقين متاحين (H3)
 *  3. يبعت العرض للـ N مع بعض (dispatch.offer_created → الـ gateway يوصّله)
 *  4. أول واحد يقبل: يحجز السواق + Conditional Update على الرحلة → الباقيين ياخدوا offer_withdrawn
 *  5. لو محدش قبل في المدة → جولة تانية بسواقين غيرهم، وبعد maxRounds → إلغاء
 */
export class DispatchService {
  private readonly offers = new Map<string, OfferState>();
  private readonly fanout: number;
  private readonly radius: number;
  private readonly ttl: number;
  private readonly maxRounds: number;

  constructor(
    private readonly bus: MessageQueue,
    private readonly location: LocationService,
    private readonly trips: TripService,
    opts: DispatchOptions = {},
  ) {
    this.fanout = opts.fanout ?? 3;
    this.radius = opts.searchRadiusMeters ?? 5_000;
    this.ttl = opts.offerTtlMs ?? 15_000;
    this.maxRounds = opts.maxRounds ?? 3;
  }

  start(): this {
    this.bus.subscribe<TripRequestedEvent>(Topics.TripRequested, "dispatch", (m) => this.dispatch(m.payload));
    this.bus.subscribe<TripCancelledEvent>(Topics.TripCancelled, "dispatch", (m) => {
      this.closeOffer(m.payload.tripId, "cancelled");
      if (m.payload.driverId) this.location.release(m.payload.driverId);
    });
    this.bus.subscribe<TripCompletedEvent>(Topics.TripCompleted, "dispatch", (m) => {
      this.location.release(m.payload.driverId);
    });
    return this;
  }

  /** عدد العروض المفتوحة دلوقتي */
  get openOffers(): number {
    return this.offers.size;
  }

  offeredDrivers(tripId: string): string[] {
    return [...(this.offers.get(tripId)?.drivers.keys() ?? [])];
  }

  private async dispatch(event: TripRequestedEvent, prev?: OfferState): Promise<void> {
    const excluded = prev?.excluded ?? new Set<string>();
    const round = (prev?.round ?? 0) + 1;
    const candidates = this.location
      .findNearest(event.pickup, this.fanout + excluded.size, this.radius)
      .filter((d) => !excluded.has(d.driverId))
      .slice(0, this.fanout);

    if (candidates.length === 0) {
      this.offers.delete(event.tripId);
      await this.cancelIfStillRequested(event.tripId, round === 1 ? "no_drivers_nearby" : "no_driver_accepted");
      return;
    }

    const expiresAt = Date.now() + this.ttl;
    const state: OfferState = {
      event,
      drivers: new Map(candidates.map((d) => [d.driverId, d.distanceMeters])),
      excluded,
      round,
      timer: setTimeout(() => this.onExpired(event.tripId), this.ttl),
    };
    state.timer.unref?.();
    this.offers.set(event.tripId, state);

    for (const d of candidates) {
      excluded.add(d.driverId);
      this.bus.publish<OfferCreatedEvent>(Topics.OfferCreated, {
        tripId: event.tripId,
        riderId: event.riderId,
        driverId: d.driverId,
        pickup: event.pickup,
        dropoff: event.dropoff,
        distanceMeters: Math.round(d.distanceMeters),
        expiresAt,
        fareCents: event.fareCents,
        rideType: event.rideType,
      });
    }
  }

  /**
   * قبول العرض. ممكن يتنادى من أكتر من سواق في نفس اللحظة.
   * الحماية الحقيقية هي assignDriver (CAS على status+version) — حتى لو اتنين عدّوا كل الفحوصات
   * اللي قبلها مع بعض، واحد بس هيعدّي الـ UPDATE.
   */
  async accept(tripId: string, driverId: string): Promise<AcceptResult> {
    const r = await this.tryAccept(tripId, driverId);
    this.bus.publish<AcceptAttemptEvent>(Topics.AcceptAttempt, {
      tripId,
      driverId,
      ok: r.ok,
      reason: r.ok ? undefined : r.reason,
      version: r.ok ? r.version : undefined,
    });
    return r;
  }

  private async tryAccept(tripId: string, driverId: string): Promise<AcceptResult> {
    const offer = this.offers.get(tripId);
    if (!offer) {
      const trip = await this.trips.get(tripId);
      return { ok: false, reason: trip ? "already_taken" : "not_found" };
    }
    if (!offer.drivers.has(driverId)) return { ok: false, reason: "not_offered" };

    // ١) نحجز السواق نفسه (عشان مايقبلش رحلتين في نفس الوقت)
    if (!this.location.tryReserve(driverId)) return { ok: false, reason: "driver_busy" };

    // ٢) نقرا الرحلة ونعمل Conditional Update على النسخة اللي شفناها
    const trip = await this.trips.get(tripId);
    if (!trip || trip.status !== "requested") {
      this.location.release(driverId);
      return { ok: false, reason: "already_taken" };
    }
    const updated = await this.trips.assignDriver(tripId, driverId, trip.version);
    if (!updated) {
      this.location.release(driverId); // خسر السباق
      return { ok: false, reason: "already_taken" };
    }

    // ٣) كسب → نسحب العرض من الباقيين
    const current = this.offers.get(tripId);
    if (current) {
      clearTimeout(current.timer);
      this.offers.delete(tripId);
      const losers = [...current.drivers.keys()].filter((id) => id !== driverId);
      if (losers.length) {
        this.bus.publish<OfferWithdrawnEvent>(Topics.OfferWithdrawn, { tripId, driverIds: losers, reason: "taken" });
      }
    }
    return { ok: true, tripId, driverId, version: updated.version };
  }

  async decline(tripId: string, driverId: string): Promise<void> {
    const offer = this.offers.get(tripId);
    if (!offer?.drivers.delete(driverId)) return;
    if (offer.drivers.size === 0) {
      clearTimeout(offer.timer);
      await this.nextRound(offer);
    }
  }

  private async onExpired(tripId: string) {
    const offer = this.offers.get(tripId);
    if (!offer) return;
    const ids = [...offer.drivers.keys()];
    if (ids.length) this.bus.publish<OfferWithdrawnEvent>(Topics.OfferWithdrawn, { tripId, driverIds: ids, reason: "expired" });
    await this.nextRound(offer);
  }

  private async nextRound(offer: OfferState) {
    if (offer.round >= this.maxRounds) {
      this.offers.delete(offer.event.tripId);
      await this.cancelIfStillRequested(offer.event.tripId, "no_driver_accepted");
      return;
    }
    await this.dispatch(offer.event, offer);
  }

  private closeOffer(tripId: string, reason: OfferWithdrawnEvent["reason"]) {
    const offer = this.offers.get(tripId);
    if (!offer) return;
    clearTimeout(offer.timer);
    this.offers.delete(tripId);
    const ids = [...offer.drivers.keys()];
    if (ids.length) this.bus.publish<OfferWithdrawnEvent>(Topics.OfferWithdrawn, { tripId, driverIds: ids, reason });
  }

  private async cancelIfStillRequested(tripId: string, reason: string) {
    try {
      await this.trips.cancel(tripId, "system", undefined, reason);
    } catch {
      /* الرحلة اتقبلت أو اتلغت خلاص — مفيش حاجة نعملها */
    }
  }

  stop() {
    for (const o of this.offers.values()) clearTimeout(o.timer);
    this.offers.clear();
  }
}
