import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent } from "../api.ts";
import { pendingMessageAfterRefresh, updateSessionTranscript, visibleSessionEvents } from "./session-transcript.ts";

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

test("an optimistic user turn survives completion until the persisted transcript arrives", () => {
  const beforeRefresh = [event("active", "assistant-before")];
  const pending = "Done";
  assert.equal(pendingMessageAfterRefresh(pending, beforeRefresh), pending);

  const afterRefresh: AgentEvent[] = [
    ...beforeRefresh,
    { id: "user-done", sessionId: "active", timestamp: "2026-10-26T00:00:01Z", type: "user_message", data: { text: pending } },
    event("active", "assistant-after"),
  ];
  assert.equal(pendingMessageAfterRefresh(pending, afterRefresh), null);
  assert.equal(afterRefresh.filter((item) => item.type === "user_message" && item.data.text === pending).length, 1);
});

test("a queued or steered user turn does not settle a different pending message", () => {
  const events: AgentEvent[] = [
    { id: "steer", sessionId: "active", timestamp: "2026-10-26T00:00:01Z", type: "user_message", data: { text: "Done" } },
  ];
  assert.equal(pendingMessageAfterRefresh("Next task", events), "Next task");
  assert.equal(pendingMessageAfterRefresh("Done", events), null);
  assert.equal(pendingMessageAfterRefresh("Done", events, "steer"), "Done");
  const queued: AgentEvent = {
    id: "queued", sessionId: "active", timestamp: "2026-10-26T00:00:02Z",
    type: "user_message", data: { text: "Done" },
  };
  assert.equal(pendingMessageAfterRefresh("Done", [...events, queued], "steer"), null);
});

test("an earlier identical message cannot hide or settle a newly sent turn", () => {
  const previous: AgentEvent = {
    id: "previous-done", sessionId: "active", timestamp: "2026-10-26T00:00:00Z",
    type: "user_message", data: { text: "Done" },
  };
  assert.equal(pendingMessageAfterRefresh("Done", [previous], previous.id), "Done");
  assert.equal(pendingMessageAfterRefresh("Done", [previous, event("active", "reply")], previous.id), "Done");
  const current: AgentEvent = { ...previous, id: "current-done" };
  assert.equal(pendingMessageAfterRefresh("Done", [previous, current], previous.id), null);
});

test("mention context still settles the optimistic user turn", () => {
  const previous = event("active", "before-send");
  const persisted: AgentEvent = {
    id: "mentioned-turn", sessionId: "active", timestamp: "2026-10-26T00:00:01Z",
    type: "user_message", data: { text: "<mentions>\n- file: src/index.ts\n</mentions>\n\nInspect this" },
  };
  assert.equal(pendingMessageAfterRefresh("Inspect this", [previous], previous.id), "Inspect this");
  assert.equal(pendingMessageAfterRefresh("Inspect this", [previous, persisted], previous.id), null);
  const selection: AgentEvent = {
    ...persisted, id: "selected-turn",
    data: { text: "<selections>\n- src/index.ts:12-20\n</selections>\n\nInspect this" },
  };
  assert.equal(pendingMessageAfterRefresh("Inspect this", [previous, selection], previous.id), null);
  const unrelated: AgentEvent = {
    ...persisted, id: "other-turn", data: { text: "Another request\n\nInspect this" },
  };
  assert.equal(pendingMessageAfterRefresh("Inspect this", [previous, unrelated], previous.id), "Inspect this");
});

test("structured-input display label settles against the sent answer prompt", () => {
  const previous = event("active", "before-answer");
  const answerPrompt = "The user answered the agent request: proceed.";
  const persisted: AgentEvent = {
    id: "answer-turn", sessionId: "active", timestamp: "2026-10-26T00:00:01Z",
    type: "user_message", data: { text: answerPrompt },
  };
  assert.equal(
    pendingMessageAfterRefresh("Answered agent request", [previous], previous.id, answerPrompt),
    "Answered agent request",
  );
  assert.equal(
    pendingMessageAfterRefresh("Answered agent request", [previous, persisted], previous.id, answerPrompt),
    null,
  );
});
