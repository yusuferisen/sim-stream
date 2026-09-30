// Unit tests for the backends' input FIFO. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { SerialQueue } from "../backends/queue.js";

test("tasks run one at a time, in the order they were pushed", async () => {
  const q = new SerialQueue();
  const log = [];
  let release;
  const first = q.push(() => new Promise((r) => { log.push("a start"); release = r; }));
  const second = q.push(async () => { log.push("b"); return "B"; });
  const third = q.push(async () => { log.push("c"); return "C"; });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(log, ["a start"]); // b and c wait for a
  release("A");
  assert.equal(await first, "A");
  assert.equal(await second, "B");
  assert.equal(await third, "C");
  assert.deepEqual(log, ["a start", "b", "c"]);
});

test("a failing task rejects its own promise and does not stall the queue", async () => {
  const q = new SerialQueue();
  const bad = q.push(async () => { throw new Error("boom"); });
  const good = q.push(async () => "fine");
  await assert.rejects(bad, /boom/);
  assert.equal(await good, "fine");
  assert.equal(q.running, false);
});

test("a task that throws synchronously is handled like a rejection", async () => {
  const q = new SerialQueue();
  await assert.rejects(q.push(() => { throw new Error("sync"); }), /sync/);
  assert.equal(await q.push(async () => 1), 1);
});
