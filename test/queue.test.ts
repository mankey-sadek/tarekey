import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryMessageQueue } from "../src/shared/messageBus.js";

test("publish returns immediately; handlers run asynchronously", async () => {
  const q = new InMemoryMessageQueue();
  const seen: string[] = [];
  q.subscribe<string>("t", "g", async (m) => {
    await new Promise((r) => setTimeout(r, 30));
    seen.push(m.payload);
  });
  const t0 = performance.now();
  q.publish("t", "a");
  assert.ok(performance.now() - t0 < 5, "publish must not wait for the consumer");
  assert.deepEqual(seen, []);
  await q.drain();
  assert.deepEqual(seen, ["a"]);
});

test("fan-out: every consumer group gets its own copy, failures are isolated", async () => {
  const q = new InMemoryMessageQueue({ maxAttempts: 2, baseBackoffMs: 1 });
  const payments: number[] = [];
  q.subscribe<number>("trip.completed", "payment", (m) => void payments.push(m.payload));
  q.subscribe<number>("trip.completed", "notification", () => {
    throw new Error("push provider down");
  });
  q.publish("trip.completed", 1);
  q.publish("trip.completed", 2);
  await q.drain();
  assert.deepEqual(payments, [1, 2]);
  assert.equal(q.deadLetters.filter((d) => d.group === "notification").length, 2);
});

test("retries with backoff then succeeds", async () => {
  const q = new InMemoryMessageQueue({ maxAttempts: 3, baseBackoffMs: 1 });
  let calls = 0;
  q.subscribe("t", "g", () => {
    calls++;
    if (calls < 3) throw new Error("flaky");
  });
  q.publish("t", {});
  await q.drain();
  assert.equal(calls, 3);
  assert.equal(q.deadLetters.length, 0);
});

test("keeps per-group order", async () => {
  const q = new InMemoryMessageQueue();
  const got: number[] = [];
  q.subscribe<number>("t", "g", async (m) => {
    await new Promise((r) => setTimeout(r, Math.random() * 5));
    got.push(m.payload);
  });
  for (let i = 0; i < 20; i++) q.publish("t", i);
  await q.drain();
  assert.deepEqual(got, [...Array(20).keys()]);
});
