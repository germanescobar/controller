import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent } from "../api.ts";
import { updateSessionTranscript, visibleSessionEvents } from "./session-transcript.ts";

function event(sessionId: string, id: string): AgentEvent {
  return { id, sessionId, timestamp: "2026-10-26T00:00:00Z", type: "assistant_response", data: { text: id } };
}

test("a new thread never displays events from another active session", () => {
  const active = { sessionId: "active", events: [event("active", "first")] };
  assert.deepEqual(visibleSessionEvents(active, undefined), []);
  assert.equal(updateSessionTranscript(active, undefined, "active", [event("active", "late")]), active);
});

test("concurrent session responses cannot replace the selected transcript", () => {
  const oldSession = { sessionId: "old", events: [event("old", "old-message")] };
  const selected = updateSessionTranscript(oldSession, "new", "new", [event("new", "new-message")]);
  const afterLateResponse = updateSessionTranscript(selected, "new", "old", [event("old", "late-message")]);
  assert.equal(afterLateResponse, selected);
  assert.deepEqual(visibleSessionEvents(afterLateResponse, "new").map((item) => item.id), ["new-message"]);
  assert.deepEqual(visibleSessionEvents(afterLateResponse, "old"), []);
});

test("new-session attachment accepts only its own transcript", () => {
  const empty = { sessionId: null, events: [] };
  const afterOtherSession = updateSessionTranscript(empty, "created", "active", [event("active", "foreign")]);
  const afterOwnSession = updateSessionTranscript(afterOtherSession, "created", "created", [event("created", "own")]);
  assert.deepEqual(visibleSessionEvents(afterOwnSession, "created").map((item) => item.id), ["own"]);
});

test("branched transcripts may contain copied events with their original session id", () => {
  const branch = updateSessionTranscript(
    { sessionId: null, events: [] },
    "branch",
    "branch",
    [event("source", "copied"), event("branch", "new")],
  );
  assert.deepEqual(visibleSessionEvents(branch, "branch").map((item) => item.id), ["copied", "new"]);
});
