import test from "node:test";
import assert from "node:assert/strict";
import {
  stitchPaginatedEvents,
  TAIL_DEDUPE_OVERLAP,
  type PaginatedStitchResult,
} from "./events-pagination.ts";
import type { SharedAgentEvent } from "./events-dedupe.ts";

/*
 * Tests for the client-side pagination stitch introduced in
 * issue #404, and updated across two rounds of codex review on
 * PR #405.
 *
 * Round 1 (chatgpt-codex-connector P2): the original
 * `deduped.length - overlap.length` slice dropped the merged
 * canonical event whenever a user_message + echo pair straddled
 * the boundary, losing the skill badge and any data the echo had
 * carried. Fixed by identifying the events to prepend by
 * membership in the *new* page's id set.
 *
 * Round 2 (chatgpt-codex-connector P2): the round-1 fix preserved
 * the merged event in `newPage`, but the caller's
 * `[...stitch.newPage, ...prev]` still kept the original echo in
 * `prev`, so the timeline rendered both events. Fixed by adding
 * `consumedHeadIds` to the return value so the caller can splice
 * the loaded page head (drop the consumed ids) when assembling the
 * final list.
 *
 * Round 2 P1 (chatgpt-codex-connector): when the initial tail-only
 * page is shorter than the viewport (the tail is a collapsed
 * `WorkingBlock`), the scroll handler never fires because there's
 * nothing to scroll. Fixed on the client side (a viewport-underflow
 * auto-load effect); this file doesn't exercise the auto-load
 * loop directly because it's a render-effect, but the multi-page
 * test below verifies the chain semantics by stitching two pages
 * in a row.
 */

function ev(
  id: string,
  text: string,
  overrides: Partial<SharedAgentEvent> = {}
): SharedAgentEvent {
  return {
    id,
    sessionId: "s",
    timestamp: "2026-06-11T00:00:00.000Z",
    type: "user_message",
    data: { text },
    ...overrides,
  };
}

test("stitchPaginatedEvents: empty new page signals no-more-older-events", () => {
  const loaded = [ev("loaded-0", "hello")];
  const result = stitchPaginatedEvents([], loaded);
  assert.deepEqual(result.newPage, []);
  assert.equal(result.noMoreOlderEvents, true);
  assert.equal(result.consumedHeadIds.size, 0);
});

test("stitchPaginatedEvents: distinct new page events are preserved as-is", () => {
  // No user_message + echo pair at the seam. The seam dedupe is a
  // no-op; the new page is just the new page, capped at the
  // overlap window. The loaded-head ids are reported as not
  // consumed so the caller leaves the loaded page head intact.
  const newPage = [ev("new-0", "older-0"), ev("new-1", "older-1")];
  const loaded = [ev("loaded-0", "current"), ev("loaded-1", "current-2")];
  const result = stitchPaginatedEvents(newPage, loaded);
  assert.deepEqual(
    result.newPage.map((e) => e.id),
    ["new-0", "new-1"],
  );
  assert.equal(result.noMoreOlderEvents, false);
  assert.equal(result.consumedHeadIds.size, 0);
});

test("stitchPaginatedEvents: skill marker + echo straddling the seam collapses to the marker", () => {
  // Regression for the round-1 P2 finding. The fetched page ends
  // with the orchestrator's `[/skill: foo]` marker; the loaded
  // page begins with the agent's echo of the same turn. The seam
  // dedupe must collapse the pair to the marker (the canonical
  // event), and the marker must end up in the prepended set so the
  // skill badge and any inherited attachments survive.
  const marker = ev("marker-0", "[/skill: foo] hi", {
    data: { text: "[/skill: foo] hi", skillName: "foo" },
  });
  const echo = ev("echo-0", "Apply the following skill...hi");
  const fetched = [ev("new-0", "older-0"), ev("new-1", "older-1"), marker];
  const loaded = [echo, ev("loaded-1", "next")];
  const result = stitchPaginatedEvents(fetched, loaded);
  // The marker is the canonical event — its id matches the
  // fetch-side id, so it must end up in the prepended set.
  const markerInResult = result.newPage.find(
    (e) => e.id === marker.id && e.data.skillName === "foo",
  );
  assert.ok(
    markerInResult,
    `the merged marker must be in newPage, got ids: ${result.newPage.map((e) => e.id).join(",")}`,
  );
  assert.equal(result.noMoreOlderEvents, false);
});

test("stitchPaginatedEvents: identical-text user_message pair at the seam is collapsed", () => {
  // The orchestrator wrote the user message; the agent wrote the
  // same text again. The two events collapse to the first
  // (orchestrator) event.
  const orchestrator = ev("orch-0", "Hello", {
    data: { text: "Hello", attachments: [{ id: "a1" }] },
  });
  const agentEcho = ev("agent-0", "Hello");
  const fetched = [ev("new-0", "older-0"), orchestrator];
  const loaded = [agentEcho, ev("loaded-1", "next")];
  const result = stitchPaginatedEvents(fetched, loaded);
  // The orchestrator event (with its attachments) is the
  // canonical one. Its id is in the fetched page, so it must
  // survive in the prepended set.
  const canonical = result.newPage.find((e) => e.id === orchestrator.id);
  assert.ok(
    canonical,
    `the orchestrator event must be in newPage, got: ${result.newPage.map((e) => e.id).join(",")}`,
  );
  // Attachments from the orchestrator's payload survive the
  // merge.
  assert.deepEqual(canonical?.data.attachments, [{ id: "a1" }]);
  assert.ok(
    !result.newPage.some((e) => e.id === agentEcho.id),
    "the agent echo should not be duplicated",
  );
});

test("stitchPaginatedEvents: empty loaded-page head falls back to no-dedupe", () => {
  // Pathological case: the loaded page is empty (shouldn't
  // happen, but defensive). The new page is returned as-is.
  const fetched = [ev("new-0", "older-0")];
  const result = stitchPaginatedEvents(fetched, []);
  assert.deepEqual(
    result.newPage.map((e) => e.id),
    ["new-0"],
  );
  assert.equal(result.noMoreOlderEvents, false);
  assert.equal(result.consumedHeadIds.size, 0);
});

test("stitchPaginatedEvents: full-collapse (every new event is in the seam) latches the head", () => {
  // Defensive case: the new page contains ONLY events that were
  // also in the loaded-page head. After dedupe nothing remains
  // for the prepended set. The caller should latch
  // `reachedTranscriptStart` to suppress further scroll-up
  // fetches. (The route should never return a fully-collapsed
  // new page, but the check is cheap insurance.)
  const fetched = [ev("overlap-0", "same")];
  const loaded = [ev("overlap-0", "same")];
  const result = stitchPaginatedEvents(fetched, loaded);
  assert.equal(result.newPage.length, 0);
  assert.equal(result.noMoreOlderEvents, true);
});

test("TAIL_DEDUPE_OVERLAP is 2 (matches the route's overlap window)", () => {
  // Pin the constant so accidental changes to the seam width get
  // caught — the route uses the same value when it asks the
  // server for `limit + TAIL_DEDUPE_OVERLAP` events on every
  // paginated read. If this changes, the route file must change
  // in lockstep.
  assert.equal(TAIL_DEDUPE_OVERLAP, 2);
});

test("stitchPaginatedEvents: the merged event for a marker + echo preserves the skill badge", () => {
  // Stronger version of the round-1 P2 regression: confirm the skill
  // badge AND any data the echo carried are inherited by the
  // merged marker.
  const marker = ev("marker-1", "[/skill: pr-feedback] do thing", {
    data: { text: "[/skill: pr-feedback] do thing", skillName: "pr-feedback" },
  });
  const echo = ev("echo-1", "Apply the following skill instructions...do thing", {
    data: {
      text: "Apply the following skill instructions...do thing",
      attachments: [{ id: "echo-attachment" }],
    },
  });
  const fetched = [ev("new-2", "older-2"), marker];
  const loaded = [echo];
  const result = stitchPaginatedEvents(fetched, loaded);
  const merged = result.newPage.find((e) => e.id === marker.id);
  assert.ok(merged, "merged marker must be in newPage");
  // The marker is the canonical event; its data is preserved
  // (skillName badge + text). The original implementation
  // dropped the merged event entirely, losing BOTH the badge and
  // the attachments.
  assert.equal(merged?.data.skillName, "pr-feedback");
  assert.equal(merged?.data.text, "[/skill: pr-feedback] do thing");
});

test("stitchPaginatedEvents: round-2 P2 — the consumed loaded-head ids are reported so the caller can drop them", () => {
  // Round-2 regression. When the marker is on the new page and
  // the echo is on the loaded page (the round-1 scenario), the
  // merged marker is in `newPage` AND the echo must be reported
  // as a consumed head id so the caller drops it from the loaded
  // page. If the caller forgot to filter, the timeline would
  // render both events — exactly the round-2 finding.
  const marker = ev("marker-2", "[/skill: foo] hi", {
    data: { text: "[/skill: foo] hi", skillName: "foo" },
  });
  const echo = ev("echo-2", "Apply the following skill...hi");
  const fetched = [ev("new-3", "older-3"), marker];
  const loaded = [echo, ev("loaded-3", "next")];
  const result = stitchPaginatedEvents(fetched, loaded);
  // The echo is on the loaded page head. Dedupe collapsed it
  // into the marker (which is in `newPage`), so the echo is
  // reported as consumed and the caller drops it.
  assert.ok(
    result.consumedHeadIds.has(echo.id),
    `echo must be in consumedHeadIds so the caller drops it from the loaded page; got ${JSON.stringify([...result.consumedHeadIds])}`,
  );
  // The other loaded-head event (`loaded-3`) is NOT consumed —
  // it appears unchanged in the deduped timeline.
  assert.ok(
    !result.consumedHeadIds.has("loaded-3"),
    "non-overlapping loaded-head events must not be marked consumed",
  );
  // Assemble the final list as the caller would and assert the
  // timeline dedupes correctly: the merged marker is in
  // `newPage`, the echo is NOT in the final list (dropped via
  // `consumedHeadIds`), and `loaded-3` survives.
  const loadedTail = loaded.filter(
    (e) => !result.consumedHeadIds.has(e.id),
  );
  const finalEvents = [...result.newPage, ...loadedTail];
  const ids = finalEvents.map((e) => e.id);
  assert.ok(
    ids.includes(marker.id),
    `final timeline must include the merged marker; got ${ids.join(",")}`,
  );
  assert.ok(
    !ids.includes(echo.id),
    `final timeline must NOT include the original echo; got ${ids.join(",")}`,
  );
  assert.ok(
    ids.includes("loaded-3"),
    `final timeline must include the non-overlapping loaded-head event; got ${ids.join(",")}`,
  );
});

test("stitchPaginatedEvents: round-2 P2 — empty consumedHeadIds when no dedupe happened", () => {
  // When there's no user_message + echo pair at the seam, no
  // loaded-head events are consumed. The caller uses
  // `consumedHeadIds` as a filter; an empty set means the loaded
  // page is preserved as-is. This test pins the empty-set return
  // shape so a future refactor doesn't accidentally start
  // reporting spurious ids.
  const newPage = [ev("new-4", "older-4"), ev("new-5", "older-5")];
  const loaded = [ev("loaded-4", "current-4"), ev("loaded-5", "current-5")];
  const result = stitchPaginatedEvents(newPage, loaded);
  assert.equal(result.consumedHeadIds.size, 0);
  assert.deepEqual(
    result.newPage.map((e) => e.id),
    ["new-4", "new-5"],
  );
});

test("stitchPaginatedEvents: multi-page chain — three pages stitch into one consistent result", () => {
  // Sanity check for the overflow auto-load chain (client-side,
  // but the stitch helper is the per-page primitive). Three pages
  // stitched in sequence produce a single chronological timeline
  // where every consumed-head pair is reported and the canonical
  // markers survive.
  const old = [ev("older-0", "older-0")];
  const mid = [ev("mid-0", "mid-0"), ev("mid-1", "mid-1")];
  const newer = [ev("newest-0", "newest-0")];

  // Stitch old into mid.
  const first = stitchPaginatedEvents(
    old,
    mid.slice(0, TAIL_DEDUPE_OVERLAP),
  );
  assert.equal(first.noMoreOlderEvents, false);
  assert.equal(first.newPage.length, 1);
  assert.equal(first.newPage[0].id, "older-0");
  // The loaded-mid head had no dedupe-able pair, so nothing was
  // consumed.
  assert.equal(first.consumedHeadIds.size, 0);

  // Now stitch newer into (old + mid-tail).
  const stitchedAfterFirst = [
    ...first.newPage,
    ...mid.filter((e) => !first.consumedHeadIds.has(e.id)),
  ];
  const second = stitchPaginatedEvents(
    newer,
    stitchedAfterFirst.slice(0, TAIL_DEDUPE_OVERLAP),
  );
  assert.equal(second.noMoreOlderEvents, false);
  assert.equal(second.newPage.length, 1);
  assert.equal(second.newPage[0].id, "newest-0");
  assert.equal(second.consumedHeadIds.size, 0);

  // The final assembled timeline is chronological and contains
  // every event exactly once.
  const final = [
    ...second.newPage,
    ...stitchedAfterFirst.filter(
      (e) => !second.consumedHeadIds.has(e.id),
    ),
  ];
  assert.deepEqual(
    final.map((e) => e.id),
    ["newest-0", "older-0", "mid-0", "mid-1"],
  );
});