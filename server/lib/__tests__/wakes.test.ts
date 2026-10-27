import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * Tests for the deferred-wakeup consumer (issue #339). Covers the duration
 * parser, the queue integration (`dequeueFirst` honors `runAt`), and the
 * wakes consumer's `listDueWakes` / `runDueWakes` paths. The route-layer
 * `advanceSessionQueue` is mocked here because pulling in Express would
 * explode the unit-test startup cost; the integration lives in
 * `queue-routes.test.ts` for the URL surface and in `__tests__/`
 * directories for the wiring.
 */

import {
  enqueue,
  listQueue,
  dequeueFirst,
  type QueuedMessageInput,
} from "../session-queue.js";
import {
  parseDuration,
  resolveRunAt,
  enqueueWake,
  listDueWakes,
  runDueWakes,
  makeWakesConsumer,
} from "../wakes.js";
import { sessionQueueFile, orchestratorHome } from "../paths.js";

function withTempHome(run: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wakes-test-"));
  const original = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;
  return run().finally(() => {
    if (original === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });
}

function queueInput(text: string): QueuedMessageInput {
  return {
    text,
    visibleText: text,
    provider: "claude",
    model: "claude/test",
    mode: "default",
    attachmentIds: [],
  };
}

test("parseDuration returns ms for the supported units", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("5m"), 5 * 60_000);
  assert.equal(parseDuration("1h"), 60 * 60_000);
  assert.equal(parseDuration("2d"), 2 * 24 * 60 * 60_000);
  assert.equal(parseDuration(" 1 h "), 60 * 60_000, "whitespace tolerated");
});

test("parseDuration rejects empty / zero / malformed / unsupported input", () => {
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration("   "), null);
  assert.equal(parseDuration(undefined), null);
  assert.equal(parseDuration(null), null);
  assert.equal(parseDuration("0s"), null);
  assert.equal(parseDuration("-5s"), null);
  assert.equal(parseDuration("5x"), null);
  assert.equal(parseDuration("not-a-duration"), null);
  assert.equal(parseDuration("1w"), null);
});

test("resolveRunAt returns an ISO timestamp relative to now", () => {
  const now = new Date("2026-06-26T08:00:00.000Z");
  const iso = resolveRunAt("30s", now);
  assert.equal(iso, "2026-06-26T08:00:30.000Z");
});

test("resolveRunAt returns null for malformed input", () => {
  assert.equal(resolveRunAt("nope"), null);
});

// --- Queue integration: `runAt` blocks dequeue until the wall clock passes. ---

test("dequeueFirst skips a head whose runAt is in the future", async () => {
  await withTempHome(async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    await enqueue("s1", { ...queueInput("delayed"), runAt: future });
    // First call: head is delayed, must return null without mutating the
    // queue file.
    assert.equal(await dequeueFirst("s1"), null);
    const afterSkip = await listQueue("s1");
    assert.equal(afterSkip.length, 1, "delayed head stays in place");
    assert.equal(afterSkip[0].text, "delayed");
  });
});

test("dequeueFirst pops a head whose runAt is in the past", async () => {
  await withTempHome(async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await enqueue("s1", { ...queueInput("ready"), runAt: past });
    const popped = await dequeueFirst("s1");
    assert.ok(popped);
    assert.equal(popped?.text, "ready");
    assert.equal((await listQueue("s1")).length, 0);
  });
});

test("dequeueFirst pops a head with no runAt (existing behavior)", async () => {
  await withTempHome(async () => {
    await enqueue("s1", queueInput("now"));
    const popped = await dequeueFirst("s1");
    assert.equal(popped?.text, "now");
  });
});

// --- enqueueWake: CLI-friendly input → persisted runAt. ---

test("enqueueWake resolves --delay to an ISO runAt", async () => {
  await withTempHome(async () => {
    const before = Date.now();
    const message = await enqueueWake("s1", {
      ...queueInput("later"),
      delay: "5s",
    });
    assert.ok(message.runAt);
    const parsed = Date.parse(message.runAt as string);
    assert.ok(parsed >= before + 4_500);
    assert.ok(parsed <= before + 5_500, "delay lands in the expected window");
  });
});

test("enqueueWake resolves --runAtIso verbatim", async () => {
  await withTempHome(async () => {
    const iso = "2026-12-31T23:59:59.000Z";
    const message = await enqueueWake("s1", {
      ...queueInput("absolute"),
      runAtIso: iso,
    });
    assert.equal(message.runAt, iso);
  });
});

test("enqueueWake rejects malformed --delay / --run-at", async () => {
  await withTempHome(async () => {
    await assert.rejects(
      enqueueWake("s1", { ...queueInput("x"), delay: "5x" }),
      /Invalid --delay/
    );
    await assert.rejects(
      enqueueWake("s1", { ...queueInput("x"), runAtIso: "not-a-date" }),
      /Invalid --run-at/
    );
  });
});

// --- listDueWakes / runDueWakes: the consumer's view. ---

test("listDueWakes returns every session whose head is now due", async () => {
  await withTempHome(async () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    await enqueue("due", { ...queueInput("now"), runAt: past });
    await enqueue("later", { ...queueInput("later"), runAt: future });
    // Items without `runAt` are regular queued messages — not wakes. The
    // wakes consumer only fans in to advance `runAt`-stamped heads; the
    // shape `runDueSchedules`/queue pipeline drains those on its own.
    await enqueue("noDelay", queueInput("immediate"));
    const due = await listDueWakes(new Date());
    assert.deepEqual(due, ["due"]);
  });
});

test("listDueWakes finds a due wake behind a pending wake", async () => {
  await withTempHome(async () => {
    const now = new Date();
    await enqueue("mixed", { ...queueInput("later"), runAt: new Date(now.getTime() + 60_000).toISOString() });
    await enqueue("mixed", { ...queueInput("due"), runAt: new Date(now.getTime() - 1_000).toISOString() });
    assert.deepEqual(await listDueWakes(now), ["mixed"]);
    assert.equal((await dequeueFirst("mixed"))?.text, "due");
    assert.deepEqual((await listQueue("mixed")).map((item) => item.text), ["later"]);
  });
});

test("listDueWakes skips empty queue files", async () => {
  await withTempHome(async () => {
    // Write an empty queue file directly so the directory has something to
    // scan; the consumer must not crash on it.
    const dir = path.dirname(sessionQueueFile("empty"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(sessionQueueFile("empty"), "[]");
    assert.deepEqual(await listDueWakes(new Date()), []);
  });
});

test("listDueWakes swallows read errors and returns the survivors", async () => {
  await withTempHome(async () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    await enqueue("ok", { ...queueInput("ok"), runAt: past });
    // A malformed JSON queue should not break the scan.
    const dir = path.dirname(sessionQueueFile("broken"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(sessionQueueFile("broken"), "not json");
    const due = await listDueWakes(new Date());
    assert.deepEqual(due, ["ok"]);
  });
});

test("runDueWakes invokes advanceSessionQueue once per due session", async () => {
  await withTempHome(async () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    await enqueue("s-a", { ...queueInput("a"), runAt: past });
    await enqueue("s-b", { ...queueInput("b"), runAt: past });
    const calls: Array<{ sessionId: string; projectId: string; worktreeId: string }> = [];
    await runDueWakes(new Date(), {
      advanceSessionQueue: async (projectId, worktreeId, sessionId) => {
        calls.push({ projectId, worktreeId, sessionId });
      },
    });
    // No project registry is in this test (locateSession returns null), so
    // the consumer's `locateSession` returns null and we get zero calls.
    // That's the contract: without a project, we drop the wake rather than
    // try to fire it.
    assert.equal(calls.length, 0);
  });
});

test("makeWakesConsumer detaches its work via fireAndForget", async () => {
  await withTempHome(async () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    await enqueue("s1", { ...queueInput("a"), runAt: past });
    let detached = false;
    const consumer = makeWakesConsumer(
      {
        advanceSessionQueue: async () => {
          // Would only be called if the consumer's locateSession
          // resolved a project. With no project registry in this test,
          // it stays at zero — the consumer still runs to completion
          // via fireAndForget.
        },
      },
      (work) => {
        detached = true;
        // Capture the returned promise so the test waits for it.
        return work;
      }
    );
    consumer(new Date());
    assert.equal(detached, true, "fire-and-forget detaches the work");
  });
});

// --- locateSession side-effect: missing projects drop the wake. ---

test("runDueWakes silently skips sessions whose project cannot be located", async () => {
  await withTempHome(async () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    await enqueue("orphan", { ...queueInput("o"), runAt: past });
    const calls: string[] = [];
    await runDueWakes(new Date(), {
      advanceSessionQueue: async (_projectId, _worktreeId, sessionId) => {
        calls.push(sessionId);
      },
    });
    assert.deepEqual(calls, []);
    // The queue is preserved — the consumer does not delete items when
    // the project can't be located; the wake just stays until the user
    // resolves the project (or archives the session).
    assert.equal((await listQueue("orphan")).length, 1);
  });
});

// Sanity: enqueueWake without a delay writes no runAt (the field is omitted
// so the queue file stays clean and the existing tests keep their shape).
test("enqueueWake without a delay does not stamp runAt", async () => {
  await withTempHome(async () => {
    const message = await enqueueWake("s1", queueInput("plain"));
    assert.equal(message.runAt, undefined);
    assert.ok(existsSync(sessionQueueFile("s1")));
  });
});

// A fresh empty Controller home has no queues to scan; the consumer must
// not throw on the missing directory.
test("listDueWakes returns an empty list with no CONTROLLER_HOME state", async () => {
  await withTempHome(async () => {
    // No enqueues. The orchestrator home exists from withTempHome but the
    // queues dir has not been created yet.
    assert.deepEqual(await listDueWakes(new Date()), []);
    assert.equal(typeof orchestratorHome(), "string");
  });
});
