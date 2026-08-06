import test from "node:test";
import assert from "node:assert/strict";
import { acceptCodexSteer } from "../codex-steer.js";
import type { QueuedMessage, QueuedMessageInput } from "../session-queue.js";

function queued(id = "queued-1"): QueuedMessage {
  return {
    id,
    text: "follow up",
    visibleText: "follow up",
    provider: "codex",
    model: "gpt-5",
    mode: "default",
    attachmentIds: [],
    createdAt: "2026-08-06T00:00:00.000Z",
  };
}

function options(outcome: "steered" | "turn-ended", queuedMessageId?: string) {
  const calls = { enqueued: 0, removed: 0 };
  const item = queued(queuedMessageId);
  return {
    calls,
    input: {
      queuedMessageId,
      steer: async () => outcome,
      getQueuedMessage: async () => item,
      removeQueuedMessage: async () => { calls.removed += 1; },
      buildFollowUp: async (): Promise<QueuedMessageInput> => item,
      enqueueFollowUp: async () => { calls.enqueued += 1; return item; },
    },
  };
}

test("accepted native steer does not enqueue and removes a promoted item once", async () => {
  const fixture = options("steered", "queued-1");
  assert.deepEqual(await acceptCodexSteer(fixture.input), { disposition: "steered" });
  assert.deepEqual(fixture.calls, { enqueued: 0, removed: 1 });
});

test("turn-finalization race preserves typed text as a queued follow-up", async () => {
  const fixture = options("turn-ended");
  const result = await acceptCodexSteer(fixture.input);
  assert.equal(result.disposition, "queued");
  assert.deepEqual(fixture.calls, { enqueued: 1, removed: 0 });
});

test("turn-finalization race leaves a promoted queue item exactly once", async () => {
  const fixture = options("turn-ended", "queued-1");
  const result = await acceptCodexSteer(fixture.input);
  assert.equal(result.disposition, "queued");
  assert.deepEqual(fixture.calls, { enqueued: 0, removed: 0 });
});

test("genuine native steer failure does not enqueue or remove queue state", async () => {
  const fixture = options("steered");
  fixture.input.steer = async () => { throw new Error("protocol failure"); };
  await assert.rejects(() => acceptCodexSteer(fixture.input), /protocol failure/);
  assert.deepEqual(fixture.calls, { enqueued: 0, removed: 0 });
});
