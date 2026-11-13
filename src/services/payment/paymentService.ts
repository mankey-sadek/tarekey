import { Topics, type PaymentCapturedEvent, type PaymentFailedEvent, type TripCompletedEvent } from "../../shared/contracts.js";
import type { MessageQueue } from "../../shared/messageBus.js";

/** بوابة الدفع الخارجية (Paymob / Fawry / Stripe ...) */
export interface PaymentGateway {
  charge(input: { riderId: string; amountCents: number; idempotencyKey: string }): Promise<{ paymentId: string }>;
}

export class FakePaymentGateway implements PaymentGateway {
  /** عدد المرات اللي هيفشل فيها قبل ما ينجح — لاختبار الـ retry */
  constructor(private failuresLeft = 0, private readonly latencyMs = 5) {}
  readonly charges: Array<{ riderId: string; amountCents: number; idempotencyKey: string }> = [];
  async charge(input: { riderId: string; amountCents: number; idempotencyKey: string }) {
    await new Promise((r) => setTimeout(r, this.latencyMs));
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error("gateway timeout");
    }
    this.charges.push(input);
    return { paymentId: "pay_" + input.idempotencyKey };
  }
}

/**
 * Payment Service — بيسمع trip.completed ويخصم من الزبون.
 * Idempotent: لو نفس الرسالة وصلت مرتين (at-least-once delivery) مابيخصمش مرتين،
 * لأن مفتاح الـ idempotency هو رقم الرحلة.
 */
export class PaymentService {
  private readonly paid = new Map<string, string>(); // tripId -> paymentId

  constructor(
    private readonly bus: MessageQueue,
    private readonly gateway: PaymentGateway,
  ) {}

  start(): this {
    this.bus.subscribe<TripCompletedEvent>(Topics.TripCompleted, "payment", async (m) => {
      const e = m.payload;
      if (this.paid.has(e.tripId)) return; // اتدفعت قبل كده
      try {
        const { paymentId } = await this.gateway.charge({
          riderId: e.riderId,
          amountCents: e.fareCents,
          idempotencyKey: e.tripId,
        });
        this.paid.set(e.tripId, paymentId);
        this.bus.publish<PaymentCapturedEvent>(Topics.PaymentCaptured, {
          paymentId,
          tripId: e.tripId,
          riderId: e.riderId,
          driverId: e.driverId,
          amountCents: e.fareCents,
        });
      } catch (err) {
        // آخر محاولة؟ نبلغ بالفشل. غير كده نرمي الخطأ والطابور يعيد المحاولة
        if (m.attempts >= 3) {
          this.bus.publish<PaymentFailedEvent>(Topics.PaymentFailed, {
            tripId: e.tripId,
            riderId: e.riderId,
            reason: (err as Error).message,
          });
        }
        throw err;
      }
    });
    return this;
  }

  paymentFor(tripId: string) {
    return this.paid.get(tripId);
  }
}
