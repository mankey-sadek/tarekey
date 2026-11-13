import { randomUUID } from "node:crypto";

export interface Message<T = unknown> {
  id: string;
  topic: string;
  payload: T;
  attempts: number;
  publishedAt: number;
}

export type Handler<T = unknown> = (msg: Message<T>) => Promise<void> | void;

/**
 * Message Queue بنمط pub/sub + consumer groups:
 *  - publish بيرجع فوراً (fire-and-forget) → الـ request الأصلي مايستناش الدفع ولا الإشعارات.
 *  - كل group مشترك في topic بياخد نسخته الخاصة من الرسالة (fan-out)،
 *    فلو خدمة الإشعارات وقعت مابتأثرش على خدمة الدفع.
 *  - retry مع exponential backoff، وبعد آخر محاولة الرسالة بتروح Dead Letter Queue.
 *
 * التطبيق ده في الميموري للتجربة. في الإنتاج نفس الـ interface يتنفذ فوق
 * RabbitMQ / Kafka / Redis Streams / SQS من غير ما باقي الكود يتغير.
 */
export interface MessageQueue {
  publish<T>(topic: string, payload: T): string;
  subscribe<T>(topic: string, group: string, handler: Handler<T>): void;
}

export interface InMemoryQueueOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  logger?: (line: string) => void;
}

interface Subscription {
  group: string;
  handler: Handler;
  buffer: Message[];
  running: boolean;
}

export class InMemoryMessageQueue implements MessageQueue {
  private readonly subs = new Map<string, Subscription[]>();
  private readonly inFlight = new Set<Promise<void>>();
  readonly deadLetters: Array<{ group: string; message: Message; error: string }> = [];
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly log: (line: string) => void;

  constructor(opts: InMemoryQueueOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.baseBackoffMs = opts.baseBackoffMs ?? 50;
    this.log = opts.logger ?? (() => {});
  }

  publish<T>(topic: string, payload: T): string {
    const id = randomUUID();
    const groups = this.subs.get(topic) ?? [];
    for (const sub of groups) {
      sub.buffer.push({ id, topic, payload, attempts: 0, publishedAt: Date.now() });
      this.pump(sub);
    }
    return id;
  }

  subscribe<T>(topic: string, group: string, handler: Handler<T>): void {
    const list = this.subs.get(topic) ?? [];
    list.push({ group, handler: handler as Handler, buffer: [], running: false });
    this.subs.set(topic, list);
  }

  /** يستنى لحد ما كل الرسايل تتعالج (للاختبارات والسيميوليتر) */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0 || this.hasPending()) {
      await Promise.all([...this.inFlight]);
      await new Promise((r) => setImmediate(r));
    }
  }

  private hasPending(): boolean {
    for (const list of this.subs.values()) for (const s of list) if (s.buffer.length) return true;
    return false;
  }

  private pump(sub: Subscription) {
    if (sub.running) return;
    sub.running = true;
    const p = (async () => {
      // نخلي الـ publisher يكمل الأول — المعالجة async بالكامل
      await new Promise((r) => setImmediate(r));
      while (sub.buffer.length > 0) {
        const msg = sub.buffer.shift()!;
        await this.deliver(sub, msg);
      }
      sub.running = false;
    })();
    this.inFlight.add(p);
    p.finally(() => this.inFlight.delete(p));
  }

  private async deliver(sub: Subscription, msg: Message) {
    for (;;) {
      msg.attempts++;
      try {
        await sub.handler(msg);
        return;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (msg.attempts >= this.maxAttempts) {
          this.deadLetters.push({ group: sub.group, message: msg, error: reason });
          this.log(`[queue] ☠ ${sub.group} gave up on ${msg.topic} ${msg.id}: ${reason}`);
          return;
        }
        const backoff = this.baseBackoffMs * 2 ** (msg.attempts - 1);
        this.log(`[queue] ↻ ${sub.group} retry #${msg.attempts} in ${backoff}ms: ${reason}`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
}

