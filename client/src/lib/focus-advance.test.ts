import test from "node:test";
import assert from "node:assert/strict";
import {
  pickNextFocusItem,
  type FocusQueueItemLike,
} from "./focus-advance.ts";

function item(id: string, overrides: Partial<FocusQueueItemLike> = {}): FocusQueueItemLike {
  return {
    session: { id },
    projectId: "proj-1",
    worktreeId: "wt-1",
    projectName: "Test",
    worktreeName: "main",
    ...overrides,
  };
}

test("pickNextFocusItem returns null for an empty queue", () => {
  assert.equal(pickNextFocusItem([], "any"), null);
});

test("pickNextFocusItem stays put on a queue of one (sent-from IS the only item)", () => {
  // The single-item queue. Sending from the only pinned session
  // should NOT navigate — the user would just get bounced.
  const queue = [item("s1")];
  assert.equal(pickNextFocusItem(queue, "s1"), null);
});

test("pickNextFocusItem advances to the next index in a multi-item queue", () => {
  const s1 = item("s1");
  const s2 = item("s2");
  const s3 = item("s3");
  const queue = [s1, s2, s3];
  // Sent from s1 -> s2
  assert.equal(pickNextFocusItem(queue, "s1"), s2);
  // Sent from s2 -> s3
  assert.equal(pickNextFocusItem(queue, "s2"), s3);
  // Sent from s3 (last) -> wraps to s1
  assert.equal(pickNextFocusItem(queue, "s3"), s1);
});

test("pickNextFocusItem treats sent-from-not-in-queue as 'before index 0'", () => {
  // User manually navigated to an unpinned session "external" and
  // sent a message from it. We should still advance, starting from
  // index 0. This is the case that bit the user in the report.
  const queue = [item("s1"), item("s2")];
  const next = pickNextFocusItem(queue, "external");
  assert.equal(next?.session.id, "s1");
});

test("pickNextFocusItem wraps when the only item also matches sent-from", () => {
  // Defensive: if the queue somehow contains the same id the user
  // sent from but other items exist (shouldn't happen with the
  // current dedupe rules, but stay safe), we still skip past it.
  const queue = [item("s1"), item("s2"), item("s1")];
  const next = pickNextFocusItem(queue, "s1");
  // startIndex is 0 (first match), nextIndex wraps to 1
  assert.equal(next?.session.id, "s2");
});
