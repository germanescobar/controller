import test from "node:test";
import assert from "node:assert/strict";
import {
  pickFirstFocusItem,
  pickNextFocusItem,
  type FocusQueueItemLike,
} from "./focus-advance.ts";

function item(
  id: string,
  lastActiveAt: string,
  overrides: Partial<Omit<FocusQueueItemLike, "session">> = {},
): FocusQueueItemLike {
  return {
    session: { id, lastActiveAt },
    projectId: "proj-1",
    worktreeId: "wt-1",
    projectName: "Test",
    worktreeName: "main",
    ...overrides,
  };
}

test("pickNextFocusItem returns null for an empty queue", () => {
  assert.equal(pickNextFocusItem([], "any", 0), null);
});

test("pickFirstFocusItem selects the top row when the current session is last", () => {
  const queue = [
    item("first", "2024-01-01T00:00:00.000Z"),
    item("second", "2024-01-02T00:00:00.000Z"),
    item("current", "2024-01-03T00:00:00.000Z"),
  ];
  assert.equal(pickFirstFocusItem(queue, "current")?.session.id, "first");
});

test("pickFirstFocusItem selects the top row when the current session is second-to-last", () => {
  const queue = [
    item("first", "2024-01-01T00:00:00.000Z"),
    item("current", "2024-01-02T00:00:00.000Z"),
    item("last", "2024-01-03T00:00:00.000Z"),
  ];
  assert.equal(pickFirstFocusItem(queue, "current")?.session.id, "first");
});

test("pickFirstFocusItem skips the current session when it is the top row", () => {
  const queue = [
    item("current", "2024-01-01T00:00:00.000Z"),
    item("second", "2024-01-02T00:00:00.000Z"),
  ];
  assert.equal(pickFirstFocusItem(queue, "current")?.session.id, "second");
  assert.equal(pickFirstFocusItem([queue[0]], "current"), null);
});

test("pickNextFocusItem stays put on a queue of one (sent-from IS the only item)", () => {
  // The single-item queue. Sending from the only pinned session
  // should NOT navigate — the user would just get bounced.
  const queue = [item("s1", "2024-01-01T00:00:00.000Z")];
  assert.equal(pickNextFocusItem(queue, "s1", 0), null);
});

test("pickNextFocusItem advances circularly when there are no recently-finished items", () => {
  // `lastInteractionAt = 0` means "never interacted yet" — the
  // recently-finished bucket is empty and we fall through to plain
  // circular advance.
  const s1 = item("s1", "2024-01-01T00:00:00.000Z");
  const s2 = item("s2", "2024-01-02T00:00:00.000Z");
  const s3 = item("s3", "2024-01-03T00:00:00.000Z");
  const queue = [s1, s2, s3];
  // Sent from s1 -> s2
  assert.equal(pickNextFocusItem(queue, "s1", 0), s2);
  // Sent from s2 -> s3
  assert.equal(pickNextFocusItem(queue, "s2", 0), s3);
  // Sent from s3 (last) -> wraps to s1
  assert.equal(pickNextFocusItem(queue, "s3", 0), s1);
});

test("pickNextFocusItem treats sent-from-not-in-queue as 'before index 0'", () => {
  // User manually navigated to an unpinned session "external" and
  // sent a message from it. We should still advance, starting from
  // index 0.
  const queue = [
    item("s1", "2024-01-01T00:00:00.000Z"),
    item("s2", "2024-01-02T00:00:00.000Z"),
  ];
  const next = pickNextFocusItem(queue, "external", 0);
  assert.equal(next?.session.id, "s1");
});

test("pickNextFocusItem surfaces the recently-finished bucket before plain circular advance", () => {
  // The user last interacted at t1. Hello 1 finished at t2 (after
  // the previous interaction), so it's a fresh finish that should be
  // answered first. The queue also has older running sessions below
  // it. Hello 1 is *visited* (the user already saw this finish),
  // so it falls into the recently-finished bucket, not the
  // unvisited triage pile.
  const queue = [
    item("running-oldest", "2024-01-01T00:00:00.000Z", { active: true }),
    item("hello-1", "2024-01-05T00:00:00.000Z", {
      lastVisitedAt: "2024-01-05T00:01:00.000Z",
    }), // finished at t2 > t1, visited
    item("running-newest", "2024-01-02T00:00:00.000Z", { active: true }),
  ];
  // Pretend the user is on an external session. They want to land on
  // the freshest finished (Hello 1) before resuming the running ones.
  const next = pickNextFocusItem(queue, "external", Date.parse("2024-01-04T00:00:00.000Z"));
  assert.equal(next?.session.id, "hello-1");
});

test("pickNextFocusItem walks recently-finished FIFO", () => {
  // Two items finished since the watermark; the algorithm should
  // return the OLDEST-arrival one first. Because the queue is
  // already sorted by `sortFocusQueue` (oldest-arrival at the top of
  // the finished block), a linear scan in array order naturally
  // surfaces the oldest-arrival first. Both items are *visited* so
  // they fall into the recently-finished bucket, not the unvisited
  // triage pile.
  const queue = [
    item("finished-older", "2024-01-05T00:00:00.000Z", {
      lastVisitedAt: "2024-01-05T00:01:00.000Z",
    }), // finished after watermark, oldest-arrival, visited
    item("finished-newer", "2024-01-06T00:00:00.000Z", {
      lastVisitedAt: "2024-01-06T00:01:00.000Z",
    }), // finished after watermark, newer-arrival, visited
    item("running", "2024-01-01T00:00:00.000Z", { active: true }),
  ];
  // First advance: walks the older of the two fresh finishes.
  const first = pickNextFocusItem(queue, "external", Date.parse("2024-01-04T00:00:00.000Z"));
  assert.equal(first?.session.id, "finished-older");
  // After the user interacts (watermark bumped past finished-older),
  // the next freshest is finished-newer.
  const second = pickNextFocusItem(queue, "finished-older", Date.parse("2024-01-05T00:01:00.000Z"));
  assert.equal(second?.session.id, "finished-newer");
});

test("pickNextFocusItem excludes active sessions from recently-finished", () => {
  const queue = [
    item("finished", "2024-01-05T00:00:00.000Z", {
      lastVisitedAt: "2024-01-05T00:01:00.000Z",
    }),
    item("running-fresh", "2024-01-06T00:00:00.000Z", {
      active: true,
    }),
    item("sent-from", "2024-01-03T00:00:00.000Z", {
      lastVisitedAt: "2024-01-03T00:01:00.000Z",
    }),
  ];
  const next = pickNextFocusItem(
    queue,
    "sent-from",
    Date.parse("2024-01-04T00:00:00.000Z"),
  );
  assert.equal(next?.session.id, "finished");
});

test("pickNextFocusItem skips the sent-from session in the recently-finished bucket", () => {
  // The user is currently on a session that's also the only
  // recently-finished item. We must NOT bounce them back to it.
  const queue = [
    item("fresh", "2024-01-05T00:00:00.000Z"), // finished after watermark
    item("running", "2024-01-01T00:00:00.000Z", { active: true }),
  ];
  const next = pickNextFocusItem(queue, "fresh", Date.parse("2024-01-04T00:00:00.000Z"));
  // No unvisited finished, no other fresh finished. Plain circular
  // from "fresh" (index 0) -> index 1 -> "running".
  assert.equal(next?.session.id, "running");
});

test("pickNextFocusItem falls through to plain circular when the recently-finished bucket is exhausted", () => {
  // The recently-finished item is also the sent-from session. After
  // we skip it, no other fresh finished exists, so we wrap around
  // to the next item in queue order (the running one).
  const queue = [
    item("fresh-sent-from", "2024-01-05T00:00:00.000Z"),
    item("running-oldest", "2024-01-01T00:00:00.000Z", { active: true }),
    item("running-newest", "2024-01-02T00:00:00.000Z", { active: true }),
  ];
  const next = pickNextFocusItem(queue, "fresh-sent-from", Date.parse("2024-01-04T00:00:00.000Z"));
  // No unvisited finished (running items skip the unvisited
  // bucket). No other fresh finished. Plain circular from
  // "fresh-sent-from" (not in queue) -> index 0 -> "fresh-sent-from",
  // but that's sent-from so we move on -> index 1 -> "running-oldest".
  assert.equal(next?.session.id, "running-oldest");
});

test("pickNextFocusItem wraps when the only item also matches sent-from", () => {
  // Defensive: if the queue somehow contains the same id the user
  // sent from but other items exist (shouldn't happen with the
  // current dedupe rules, but stay safe), we still skip past it.
  const queue = [
    item("s1", "2024-01-01T00:00:00.000Z"),
    item("s2", "2024-01-02T00:00:00.000Z"),
    item("s1", "2024-01-03T00:00:00.000Z"),
  ];
  const next = pickNextFocusItem(queue, "s1", 0);
  // startIndex is 0 (first match), nextIndex wraps to 1
  assert.equal(next?.session.id, "s2");
});

// ---------------------------------------------------------------------------
// Awaiting-input priority (issue #333 follow-up).
//
// Sessions whose agent has paused on a `user.input_requested` prompt
// or has a pending tool approval are the most urgent items on the
// radar and must win over the recently-finished bucket. The flag is
// independent of `active`: Claude's structured-input pause kills the
// child so the session can be inactive and still awaiting.
// ---------------------------------------------------------------------------

test("awaiting-input bucket wins over the recently-finished bucket", () => {
  // A finished item is in the recently-finished bucket; an awaiting
  // item is fresh and active. The awaiting one wins regardless of
  // `lastInteractionAt`.
  const queue = [
    item("finished", "2024-01-05T00:00:00.000Z", { awaitingInput: false }),
    item("awaiting", "2024-01-04T00:00:00.000Z", { awaitingInput: true }),
  ];
  const next = pickNextFocusItem(queue, "external", Date.parse("2024-01-04T00:00:00.000Z"));
  assert.equal(next?.session.id, "awaiting");
});

test("awaiting-input wins even when the user just interacted (lastInteractionAt = now)", () => {
  // The freshly-finished item finished at t > lastInteractionAt, so
  // it's in the recently-finished bucket. The awaiting item is
  // older-arrival but still wins.
  const queue = [
    item("finished-just-now", "2024-01-05T00:00:00.000Z", {
      awaitingInput: false,
    }),
    item("awaiting", "2024-01-01T00:00:00.000Z", { awaitingInput: true }),
  ];
  const next = pickNextFocusItem(queue, "external", Date.parse("2024-01-04T00:00:00.000Z"));
  assert.equal(next?.session.id, "awaiting");
});

test("awaiting-input is independent of active: a paused (inactive) session can still await", () => {
  // Claude's structured-input pause kills the child, so the runtime
  // reports `active: false` but the user still owes a reply. The
  // sort and advance logic both treat the flag as a separate
  // signal, so this session still wins.
  const queue = [
    item("finished", "2024-01-05T00:00:00.000Z", { awaitingInput: false }),
    item("paused-awaiting-input", "2024-01-04T00:00:00.000Z", {
      active: false,
      awaitingInput: true,
    }),
  ];
  const next = pickNextFocusItem(queue, "external", Date.parse("2024-01-04T00:00:00.000Z"));
  assert.equal(next?.session.id, "paused-awaiting-input");
});

test("the awaiting-input bucket is skipped when the only awaiting item IS the sent-from session", () => {
  // The user is currently looking at a paused session awaiting
  // input. They hit Next expecting to move on, but there's nothing
  // else awaiting. Fall through to recently-finished, then plain
  // circular — the running one is the natural next stop.
  const queue = [
    item("paused-awaiting-input", "2024-01-04T00:00:00.000Z", {
      active: false,
      awaitingInput: true,
    }),
    item("finished", "2024-01-05T00:00:00.000Z", { awaitingInput: false }),
    item("running", "2024-01-01T00:00:00.000Z", { active: true }),
  ];
  const next = pickNextFocusItem(queue, "paused-awaiting-input", Date.parse("2024-01-04T00:00:00.000Z"));
  // No other awaiting item, no fresh finished. Plain circular from
  // "paused-awaiting-input" (index 0) -> index 1 -> "finished".
  // That's the natural next stop in the user's queue — but the
  // "finished" bucket item is older than the watermark so the
  // recently-finished check misses it. So fall through to plain
  // circular -> "finished" -> next wrap -> "running" -> wrap -> self.
  // startIndex = 0, nextIndex = 1 -> "finished", id !== sent-from,
  // return "finished".
  assert.equal(next?.session.id, "finished");
});

test("multiple awaiting-input sessions are walked in array order", () => {
  // sortFocusQueue is responsible for the *array* order (oldest
  // arrival first within the awaiting bucket); the algorithm just
  // returns the first match.
  const queue = [
    item("awaiting-newer", "2024-01-05T00:00:00.000Z", {
      awaitingInput: true,
    }),
    item("awaiting-older", "2024-01-04T00:00:00.000Z", {
      awaitingInput: true,
    }),
  ];
  const next = pickNextFocusItem(queue, "external", 0);
  assert.equal(next?.session.id, "awaiting-newer");
});

// ---------------------------------------------------------------------------
// Unvisited-finished bucket priority (issue #333 follow-up #2).
//
// When the user presses Next from any session, the queue should
// re-surface the top of the *unvisited triage pile* (finished but
// never opened) before walking through the visited/finished or
// running blocks. Without this priority, plain circular advance
// walks the array in order — unvisited → visited → running — and
// lands on the second-to-last item when the user is on a visited
// session in the middle of the visited block.
// ---------------------------------------------------------------------------

test("unvisited-finished bucket wins when sent-from is on a visited-finished session", () => {
  // The user is on a visited-finished session in the middle of the
  // visited block. They press Next. The expected behavior is to
  // jump to the top of the unvisited triage pile, NOT to the next
  // item in array order (which would be the next visited session).
  const queue = [
    item("unvisited-top", "2024-01-01T00:00:00.000Z"), // unvisited, top of queue
    item("unvisited-mid", "2024-01-02T00:00:00.000Z"), // unvisited
    item("visited-sent-from", "2024-01-05T00:00:00.000Z", {
      lastVisitedAt: "2024-01-06T00:00:00.000Z",
    }),
    item("visited-next", "2024-01-04T00:00:00.000Z", {
      lastVisitedAt: "2024-01-07T00:00:00.000Z",
    }),
    item("visited-last", "2024-01-03T00:00:00.000Z", {
      lastVisitedAt: "2024-01-08T00:00:00.000Z",
    }),
  ];
  const next = pickNextFocusItem(queue, "visited-sent-from", 0);
  assert.equal(next?.session.id, "unvisited-top");
});

test("unvisited-finished bucket wins when sent-from is on a running session", () => {
  // The user is currently on a running session. Pressing Next
  // should re-surface the unvisited triage pile rather than
  // bouncing between running sessions.
  const queue = [
    item("unvisited", "2024-01-01T00:00:00.000Z"),
    item("running-sent-from", "2024-01-05T00:00:00.000Z", { active: true }),
    item("running-other", "2024-01-06T00:00:00.000Z", { active: true }),
  ];
  const next = pickNextFocusItem(queue, "running-sent-from", 0);
  assert.equal(next?.session.id, "unvisited");
});

test("unvisited-finished bucket skips the sent-from session", () => {
  // The user is on the top unvisited item. Pressing Next should
  // skip them and land on the next unvisited, or fall through if
  // they're the only one.
  const queue = [
    item("only-unvisited-sent-from", "2024-01-01T00:00:00.000Z"),
    item("visited", "2024-01-02T00:00:00.000Z", {
      lastVisitedAt: "2024-01-05T00:00:00.000Z",
    }),
  ];
  const next = pickNextFocusItem(queue, "only-unvisited-sent-from", 0);
  // Skip sent-from, no other unvisited, no recently-finished
  // (watermark=0), plain circular -> visited.
  assert.equal(next?.session.id, "visited");
});

test("unvisited-finished bucket walks in array order (FIFO)", () => {
  // sortFocusQueue puts oldest-arrival first within the unvisited
  // bucket; the algorithm walks in array order.
  const queue = [
    item("u-oldest", "2024-01-01T00:00:00.000Z"),
    item("u-newest", "2024-01-05T00:00:00.000Z"),
  ];
  const next = pickNextFocusItem(queue, "external", 0);
  assert.equal(next?.session.id, "u-oldest");
});

test("unvisited-finished bucket is skipped when sent-from is the only unvisited", () => {
  // The user is on the only unvisited finished session. They press
  // Next — should not bounce back to themselves. Falls through to
  // plain circular.
  const queue = [
    item("only-unvisited", "2024-01-01T00:00:00.000Z"),
    item("visited-1", "2024-01-02T00:00:00.000Z", {
      lastVisitedAt: "2024-01-03T00:00:00.000Z",
    }),
    item("visited-2", "2024-01-03T00:00:00.000Z", {
      lastVisitedAt: "2024-01-04T00:00:00.000Z",
    }),
  ];
  const next = pickNextFocusItem(queue, "only-unvisited", 0);
  // No unvisited (only one, skipped). No recently-finished
  // (watermark=0). Plain circular from index 0 -> 1 -> "visited-1".
  assert.equal(next?.session.id, "visited-1");
});

test("awaiting wins over unvisited-finished (the most urgent triage item wins)", () => {
  // Awaiting-input is the most urgent state. The unvisited
  // triage pile is also urgent but a session awaiting the user's
  // reply needs the user's attention *right now*. Awaiting wins.
  const queue = [
    item("unvisited", "2024-01-01T00:00:00.000Z"),
    item("awaiting", "2024-01-02T00:00:00.000Z", {
      awaitingInput: true,
      active: false,
    }),
  ];
  const next = pickNextFocusItem(queue, "external", 0);
  assert.equal(next?.session.id, "awaiting");
});

test("user's bug: Next from the second-to-last visited session lands on top of unvisited", () => {
  // The exact scenario from the bug report: after visiting two
  // sessions ("I want to update" then "I have a session" — or
  // vice versa), the visited block sits at the bottom of the
  // queue and the user lands on the second-to-last item. Plain
  // circular advance would walk to the last item (the most
  // recently visited) — but the user expects Next to jump to the
  // top of the unvisited triage pile.
  //
  // Pre-fix: actual = "visited-last" (the second-to-last entry,
  // which the user described as "next to last" / "penúltimo").
  // Post-fix: actual = "unvisited-top".
  const queue = [
    item("unvisited-top", "2024-01-01T00:00:00.000Z"),
    item("unvisited-mid", "2024-01-02T00:00:00.000Z"),
    item("unvisited-third", "2024-01-03T00:00:00.000Z"),
    item("unvisited-fourth", "2024-01-04T00:00:00.000Z"),
    // visited block (older-lastVisitedAt first, since FIFO within
    // the visited block in sortFocusQueue).
    item("visited-second", "2024-01-06T00:00:00.000Z", {
      lastVisitedAt: "2024-01-09T00:00:00.000Z",
    }), // user is here (second-to-last = penúltimo)
    item("visited-newest", "2024-01-05T00:00:00.000Z", {
      lastVisitedAt: "2024-01-10T00:00:00.000Z",
    }), // last in array
  ];
  const next = pickNextFocusItem(queue, "visited-second", 0);
  assert.equal(next?.session.id, "unvisited-top");
});

test("user's bug: Next from the running session at the bottom lands on top of unvisited", () => {
  // The running session (Controller - Redesign queue) is at the
  // bottom of the user's queue. Pressing Next from it should
  // jump to the top of unvisited, NOT wrap to idx 0's next-in-
  // array-order neighbor (which would be the second visited).
  const queue = [
    item("unvisited-top", "2024-01-01T00:00:00.000Z"),
    item("unvisited-mid", "2024-01-02T00:00:00.000Z"),
    item("unvisited-third", "2024-01-03T00:00:00.000Z"),
    item("unvisited-fourth", "2024-01-04T00:00:00.000Z"),
    item("visited-first", "2024-01-05T00:00:00.000Z", {
      lastVisitedAt: "2024-01-09T00:00:00.000Z",
    }),
    item("visited-second", "2024-01-06T00:00:00.000Z", {
      lastVisitedAt: "2024-01-10T00:00:00.000Z",
    }),
    item("running", "2024-01-07T00:00:00.000Z", { active: true }), // user is here
  ];
  const next = pickNextFocusItem(queue, "running", 0);
  assert.equal(next?.session.id, "unvisited-top");
});

test("Next from a visited session walks forward when the just-visited session reshuffles to the visited bucket", () => {
  // After visiting u0 and u1, the queue is:
  //   unvisited: [u2, u3, u4]
  //   visited:   [u0, u1] (sorted by lastVisitedAt asc)
  // User is on u1 (just visited, idx 4 in the reshuffled queue).
  // My fix should walk forward to u2 (the next oldest-arrival
  // unvisited), NOT jump back to u0.
  const queue = [
    item("u2", "2024-01-01T00:00:00.000Z"), // oldest-arrival unvisited
    item("u3", "2024-01-02T00:00:00.000Z"),
    item("u4", "2024-01-03T00:00:00.000Z"),
    item("u0", "2024-01-04T00:00:00.000Z", {
      lastVisitedAt: "2024-01-09T00:00:00.000Z",
    }), // visited first
    item("u1", "2024-01-05T00:00:00.000Z", {
      lastVisitedAt: "2024-01-10T00:00:00.000Z",
    }), // user is here (just visited)
    item("v0", "2024-01-06T00:00:00.000Z", {
      lastVisitedAt: "2024-01-07T00:00:00.000Z",
    }),
    item("v1", "2024-01-07T00:00:00.000Z", {
      lastVisitedAt: "2024-01-08T00:00:00.000Z",
    }),
  ];
  const next = pickNextFocusItem(queue, "u1", 0);
  assert.equal(next?.session.id, "u2");
});
test("starting fresh (sentFromSessionId = '') ignores persisted visited state on the first click", () => {
  // After a reload, `visitedAt` is hydrated from localStorage. Every
  // pinned session looks visited, so the unvisited bucket is empty
  // and the algorithm falls through to plain circular — which
  // returns the visually-first item (idx 0) anyway, but only as a
  // happy accident. The user expects "click Next from the empty
  // state = start triaging from the visual top," so we make the
  // fresh-start case explicit: ignore the visited filter when
  // `sentFromSessionId === ""`.
  //
  // The fresh-start exemption also fixes the case where the
  // visually-first item is a running session (skipped by the
  // active filter) — we land on the first non-running item
  // instead. Subsequent clicks have a non-empty sent-from and
  // respect the visited state normally.
  const queue = [
    item("u0", "2024-01-01T00:00:00.000Z", {
      lastVisitedAt: "2024-01-09T00:00:00.000Z",
    }), // visited from the previous session
    item("u1", "2024-01-02T00:00:00.000Z", {
      lastVisitedAt: "2024-01-10T00:00:00.000Z",
    }), // visited from the previous session
    item("u2", "2024-01-03T00:00:00.000Z"), // truly unvisited
  ];
  const next = pickNextFocusItem(queue, "", 0);
  assert.equal(next?.session.id, "u0");
});

test("starting fresh skips a running session at the visual top", () => {
  // If the visually-first item is currently running (e.g. the user
  // just got back from lunch and a fresh agent is working), we
  // shouldn't bounce them into it on the first Next. Skip
  // running items even on fresh start.
  const queue = [
    item("running-top", "2024-01-01T00:00:00.000Z", { active: true }),
    item("running-other", "2024-01-02T00:00:00.000Z", { active: true }),
    item("u2", "2024-01-03T00:00:00.000Z"),
  ];
  const next = pickNextFocusItem(queue, "", 0);
  assert.equal(next?.session.id, "u2");
});

test("after the fresh-start click, subsequent clicks respect the visited state", () => {
  // Once the user has clicked Next once from the empty state,
  // `sentFromSessionId` is the session they landed on (non-empty).
  // From then on, the visited-state filter applies as before:
  // pressing Next from a visited middle item jumps to the top of
  // unvisited, not the visually-first item.
  //
  // Here the user has just landed on "u0" (the fresh-start top,
  // visited via the just-completed click). The next click should
  // walk forward to "u1" — *not* return to "u0" because the
  // fresh-start exemption no longer applies.
  const queue = [
    item("u0", "2024-01-01T00:00:00.000Z", {
      lastVisitedAt: "2024-02-01T00:00:00.000Z",
    }), // visited just now
    item("u1", "2024-01-02T00:00:00.000Z", {
      lastVisitedAt: "2024-02-02T00:00:00.000Z",
    }), // visited previously
    item("u2", "2024-01-03T00:00:00.000Z"), // truly unvisited
  ];
  const next = pickNextFocusItem(queue, "u0", Date.now());
  assert.equal(next?.session.id, "u2");
});
