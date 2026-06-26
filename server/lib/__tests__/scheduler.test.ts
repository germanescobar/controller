import test from "node:test";
import assert from "node:assert/strict";
import {
  clearConsumers,
  registerConsumer,
  runTick,
  tickIntervalMs,
} from "../scheduler.js";

/*
 * Issue #243: the shared wakeup loop. These tests pin down the loop's only
 * job — running registered consumers with `now` on each tick — and its
 * isolation guarantees (a throwing consumer doesn't sink its peers).
 */

test("runTick invokes every registered consumer with the supplied now", () => {
  clearConsumers();
  const seen: Date[] = [];
  registerConsumer((now) => seen.push(now));
  registerConsumer((now) => seen.push(now));

  const now = new Date("2026-06-26T08:00:00.000Z");
  runTick(now);

  assert.equal(seen.length, 2);
  assert.equal(seen[0].toISOString(), now.toISOString());
  assert.equal(seen[1].toISOString(), now.toISOString());
});

test("registerConsumer returns an unregister function", () => {
  clearConsumers();
  let calls = 0;
  const unregister = registerConsumer(() => {
    calls += 1;
  });
  runTick();
  unregister();
  runTick();
  assert.equal(calls, 1);
});

test("a throwing consumer does not prevent the others from running", () => {
  clearConsumers();
  let reached = false;
  registerConsumer(() => {
    throw new Error("boom");
  });
  registerConsumer(() => {
    reached = true;
  });
  assert.doesNotThrow(() => runTick());
  assert.ok(reached, "second consumer should still run after the first throws");
});

test("runTick defaults now to a real Date when omitted", () => {
  clearConsumers();
  let captured: unknown = null;
  registerConsumer((now) => {
    captured = now;
  });
  runTick();
  assert.ok(captured instanceof Date);
});

test("tickIntervalMs honors SCHEDULER_TICK_INTERVAL_MS and rejects junk", () => {
  const previous = process.env.SCHEDULER_TICK_INTERVAL_MS;
  try {
    delete process.env.SCHEDULER_TICK_INTERVAL_MS;
    assert.equal(tickIntervalMs(), 30_000);

    process.env.SCHEDULER_TICK_INTERVAL_MS = "5000";
    assert.equal(tickIntervalMs(), 5_000);

    process.env.SCHEDULER_TICK_INTERVAL_MS = "not-a-number";
    assert.equal(tickIntervalMs(), 30_000);

    process.env.SCHEDULER_TICK_INTERVAL_MS = "-10";
    assert.equal(tickIntervalMs(), 30_000);
  } finally {
    if (previous === undefined) delete process.env.SCHEDULER_TICK_INTERVAL_MS;
    else process.env.SCHEDULER_TICK_INTERVAL_MS = previous;
  }
});
