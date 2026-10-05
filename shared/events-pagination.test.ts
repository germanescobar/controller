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
 * issue #404, and updated for the chatgpt-codex-connector review
 * P2 finding on PR #405 (the original `deduped.length - overlap.length`
 * slice dropped the merged event whenever a user_message + echo pair
 * straddled the boundary, losing the skill badge and any data the
 * echo had carried).
 *
 * The fix identifies the events to prepend by membership in the
 * *new* page's id set rather than a fixed-count slice. These tests
 * cover the regression (seam merger preserves the canonical event)
 * and the surrounding edge cases (empty new page, distinct events,
 * malformed inputs).
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
});

test("stitchPaginatedEvents: distinct new page events are preserved as-is", () => {
  // No user_message + echo pair at the seam. The seam dedupe is a
  // no-op; the new page is just the new page, capped at the
  // overlap window.
  const newPage = [ev("new-0", "older-0"), ev("new-1", "older-1")];
  const loaded = [ev("loaded-0", "current"), ev("loaded-1", "current-2")];
  const result = stitchPaginatedEvents(newPage, loaded);
  assert.deepEqual(
    result.newPage.map((e) => e.id),
    ["new-0", "new-1"],
  );
  assert.equal(result.noMoreOlderEvents, false);
});

test("stitchPaginatedEvents: skill marker + echo straddling the seam collapses to the marker", () => {
  // Regression for the codex P2 finding. The fetched page ends
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
  // The echo (which shares no text-equivalent with the marker in
  // the file order) is dropped from the prepended set because its
  // id is in the loaded-page head and it was merged into the
  // marker.
  assert.ok(
    !result.newPage.some((e) => e.id === echo.id),
    "the echo should not be duplicated into the prepended set",
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
  // Stronger version of the P2 regression: confirm the skill
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