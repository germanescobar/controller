import test from "node:test";
import assert from "node:assert/strict";
import {
  consumePendingApproval,
  listSessionRuntimes,
  markSessionActive,
  markSessionInactive,
  recordSessionAttentionEvent,
  setSessionAwaitingUserInput,
  stopAllSessionRuntimes,
} from "../session-runtime.js";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

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

test("shutdown signals every active agent runtime and marks it inactive", () => {
  const signals: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    killed: false,
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      this.killed = true;
      return true;
    },
  }) as unknown as ChildProcess;

  markSessionActive("runtime-shutdown", { provider: "anita", child });

  assert.equal(stopAllSessionRuntimes(), 1);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(runtimeSummary("runtime-shutdown")?.active, false);
});
