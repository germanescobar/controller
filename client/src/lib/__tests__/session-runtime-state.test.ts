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
 *
 * `filterVisibleQueue` is intentionally narrow: it drops only
 * the *head* message if that head is a wake with a future
 * `runAt`. The floating panel represents only `queue[0]`, so
 * that is the only message whose absence from the strip would
 * not erase the user's only cancel surface. See PR #403
 * codex-review follow-up for the bug that motivated the
 * narrowing.
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

test("filterVisibleQueue passes through user-typed queue entries", () => {
  // A user-typed queue entry has no `runAt`. It is the kind of
  // follow-up the queue strip exists for — keep it visible.
  const queue: QueuedMessage[] = [makeMessage({ id: "u1" })];
  const result = filterVisibleQueue(queue, 1_000_000);
  assert.deepEqual(result.map((m) => m.id), ["u1"]);
});

test("filterVisibleQueue drops a wake that is at the head of the queue", () => {
  // The head wake is the one the floating panel represents, so
  // its absence from the strip is not a lost cancel button —
  // the panel owns the surface.
  const now = 1_700_000_000_000;
  const queue: QueuedMessage[] = [
    makeMessage({ id: "wake", runAt: new Date(now + 60_000).toISOString() }),
  ];
  const result = filterVisibleQueue(queue, now);
  assert.deepEqual(result.map((m) => m.id), []);
});

test("filterVisibleQueue keeps a head wake whose runAt has already elapsed", () => {
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

test("filterVisibleQueue keeps a wake queued behind an ordinary message", () => {
  // Codex-review follow-up: the predicate must not remove
  // wakes that the floating panel does not represent. A wake
  // queued *after* a user-typed message is not the head, so
  // the panel shows the user message and the wake has no
  // other UI surface. Removing it would erase the only
  // cancel button even though the server still fires it.
  const now = 1_700_000_000_000;
  const queue: QueuedMessage[] = [
    makeMessage({ id: "user", text: "Follow up question" }),
    makeMessage({ id: "wake", runAt: new Date(now + 30_000).toISOString() }),
  ];
  const result = filterVisibleQueue(queue, now);
  assert.deepEqual(result.map((m) => m.id), ["user", "wake"]);
});

test("filterVisibleQueue keeps wakes stacked behind the head wake", () => {
  // The floating panel represents only `queue[0]`, so a second
  // scheduled wake has no other surface. Both the head and the
  // tail wake are kept visible in the strip — wait, no: the
  // head wake IS represented by the panel, so only the head
  // is dropped. The second wake must remain in the strip so
  // the user can still cancel it.
  const now = 1_700_000_000_000;
  const queue: QueuedMessage[] = [
    makeMessage({ id: "wake1", runAt: new Date(now + 30_000).toISOString() }),
    makeMessage({ id: "wake2", runAt: new Date(now + 90_000).toISOString() }),
  ];
  const result = filterVisibleQueue(queue, now);
  assert.deepEqual(result.map((m) => m.id), ["wake2"]);
});

test("filterVisibleQueue keeps wakes on mobile-style queues (no head wake)", () => {
  // Codex-review follow-up: on mobile, the floating panel
  // does not render the delay row at all, so *no* wake is
  // "represented by the panel". The predicate must not run
  // per-mount and must remain a pure function of the queue
  // contents — and the contents here are a non-head wake,
  // which the rule keeps visible. This test documents the
  // invariant: filterVisibleQueue never looks at the panel
  // state, only at queue[0]'s runAt.
  const now = 1_700_000_000_000;
  const queue: QueuedMessage[] = [
    makeMessage({ id: "user", text: "Hey" }),
    makeMessage({ id: "wake", runAt: new Date(now + 30_000).toISOString() }),
  ];
  const result = filterVisibleQueue(queue, now);
  assert.deepEqual(result.map((m) => m.id), ["user", "wake"]);
});

test("filterVisibleQueue handles a mixed list — drops only the head future wake", () => {
  // Codex-review follow-up: with the narrowed predicate,
  // only the head future wake is dropped. Everything else —
  // user queue entries, wakes behind the head, and wakes
  // whose delay has already elapsed — passes through.
  const now = 1_700_000_000_000;
  const queue: QueuedMessage[] = [
    // Head future wake: dropped (the panel represents it).
    makeMessage({ id: "future", runAt: new Date(now + 30_000).toISOString() }),
    // User-typed queue entry: kept.
    makeMessage({ id: "user", text: "Follow up question" }),
    // Already-elapsed wake: kept (drain hasn't happened yet).
    makeMessage({ id: "past", runAt: new Date(now - 1_000).toISOString() }),
    // Another user queue entry: kept.
    makeMessage({ id: "user2", text: "Second follow up" }),
    // Second scheduled wake: kept (panel only represents the head).
    makeMessage({ id: "wake2", runAt: new Date(now + 90_000).toISOString() }),
  ];
  const result = filterVisibleQueue(queue, now);
  assert.deepEqual(result.map((m) => m.id), ["user", "past", "user2", "wake2"]);
});

test("filterVisibleQueue accepts a parameterized `now` for stable tests", () => {
  // Wall-clock-dependent code is a test-hazard; verify the
  // helper takes `now` explicitly so the call site can pass
  // `Date.now()` while tests pin the value.
  const queue: QueuedMessage[] = [
    makeMessage({ id: "wake", runAt: "2026-09-30T17:00:00.000Z" }),
  ];
  // Future wake as the head: dropped (panel represents it).
  assert.deepEqual(filterVisibleQueue(queue, Date.parse("2026-09-30T16:59:59.000Z")), []);
  // Boundary (`now == runAt`): the wakes consumer is firing
  // this tick; the head is no longer "in the future", so the
  // strip takes over and the user can still see / cancel it
  // during the drain window.
  assert.deepEqual(
    filterVisibleQueue(queue, Date.parse("2026-09-30T17:00:00.000Z")),
    [queue[0]],
  );
  // Past wake: kept visible until the wakes consumer drains it.
  assert.deepEqual(filterVisibleQueue(queue, Date.parse("2026-09-30T17:00:01.000Z")), [queue[0]]);
});

test("filterVisibleQueue never mutates the input array", () => {
  // `queue.slice()` (and `queue.slice(1)`) always return a
  // new array, but the input here has objects we want to
  // share between caller and callee. Pin the contract so
  // SessionView's `useMemo` always gets a fresh reference
  // when the head wake changes, triggering a re-render.
  const now = 1_700_000_000_000;
  const head = makeMessage({ id: "wake", runAt: new Date(now + 30_000).toISOString() });
  const tail = makeMessage({ id: "user", text: "After" });
  const queue: QueuedMessage[] = [head, tail];
  const result = filterVisibleQueue(queue, now);
  assert.notEqual(result, queue);
  assert.deepEqual(queue.map((m) => m.id), ["wake", "user"]);
  assert.deepEqual(result.map((m) => m.id), ["user"]);
});

test("filterVisibleQueue returns a fresh array even when nothing is dropped", () => {
  // When the head is not a future wake, return a copy so
  // SessionView's `useMemo` dependency on the array
  // reference re-fires when the contents change. Pin this
  // so a future refactor to `return queue` does not
  // silently break memoization.
  const queue: QueuedMessage[] = [makeMessage({ id: "u1" })];
  const result = filterVisibleQueue(queue, 1_000_000);
  assert.notEqual(result, queue);
  assert.deepEqual(result.map((m) => m.id), ["u1"]);
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
