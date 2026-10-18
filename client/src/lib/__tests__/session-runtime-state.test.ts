import test from "node:test";
import assert from "node:assert/strict";
import { filterVisibleQueue, isUserQueuedMessage, truncateWakePreview } from "../session-runtime-state.ts";
import type { QueuedMessage } from "../../api.ts";

function message(id: string, overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return { id, text: id, visibleText: id, provider: "codex", model: "gpt-6", mode: "default", attachmentIds: [], createdAt: "2026-10-18T00:00:00Z", ...overrides };
}

test("composer shows only user-typed entries regardless of queue order", () => {
  const queue = [
    message("wake", { origin: "wake", runAt: "2026-10-19T00:00:00Z" }),
    message("user", { origin: "user" }),
    message("goal", { origin: "goal" }),
    message("send", { origin: "send" }),
    message("monitor", { origin: "monitor" }),
  ];
  assert.deepEqual(filterVisibleQueue(queue).map((item) => item.id), ["user"]);
  assert.equal(queue.find(isUserQueuedMessage)?.id, "user");
});

test("legacy queue entries classify scheduled and marked follow-ups conservatively", () => {
  const queue = [
    message("scheduled", { runAt: "2026-10-17T00:00:00Z" }),
    message("from", { text: "[/from: Parent] controller://project/p/worktree/w/session/s hello" }),
    message("monitor", { visibleText: "[/monitor: CI] passed" }),
    message("goal", { text: "Continue working toward the active goal. Re-read it." }),
    message("typed"),
  ];
  assert.deepEqual(filterVisibleQueue(queue).map((item) => item.id), ["typed"]);
});

test("wake preview stays compact", () => {
  assert.equal(truncateWakePreview("a".repeat(41)), `${"a".repeat(40)}…`);
});
