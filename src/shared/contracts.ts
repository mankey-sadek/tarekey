import type { LatLng } from "./geo.js";

/**
 * العقود (contracts) بين الخدمات: أسماء الـ topics وشكل كل رسالة.
 * الخدمات مابتعرفش بعض — كل اللي تعرفه الرسالة دي.
 */
export const Topics = {
  // trip-service → dispatch
  TripRequested: "trip.requested",
  // dispatch → gateway (يوصّل العرض للسواق)
  OfferCreated: "dispatch.offer_created",
  OfferWithdrawn: "dispatch.offer_withdrawn",
  // dispatch → monitoring: كل محاولة قبول (كسب أو خسر السباق)
  AcceptAttempt: "dispatch.accept_attempt",
  // trip-service → الكل
  TripStatusChanged: "trip.status_changed",
  TripCompleted: "trip.completed",
  TripCancelled: "trip.cancelled",
  TripRated: "trip.rated",
  // payment → accounting / notification
  PaymentCaptured: "payment.captured",
  PaymentFailed: "payment.failed",
  // أي خدمة → notification
  NotificationRequested: "notification.requested",
} as const;

export interface TripRequestedEvent {
  tripId: string;
  riderId: string;
  pickup: LatLng;
  dropoff: LatLng;
  fareCents: number;
  rideType: string;
}

export interface OfferCreatedEvent {
  tripId: string;
  riderId: string;
  driverId: string;
  pickup: LatLng;
  dropoff: LatLng;
  distanceMeters: number;
  expiresAt: number;
  fareCents: number;
  rideType: string;
}

export interface OfferWithdrawnEvent {
  tripId: string;
  driverIds: string[];
  reason: "taken" | "cancelled" | "expired";
}

/** شكل الرحلة اللي بيتبعت بين الخدمات وللأبلكيشن */
export interface Trip {
  id: string;
  riderId: string;
  driverId: string | null;
  pickup: LatLng;
  dropoff: LatLng;
  status: "requested" | "accepted" | "driver_arrived" | "started" | "completed" | "cancelled";
  /** رقم نسخة للـ optimistic locking — بيزيد مع كل تعديل */
  version: number;
  fareCents: number | null;
  rideType?: string;
  cancelledBy: "rider" | "driver" | "system" | null;
  createdAt: number;
  updatedAt: number;
}

export interface TripStatusChangedEvent {
  trip: Trip;
  tripId: string;
  riderId: string;
  driverId: string | null;
  from: string;
  to: string;
  version: number;
}

export interface TripCompletedEvent {
  tripId: string;
  riderId: string;
  driverId: string;
  fareCents: number;
}

export interface TripCancelledEvent {
  tripId: string;
  riderId: string;
  driverId: string | null;
  by: "rider" | "driver" | "system";
  reason?: string;
}

export interface TripRatedEvent {
  tripId: string;
  riderId: string;
  driverId: string;
  stars: number;
  comment?: string;
}

export interface PaymentCapturedEvent {
  paymentId: string;
  tripId: string;
  riderId: string;
  driverId: string;
  amountCents: number;
}

export interface PaymentFailedEvent {
  tripId: string;
  riderId: string;
  reason: string;
}

export interface NotificationRequestedEvent {
  userId: string;
  title: string;
  body: string;
}

export interface AcceptAttemptEvent {
  tripId: string;
  driverId: string;
  ok: boolean;
  reason?: string;
  version?: number;
}
