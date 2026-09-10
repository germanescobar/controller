import test from "node:test";
import assert from "node:assert/strict";
import {
  consumePendingApproval,
  listSessionRuntimes,
  markSessionActive,
  markSessionInactive,
  recordSessionAttentionEvent,
  setSessionAwaitingUserInput,
} from "../session-runtime.js";

function runtimeSummary(sessionId: string) {
  return listSessionRuntimes().find((entry) => entry.sessionId === sessionId);
}

test("user-input attention survives inactivity and clears after response", () => {
  const sessionId = "runtime-user-input";
  markSessionActive(sessionId, { provider: "codex" });
  recordSessionAttentionEvent(sessionId, {
    type: "user.input_requested",
    id: "input-1",
    questions: [],
  });

  assert.equal(runtimeSummary(sessionId)?.awaitingInput, true);
  markSessionInactive(sessionId);
  assert.equal(runtimeSummary(sessionId)?.awaitingInput, true);

  setSessionAwaitingUserInput(sessionId, false);
  assert.equal(runtimeSummary(sessionId)?.awaitingInput, undefined);
});

test("approval attention clears when the response consumes the request", () => {
  const sessionId = "runtime-approval";
  markSessionActive(sessionId, { provider: "codex" });
  recordSessionAttentionEvent(sessionId, {
    type: "tool.approval_requested",
    id: "approval-1",
    toolUseId: "tool-1",
    toolName: "Shell",
    input: { command: "pwd" },
    suggestions: [],
  });

  assert.equal(runtimeSummary(sessionId)?.awaitingInput, true);
  assert.ok(consumePendingApproval(sessionId, "approval-1"));
  assert.equal(runtimeSummary(sessionId)?.awaitingInput, undefined);
});
