import test from "node:test";
import assert from "node:assert/strict";
import {
  markFocusItemHandled,
  sortFocusQueue,
  type FocusQueueItem,
} from "../sidebar.tsx";

function item(
  id: string,
  lastActiveAt: string,
  active: boolean,
  lastVisitedAt?: string,
): FocusQueueItem {
  // The sort only inspects `session.lastActiveAt`, `active`, and
  // `lastVisitedAt`; the rest of the fields are filler so the
  // resulting type matches `FocusQueueItem`.
  return {
    projectId: "p",
    projectName: "P",
    worktreeId: "w",
    worktreeName: "W",
    session: {
      id,
      workingDirectory: "/tmp",
      worktreeId: "w",
      model: "test",
      messages: [],
      createdAt: lastActiveAt,
      lastActiveAt,
      status: "idle",
    },
    active,
    lastVisitedAt,
  };
}

function ids(items: FocusQueueItem[]): string[] {
  return items.map((item) => item.session.id);
}

test("all-finished: oldest-arrival at the top of the finished block (FIFO)", () => {
  // Finished items are ordered by `lastActiveAt` ascending, so the
  // user walks them in arrival order — the oldest one first.
  const result = sortFocusQueue([
    item("newest-arrival", "2024-01-03T00:00:00.000Z", false),
    item("oldest-arrival", "2024-01-01T00:00:00.000Z", false),
    item("middle-arrival", "2024-01-02T00:00:00.000Z", false),
  ]);
  assert.deepEqual(ids(result), [
    "oldest-arrival",
    "middle-arrival",
    "newest-arrival",
  ]);
});

test("all-running: oldest running at the top, newest at the bottom", () => {
  const result = sortFocusQueue([
    item("newest", "2024-01-03T00:00:00.000Z", true),
    item("oldest", "2024-01-01T00:00:00.000Z", true),
    item("middle", "2024-01-02T00:00:00.000Z", true),
  ]);
  assert.deepEqual(ids(result), ["oldest", "middle", "newest"]);
});

test("mixed: finished block (oldest first) sits above the running block", () => {
  const result = sortFocusQueue([
    item("running-newest", "2024-01-10T00:00:00.000Z", true),
    item("finished-oldest-arrival", "2024-01-01T00:00:00.000Z", false),
    item("running-oldest", "2024-01-05T00:00:00.000Z", true),
    item("finished-newest-arrival", "2024-01-04T00:00:00.000Z", false),
  ]);
  assert.deepEqual(ids(result), [
    "finished-oldest-arrival",
    "finished-newest-arrival",
    "running-oldest",
    "running-newest",
  ]);
});

test("ties on lastActiveAt fall back to array order within each bucket", () => {
  // Array#sort is stable (Node ≥ 12), so equal timestamps keep their
  // original relative order. The acceptance criteria explicitly allow
  // this fallback.
  const result = sortFocusQueue([
    item("a", "2024-01-01T00:00:00.000Z", false),
    item("b", "2024-01-01T00:00:00.000Z", false),
    item("c", "2024-01-01T00:00:00.000Z", false),
  ]);
  assert.deepEqual(ids(result), ["a", "b", "c"]);
});

test("a freshly-finished running session appends to the bottom of the finished block", () => {
  // Two running sessions ("running-newer" is the most recently started,
  // so it sits at the bottom of the running bucket) and one finished
  // session that arrived a long time ago.
  const before = sortFocusQueue([
    item("finished-old-arrival", "2024-01-01T00:00:00.000Z", false),
    item("running-older", "2024-01-02T00:00:00.000Z", true),
    item("running-newer", "2024-01-05T00:00:00.000Z", true),
  ]);
  assert.deepEqual(ids(before), [
    "finished-old-arrival",
    "running-older",
    "running-newer",
  ]);

  // "running-newer" finishes in the same render. Its `lastActiveAt`
  // is the most recent of the finished pile, so it lands at the
  // bottom of the finished block (newest-arrival there), just above
  // the running sessions.
  const after = sortFocusQueue([
    item("finished-old-arrival", "2024-01-01T00:00:00.000Z", false),
    item("running-older", "2024-01-02T00:00:00.000Z", true),
    item("running-newer", "2024-01-05T00:00:00.000Z", false),
  ]);
  assert.deepEqual(ids(after), [
    "finished-old-arrival",
    "running-newer",
    "running-older",
  ]);
});

test("does not mutate the input array", () => {
  const input: FocusQueueItem[] = [
    item("running", "2024-01-02T00:00:00.000Z", true),
    item("finished", "2024-01-01T00:00:00.000Z", false),
  ];
  const snapshot = ids(input);
  sortFocusQueue(input);
  assert.deepEqual(ids(input), snapshot);
});

// ---------------------------------------------------------------------------
// Awaiting-input priority (issue #333 follow-up).
// ---------------------------------------------------------------------------

function awaitingItem(
  id: string,
  lastActiveAt: string,
  active: boolean,
): FocusQueueItem {
  return {
    ...item(id, lastActiveAt, active),
    awaitingInput: true,
  };
}

test("awaiting-input: surfaces at the top of the queue regardless of `active`", () => {
  // Claude's structured-input pause kills the child (active: false)
  // but the session still needs the user. The flag wins.
  const result = sortFocusQueue([
    awaitingItem("paused", "2024-01-05T00:00:00.000Z", false),
    item("running-oldest", "2024-01-01T00:00:00.000Z", true),
    item("running-newest", "2024-01-02T00:00:00.000Z", true),
  ]);
  assert.deepEqual(ids(result), [
    "paused",
    "running-oldest",
    "running-newest",
  ]);
});

test("awaiting-input: wins over a recently-finished item with a fresher timestamp", () => {
  // The finished item arrived after the awaiting one. The awaiting
  // one still wins because the user owes a reply to it.
  const result = sortFocusQueue([
    item("finished-just-now", "2024-01-10T00:00:00.000Z", false),
    awaitingItem("awaiting", "2024-01-05T00:00:00.000Z", false),
  ]);
  assert.deepEqual(ids(result), ["awaiting", "finished-just-now"]);
});

test("awaiting-input: multiple awaiting sessions are ordered oldest-arrival first", () => {
  const result = sortFocusQueue([
    awaitingItem("awaiting-newest-arrival", "2024-01-05T00:00:00.000Z", false),
    awaitingItem("awaiting-oldest-arrival", "2024-01-01T00:00:00.000Z", false),
    item("running", "2024-01-02T00:00:00.000Z", true),
  ]);
  assert.deepEqual(ids(result), [
    "awaiting-oldest-arrival",
    "awaiting-newest-arrival",
    "running",
  ]);
});

test("awaiting-input: bucket sits above the finished bucket sits above the running bucket", () => {
  const result = sortFocusQueue([
    item("running-newest", "2024-01-10T00:00:00.000Z", true),
    item("finished-oldest-arrival", "2024-01-01T00:00:00.000Z", false),
    item("running-oldest", "2024-01-02T00:00:00.000Z", true),
    awaitingItem("awaiting", "2024-01-06T00:00:00.000Z", false),
    item("finished-newest-arrival", "2024-01-04T00:00:00.000Z", false),
  ]);
  assert.deepEqual(ids(result), [
    "awaiting",
    "finished-oldest-arrival",
    "finished-newest-arrival",
    "running-oldest",
    "running-newest",
  ]);
});

// ---------------------------------------------------------------------------
// Visited vs unvisited split (issue #333 follow-up).
//
// The finished block is split into "triage pile" (never visited by
// the user) and "already seen" (visited at some point). The unvisited
// pile stays at the top of the finished block; once a session is
// visited (skipped, replied to, etc.), it sinks to the visited
// sub-block so the user isn't bounced back to it on every cycle.
// ---------------------------------------------------------------------------

test("finished, unvisited: oldest-arrival first at the top of the finished block", () => {
  // No items visited yet — pure triage pile, sorted oldest-first.
  const result = sortFocusQueue([
    item("finished-newest-arrival", "2024-01-05T00:00:00.000Z", false),
    item("finished-oldest-arrival", "2024-01-01T00:00:00.000Z", false),
    item("finished-middle-arrival", "2024-01-03T00:00:00.000Z", false),
  ]);
  assert.deepEqual(ids(result), [
    "finished-oldest-arrival",
    "finished-middle-arrival",
    "finished-newest-arrival",
  ]);
});

test("a session that finishes after it was handled returns to the unvisited pile", () => {
  const result = sortFocusQueue([
    item(
      "finished-again",
      "2024-01-05T00:00:00.000Z",
      false,
      "2024-01-04T00:00:00.000Z",
    ),
    item(
      "already-handled",
      "2024-01-01T00:00:00.000Z",
      false,
      "2024-01-06T00:00:00.000Z",
    ),
  ]);
  assert.deepEqual(ids(result), ["finished-again", "already-handled"]);
});

test("finished, visited: sinks below the unvisited triage pile", () => {
  // Mixing visited and unvisited. Unvisited stays at the top of
  // the finished block; visited sinks below.
  const result = sortFocusQueue([
    item("visited-newer", "2024-01-05T00:00:00.000Z", false, "2024-01-10T00:00:00.000Z"),
    item("unvisited-oldest", "2024-01-01T00:00:00.000Z", false),
    item("visited-older", "2024-01-02T00:00:00.000Z", false, "2024-01-08T00:00:00.000Z"),
    item("unvisited-newer", "2024-01-04T00:00:00.000Z", false),
  ]);
  assert.deepEqual(ids(result), [
    "unvisited-oldest",
    "unvisited-newer",
    "visited-older",
    "visited-newer",
  ]);
});

test("finished, visited: most-recently-visited at the very bottom of the visited sub-block", () => {
  // Within the visited sub-block, items are sorted by
  // lastVisitedAt asc — the freshest visit sits closest to the
  // running pile below.
  const result = sortFocusQueue([
    item("visited-fresh", "2024-01-01T00:00:00.000Z", false, "2024-01-10T00:00:00.000Z"),
    item("visited-stale", "2024-01-05T00:00:00.000Z", false, "2024-01-08T00:00:00.000Z"),
    item("visited-middle", "2024-01-03T00:00:00.000Z", false, "2024-01-09T00:00:00.000Z"),
  ]);
  assert.deepEqual(ids(result), [
    "visited-stale",
    "visited-middle",
    "visited-fresh",
  ]);
});

test("advancing past a finished session sinks it before choosing the new first row", () => {
  // The "before" state has A as unvisited (top of finished).
  // Marking A handled and re-sorting is step one of advance.
  const before = sortFocusQueue([
    item("a", "2024-01-01T00:00:00.000Z", false),
    item("b", "2024-01-02T00:00:00.000Z", false),
  ]);
  assert.deepEqual(ids(before), ["a", "b"]);

  const after = markFocusItemHandled(
    before,
    "a",
    "2024-01-05T00:00:00.000Z",
  );
  assert.deepEqual(ids(after), ["b", "a"]);
  assert.equal(after[0].session.id, "b");
});

test("full queue with visits: awaiting → unvisited → visited → running", () => {
  const result = sortFocusQueue([
    item("running-newest", "2024-01-10T00:00:00.000Z", true),
    awaitingItem("awaiting", "2024-01-06T00:00:00.000Z", false),
    item("finished-visited", "2024-01-01T00:00:00.000Z", false, "2024-01-09T00:00:00.000Z"),
    item("finished-unvisited-newer", "2024-01-04T00:00:00.000Z", false),
    item("finished-unvisited-older", "2024-01-02T00:00:00.000Z", false),
    item("running-oldest", "2024-01-05T00:00:00.000Z", true),
  ]);
  assert.deepEqual(ids(result), [
    "awaiting",
    "finished-unvisited-older",
    "finished-unvisited-newer",
    "finished-visited",
    "running-oldest",
    "running-newest",
  ]);
});

/*
 * Issue #437: dedupe focus-queue items by session id. A colliding
 * session id appears once per worktree store; the focus queue
 * must show only the picked owner. The dropped copies contribute
 * to the kept row's `duplicates` field so the UI can still
 * render a "duplicate copy" badge.
 */

import { dedupeFocusItemsBySessionId } from "../sidebar.tsx";

test("dedupeFocusItemsBySessionId keeps the most-recently-active copy and folds the older into duplicates", () => {
  // The exact on-disk shape from the issue body: a session id
  // with the same title in two worktrees, with the feature
  // worktree having a fresher lastActiveAt. The dedupe must
  // keep the feature copy as the row the user sees and surface
  // the main copy in `duplicates`.
  const feature = item("shared", "2026-10-17T19:34:10.000Z", true, undefined);
  feature.worktreeId = "wt-feature";
  feature.worktreeName = "feature";
  const main = item("shared", "2026-10-16T04:15:21.000Z", true, undefined);
  main.worktreeId = "wt-main";
  main.worktreeName = "main";
  const result = dedupeFocusItemsBySessionId([feature, main]);
  assert.equal(result.length, 1, "colliding id must dedupe to one row");
  assert.equal(result[0].worktreeId, "wt-feature", "must keep the fresher copy as the owner");
  assert.ok(Array.isArray(result[0].duplicates));
  assert.equal(result[0].duplicates!.length, 1);
  assert.equal(result[0].duplicates![0].worktreeId, "wt-main");
});

test("dedupeFocusItemsBySessionId leaves single-store sessions untouched", () => {
  // The happy path: a unique session id is rendered once, with
  // no `duplicates` field.
  const solo = item("unique", "2026-10-17T19:34:10.000Z", true, undefined);
  const result = dedupeFocusItemsBySessionId([solo]);
  assert.equal(result.length, 1);
  assert.equal(result[0].session.id, "unique");
  assert.equal(result[0].duplicates, undefined);
});

test("dedupeFocusItemsBySessionId preserves input order when no collisions are present", () => {
  // The focus queue shouldn't reshuffle on every re-render just
  // because we ran the dedupe.
  const a = item("a", "2026-10-17T10:00:00.000Z", true, undefined);
  const b = item("b", "2026-10-17T11:00:00.000Z", true, undefined);
  const c = item("c", "2026-10-17T12:00:00.000Z", true, undefined);
  const result = dedupeFocusItemsBySessionId([a, b, c]);
  assert.deepEqual(
    result.map((r) => r.session.id),
    ["a", "b", "c"]
  );
});

test("focus dedupe uses transcript size before lexical ID for timestamp ties in either input order", () => {
  for (const reverse of [false, true]) {
    const small = item("shared", "2026-10-17T10:00:00.000Z", false);
    const large = item("shared", "2026-10-17T10:00:00.000Z", false);
    small.worktreeId = "a";
    large.worktreeId = "z";
    small.duplicates = [{ worktreeId: "z", worktreeName: "large", lastActiveAt: large.session.lastActiveAt, eventsSize: 900 }];
    large.duplicates = [{ worktreeId: "a", worktreeName: "small", lastActiveAt: small.session.lastActiveAt, eventsSize: 100 }];
    const result = dedupeFocusItemsBySessionId(reverse ? [large, small] : [small, large]);
    assert.equal(result.length, 1);
    assert.equal(result[0].worktreeId, "z");
  }
});
