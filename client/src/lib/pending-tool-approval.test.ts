import test from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../api.ts";
import { getLatestPendingToolApproval } from "./pending-tool-approval.ts";

function event(type: string, data: Record<string, unknown> = {}): AgentEvent {
  return {
    id: crypto.randomUUID(),
    sessionId: "session-1",
    timestamp: new Date().toISOString(),
    type,
    data,
  };
}

test("returns the latest unresolved tool approval", () => {
  const pending = getLatestPendingToolApproval([
    event("assistant_response"),
    event("tool_approval_requested", {
      requestId: "req-1",
      toolName: "Bash",
      input: { command: "gh issue create" },
    }),
  ]);

  assert.deepEqual(pending, {
    requestId: "req-1",
    toolName: "Bash",
    input: { command: "gh issue create" },
  });
});

test("does not return approvals settled by an approval response", () => {
  const pending = getLatestPendingToolApproval([
    event("tool_approval_requested", { requestId: "req-1" }),
    event("tool_approval_response", { requestId: "req-1", decision: "always_allow" }),
  ]);

  assert.equal(pending, null);
});

test("does not return approvals stranded before a failed run", () => {
  const pending = getLatestPendingToolApproval([
    event("tool_approval_requested", { requestId: "req-1", toolName: "Bash" }),
    event("run.failed", { error: "Claude process was terminated by signal SIGKILL." }),
  ]);

  assert.equal(pending, null);
});

test("does not return approvals before terminal run markers", () => {
  for (const type of ["run.completed", "run.cancelled", "run_cancelled"]) {
    const pending = getLatestPendingToolApproval([
      event("tool_approval_requested", { requestId: "req-1", toolName: "Bash" }),
      event(type),
    ]);

    assert.equal(pending, null, `${type} should settle earlier approvals`);
  }
});
