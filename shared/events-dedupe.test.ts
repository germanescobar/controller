import test from "node:test";
import assert from "node:assert/strict";
import {
  sharedDedupeUserMessageEvents,
  sharedParseSkillMarker,
  type SharedAgentEvent,
} from "./events-dedupe.ts";

/*
 * Unit tests for the shared events-dedupe helpers used by both the
 * server's full-transcript endpoint and the client's paginated open
 * path (issue #404). These are the same rules the legacy
 * `dedupeUserMessageEvents` in `server/routes/sessions.ts` applied;
 * moving them here lets the client apply identical dedupe at the
 * page seam without duplicating the logic.
 *
 * The full suite of dedupe edge cases (orchestrator + agent echo,
 * skill-marker collapse in both orderings, distinct messages kept
 * apart, non-user_message passthrough, etc.) lives in
 * `server/lib/__tests__/user-message-dedupe.test.ts` — it imports
 * the re-exported names from `server/routes/sessions.ts` and runs
 * against this same module under the hood, so this file just adds
 * a couple of focused checks for the direct import path.
 */

function userMessage(
  text: string,
  overrides: Partial<SharedAgentEvent> = {}
): SharedAgentEvent {
  return {
    id: overrides.id ?? `id-${text.slice(0, 8)}`,
    sessionId: "s",
    timestamp: "2026-06-11T00:00:00.000Z",
    type: "user_message",
    data: { text },
    ...overrides,
  };
}

test("sharedParseSkillMarker extracts name and rest", () => {
  assert.deepEqual(
    sharedParseSkillMarker("[/skill: github-issues] Hello"),
    { skillName: "github-issues", rest: "Hello" },
  );
});

test("sharedDedupeUserMessageEvents collapses identical text", () => {
  const result = sharedDedupeUserMessageEvents([
    userMessage("hi", { id: "a" }),
    userMessage("hi", { id: "b" }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "a");
});

test("sharedDedupeUserMessageEvents preserves distinct messages", () => {
  const result = sharedDedupeUserMessageEvents([
    userMessage("first", { id: "a" }),
    userMessage("second", { id: "b" }),
  ]);
  assert.equal(result.length, 2);
});

test("sharedDedupeUserMessageEvents is a no-op on non-user_message events", () => {
  const assistant: SharedAgentEvent = {
    id: "a",
    sessionId: "s",
    timestamp: "2026-06-11T00:00:00.000Z",
    type: "assistant_response",
    data: { text: "hello" },
  };
  const result = sharedDedupeUserMessageEvents([assistant, userMessage("hi", { id: "u" })]);
  assert.equal(result.length, 2);
  assert.equal(result[0].type, "assistant_response");
});