import WebSocket from "ws";

/** عميل WebSocket بسيط للاختبارات والسيميوليتر */
export class TestClient {
  readonly ws: WebSocket;
  readonly inbox: any[] = [];
  private waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
  private seq = 0;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      this.inbox.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
  }

  /** token: لو السيرفر طالب توثيق (requireAuth) */
  static async connect(base: string, role: "driver" | "rider", id: string, token?: string) {
    const c = new TestClient(token ? `${base}/ws?token=${encodeURIComponent(token)}` : `${base}/ws?role=${role}&id=${id}`);
    await c.waitFor((m) => m.type === "hello");
    return c;
  }

  waitFor(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const found = this.inbox.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }

  send(msg: object) {
    this.ws.send(JSON.stringify(msg));
  }

  /** يبعت ويستنى الرد (ack أو error) بنفس reqId */
  request(msg: object): Promise<any> {
    const reqId = ++this.seq;
    this.send({ ...msg, reqId });
    return this.waitFor((m) => m.reqId === reqId);
  }

  close() {
    this.ws.close();
  }
}
