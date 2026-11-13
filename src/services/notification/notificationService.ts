import {
  Topics,
  type PaymentCapturedEvent,
  type PaymentFailedEvent,
  type TripCancelledEvent,
  type TripCompletedEvent,
  type TripStatusChangedEvent,
} from "../../shared/contracts.js";
import type { MessageQueue } from "../../shared/messageBus.js";

export interface Notification {
  userId: string;
  title: string;
  body: string;
}

/** القناة اللي بتوصّل الإشعار فعلاً (FCM / APNs / SMS). هنا بنوصّلها على الـ WebSocket لو المستخدم متصل */
export type NotificationSink = (n: Notification) => void;

const egp = (c: number) => (c / 100).toFixed(2) + " ج.م";

/** Notification Service — بيحوّل أحداث النظام لإشعارات للزبون والكابتن */
export class NotificationService {
  readonly sent: Notification[] = [];
  private sinks: NotificationSink[] = [];

  constructor(private readonly bus: MessageQueue) {}

  addSink(sink: NotificationSink) {
    this.sinks.push(sink);
  }

  start(): this {
    this.bus.subscribe<TripStatusChangedEvent>(Topics.TripStatusChanged, "notification", (m) => {
      const e = m.payload;
      if (e.to === "accepted") this.send(e.riderId, "لقينالك كابتن 🚗", "الكابتن في الطريق ليك");
      if (e.to === "driver_arrived") this.send(e.riderId, "الكابتن وصل 📍", "مستنيك في نقطة الركوب");
    });
    this.bus.subscribe<TripCompletedEvent>(Topics.TripCompleted, "notification", (m) => {
      this.send(m.payload.riderId, "وصلت بالسلامة 🎉", "قيّم رحلتك مع الكابتن");
    });
    this.bus.subscribe<PaymentCapturedEvent>(Topics.PaymentCaptured, "notification", (m) => {
      this.send(m.payload.riderId, "تم الدفع 💳", `اتخصم ${egp(m.payload.amountCents)}`);
    });
    this.bus.subscribe<PaymentFailedEvent>(Topics.PaymentFailed, "notification", (m) => {
      this.send(m.payload.riderId, "الدفع مانجحش", "من فضلك حدّث وسيلة الدفع");
    });
    this.bus.subscribe<TripCancelledEvent>(Topics.TripCancelled, "notification", (m) => {
      const e = m.payload;
      const why = e.by === "system" ? "مفيش كباتن متاحين دلوقتي" : e.by === "driver" ? "الكابتن لغى الرحلة" : "الرحلة اتلغت";
      this.send(e.riderId, "الرحلة اتلغت", why);
      if (e.driverId && e.by !== "driver") this.send(e.driverId, "الرحلة اتلغت", "الزبون لغى الرحلة");
    });
    return this;
  }

  private send(userId: string, title: string, body: string) {
    const n = { userId, title, body };
    this.sent.push(n);
    for (const s of this.sinks) s(n);
  }
}
