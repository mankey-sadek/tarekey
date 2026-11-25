import { Topics, type PaymentCapturedEvent } from "../../shared/contracts.js";
import type { MessageQueue } from "../../shared/messageBus.js";

export interface LedgerEntry {
  paymentId: string;
  tripId: string;
  account: string; // rider:<id> | driver:<id> | platform:revenue
  amountCents: number; // سالب = مدين، موجب = دائن
  at: number;
}

/**
 * Accounting Service — قيد مزدوج (double-entry):
 * كل دفعة بتتسجل كذا سطر مجموعهم = صفر. عمولة المنصة ٢٠٪ والباقي للكابتن.
 */
export class AccountingService {
  readonly ledger: LedgerEntry[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly bus: MessageQueue,
    private readonly commissionRate = 0.2,
    private readonly onDriverEarning?: (driverId: string, tripId: string, amountCents: number) => void,
  ) {}

  start(): this {
    this.bus.subscribe<PaymentCapturedEvent>(Topics.PaymentCaptured, "accounting", (m) => {
      const e = m.payload;
      if (this.seen.has(e.paymentId)) return; // idempotent
      this.seen.add(e.paymentId);
      const fee = Math.round(e.amountCents * this.commissionRate);
      const earning = e.amountCents - fee;
      const at = Date.now();
      this.ledger.push(
        { paymentId: e.paymentId, tripId: e.tripId, account: `rider:${e.riderId}`, amountCents: -e.amountCents, at },
        { paymentId: e.paymentId, tripId: e.tripId, account: `driver:${e.driverId}`, amountCents: earning, at },
        { paymentId: e.paymentId, tripId: e.tripId, account: "platform:revenue", amountCents: fee, at },
      );
      this.onDriverEarning?.(e.driverId, e.tripId, earning);
    });
    return this;
  }

  /** صافي الكابتن من رحلة معينة (بعد العمولة) — undefined لو الدفع لسه ماتمش */
  earningFor(driverId: string, tripId: string): number | undefined {
    return this.ledger.find((l) => l.tripId === tripId && l.account === `driver:${driverId}`)?.amountCents;
  }

  balance(account: string): number {
    return this.ledger.filter((l) => l.account === account).reduce((s, l) => s + l.amountCents, 0);
  }
}
