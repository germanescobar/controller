import test from "node:test";
import assert from "node:assert/strict";
import {
  filterVisibleQueue,
  truncateWakePreview,
} from "../session-runtime-state.ts";
import type { QueuedMessage } from "../../api.ts";

/*
 * Helper-level coverage for the wake-preview / queue-filter
 * primitives that back the floating panel's delay row and the
 * composer's queue strip (issue #339 + the wake-preview
 * follow-up). The SessionView render is too provider-heavy to
 * unit-test the visible behavior directly, so the
 * `filterVisibleQueue` predicate and the `truncateWakePreview`
 * truncation are tested here as the shared source of truth.
 */

function makeMessage(overrides: Partial<QueuedMessage>): QueuedMessage {
  return {
    id: overrides.id ?? "msg-1",
    text: overrides.text ?? "Hello",
    visibleText: overrides.visibleText ?? overrides.text ?? "Hello",
    provider: overrides.provider ?? "claude",
    model: overrides.model ?? "claude-opus-5",
    mode: overrides.mode ?? "default",
    attachmentIds: overrides.attachmentIds ?? [],
    createdAt: overrides.createdAt ?? "2026-09-30T16:00:00.000Z",
    ...(overrides.runAt !== undefined ? { runAt: overrides.runAt } : {}),
  };
}

test("filterVisibleQueue passes through messages without runAt", () => {
  // A user-typed queue entry has no `runAt`. It is the kind of
  // follow-up the queue strip exists for — keep it visible.
  const queue: QueuedMessage[] = [makeMessage({ id: "u1" })];
  const result = filterVisibleQueue(queue, 1_000_000);
  assert.deepEqual(result.map((m) => m.id), ["u1"]);
});

test("filterVisibleQueue drops messages with a future runAt", () => {
  // A wake with `runAt` in the future is the floating panel's
  // job — strip it from the queue list so it isn't
  // double-listed.
  const now = 1_700_000_000_000;
  const queue: QueuedMessage[] = [
    makeMessage({ id: "wake", runAt: new Date(now + 60_000).toISOString() }),
  ];
  const result = filterVisibleQueue(queue, now);
  assert.deepEqual(result, []);
});

test("filterVisibleQueue keeps messages whose runAt has already elapsed", () => {
  // The wakes consumer drains due heads, but there is a brief
  // window between "delay elapsed" and "queue file updated"
  // where the head is still on disk with a past `runAt`. The
  // strip should still show it during that gap so the user
  // can cancel it if it hasn't drained yet.
  const now = 1_700_000_000_000;
  const queue: QueuedMessage[] = [
    makeMessage({ id: "fired", runAt: new Date(now - 5_000).toISOString() }),
  ];
  const result = filterVisibleQueue(queue, now);
  assert.deepEqual(result.map((m) => m.id), ["fired"]);
});

test("filterVisibleQueue handles a mixed list — drops only future wakes", () => {
  const now = 1_700_000_000_000;
  const queue: QueuedMessage[] = [
    // Future wake: hidden from the strip.
    makeMessage({ id: "future", runAt: new Date(now + 30_000).toISOString() }),
    // User-typed queue entry: visible.
    makeMessage({ id: "user", text: "Follow up question" }),
    // Already-elapsed wake: visible (drain hasn't happened yet).
    makeMessage({ id: "past", runAt: new Date(now - 1_000).toISOString() }),
    // Another user queue entry: visible.
    makeMessage({ id: "user2", text: "Second follow up" }),
  ];
  const result = filterVisibleQueue(queue, now);
  assert.deepEqual(result.map((m) => m.id), ["user", "past", "user2"]);
});

test("filterVisibleQueue accepts a parameterized `now` for stable tests", () => {
  // Wall-clock-dependent code is a test-hazard; verify the
  // helper takes `now` explicitly so the call site can pass
  // `Date.now()` while tests pin the value.
  const queue: QueuedMessage[] = [
    makeMessage({ id: "wake", runAt: "2026-09-30T17:00:00.000Z" }),
  ];
  // Future wake (strict `now < runAt`): hidden from the strip
  // because the floating panel owns the surface.
  assert.deepEqual(filterVisibleQueue(queue, Date.parse("2026-09-30T16:59:59.000Z")), []);
  // Boundary (`now == runAt`): the wakes consumer is firing
  // this tick; the strip takes over so the user can still
  // see / cancel it during the drain window.
  assert.deepEqual(
    filterVisibleQueue(queue, Date.parse("2026-09-30T17:00:00.000Z")),
    [queue[0]],
  );
  // Past wake: same as above, kept visible until the wakes
  // consumer drains it.
  assert.deepEqual(filterVisibleQueue(queue, Date.parse("2026-09-30T17:00:01.000Z")), [queue[0]]);
});

test("truncateWakePreview keeps short messages verbatim", () => {
  assert.equal(truncateWakePreview("Hello"), "Hello");
  assert.equal(truncateWakePreview(""), "");
  assert.equal(truncateWakePreview("a".repeat(40)), "a".repeat(40));
});

test("truncateWakePreview truncates longer messages with an ellipsis", () => {
  const long = "x".repeat(120);
  const truncated = truncateWakePreview(long);
  assert.equal(truncated.length, 41); // 40 chars + ellipsis
  assert.match(truncated, /^x{40}…$/);
});

test("truncateWakePreview matches the relationship-row truncation style", () => {
  // Same 40-char limit so the floating panel keeps one
  // truncation style across all rows (parent / children /
  // monitors / delay preview). The relationship rows use the
  // same `slice(0, 40) + "…"` formula in
  // `focus-conversation-controls.tsx` — pinning this test
  // to 40 keeps the two helpers from drifting apart.
  const long = "abcdefghij".repeat(20); // 200 chars
  const truncated = truncateWakePreview(long);
  assert.equal(truncated, "abcdefghij".repeat(4) + "…");
});
