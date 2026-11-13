import { Topics, type TripRatedEvent } from "../../shared/contracts.js";
import type { MessageQueue } from "../../shared/messageBus.js";

/** Rating Service — بيحسب متوسط تقييم كل كابتن. تقييم واحد بس لكل رحلة. */
export class RatingService {
  private readonly stats = new Map<string, { sum: number; count: number }>();
  private readonly ratedTrips = new Set<string>();

  constructor(private readonly bus: MessageQueue) {}

  start(): this {
    this.bus.subscribe<TripRatedEvent>(Topics.TripRated, "rating", (m) => {
      const e = m.payload;
      if (this.ratedTrips.has(e.tripId)) return;
      this.ratedTrips.add(e.tripId);
      const s = this.stats.get(e.driverId) ?? { sum: 0, count: 0 };
      s.sum += e.stars;
      s.count++;
      this.stats.set(e.driverId, s);
    });
    return this;
  }

  average(driverId: string): number | null {
    const s = this.stats.get(driverId);
    return s ? s.sum / s.count : null;
  }
}
