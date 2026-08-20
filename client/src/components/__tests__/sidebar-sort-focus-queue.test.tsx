import test from "node:test";
import assert from "node:assert/strict";
import {
  sortFocusQueue,
  type FocusQueueItem,
} from "../sidebar.tsx";

function item(
  id: string,
  lastActiveAt: string,
  active: boolean,
): FocusQueueItem {
  // The sort only inspects `session.lastActiveAt` and `active`; the rest
  // of the fields are filler so the resulting type matches `FocusQueueItem`.
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
  };
}

function ids(items: FocusQueueItem[]): string[] {
  return items.map((item) => item.session.id);
}

test("all-finished: most recently finished lands at the top", () => {
  const result = sortFocusQueue([
    item("oldest", "2024-01-01T00:00:00.000Z", false),
    item("newest", "2024-01-03T00:00:00.000Z", false),
    item("middle", "2024-01-02T00:00:00.000Z", false),
  ]);
  assert.deepEqual(ids(result), ["newest", "middle", "oldest"]);
});

test("all-running: oldest running at the top, newest at the bottom", () => {
  const result = sortFocusQueue([
    item("newest", "2024-01-03T00:00:00.000Z", true),
    item("oldest", "2024-01-01T00:00:00.000Z", true),
    item("middle", "2024-01-02T00:00:00.000Z", true),
  ]);
  assert.deepEqual(ids(result), ["oldest", "middle", "newest"]);
});

test("mixed: all finished above all running", () => {
  const result = sortFocusQueue([
    item("running-newest", "2024-01-10T00:00:00.000Z", true),
    item("finished-oldest", "2024-01-01T00:00:00.000Z", false),
    item("running-oldest", "2024-01-05T00:00:00.000Z", true),
    item("finished-newest", "2024-01-04T00:00:00.000Z", false),
  ]);
  assert.deepEqual(ids(result), [
    "finished-newest",
    "finished-oldest",
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

test("active-state transition: flipping a session from active to inactive moves it from bottom to top", () => {
  // Two running sessions ("newer-running" is the most recently started,
  // so it sits at the bottom of the running bucket) and one finished
  // session that pinned a long time ago.
  const before = sortFocusQueue([
    item("finished-old", "2024-01-01T00:00:00.000Z", false),
    item("running-older", "2024-01-02T00:00:00.000Z", true),
    item("running-newer", "2024-01-05T00:00:00.000Z", true),
  ]);
  assert.deepEqual(ids(before), [
    "finished-old",
    "running-older",
    "running-newer",
  ]);

  // "running-newer" finishes. In the same render the runtime poller
  // removes it from `activeSessionIds`, so the sidebar rebuilds the queue
  // with `active: false`. Because it has the most recent `lastActiveAt`
  // among all finished sessions, it must land at the top of the queue.
  const after = sortFocusQueue([
    item("finished-old", "2024-01-01T00:00:00.000Z", false),
    item("running-older", "2024-01-02T00:00:00.000Z", true),
    item("running-newer", "2024-01-05T00:00:00.000Z", false),
  ]);
  assert.deepEqual(ids(after), [
    "running-newer",
    "finished-old",
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
