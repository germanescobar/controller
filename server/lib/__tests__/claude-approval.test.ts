import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { sendClaudeApprovalDecision } from "../agents.js";

/**
 * Capture what `sendClaudeApprovalDecision` writes to a Claude child's stdin.
 *
 * The real CLI reads a newline-delimited JSON `control_response` over its
 * stdin while the agent is blocked on a `can_use_tool` request. We assert
 * here on the exact wire shape because Claude's parser is strict: an
 * unrecognized field name (e.g. `updatedPermissions` vs. the actual
 * `permissionUpdates`) silently drops the entry, leaving the agent without
 * any persisted rule — and on the `Always allow` path the run never emits a
 * terminal `result` event, hanging until the inactivity watchdog kills it.
 *
 * Regression test for: Claude "Always allow" approval hangs after responding.
 */
function captureDecision(
  request: Parameters<typeof sendClaudeApprovalDecision>[1],
  decision: Parameters<typeof sendClaudeApprovalDecision>[2]
): Record<string, unknown> | null {
  const chunks: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  // The function only checks `stdin.writable`; mark it true so it writes.
  Object.defineProperty(stdin, "writable", { value: true });

  const fakeChild = { stdin } as unknown as ChildProcess;
  const sent = sendClaudeApprovalDecision(fakeChild, request, decision);
  assert.equal(sent, true, "sendClaudeApprovalDecision should write when stdin is writable");

  const payload = chunks.join("");
  if (!payload) return null;
  return JSON.parse(payload) as Record<string, unknown>;
}

test("allow_once emits behavior=allow with no permissionUpdates (rule-less response)", () => {
  const wire = captureDecision(
    {
      requestId: "req-1",
      toolName: "Bash",
      input: { command: "ls" },
      suggestions: [
        { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow" },
      ],
    },
    "allow_once"
  );

  assert.equal(wire?.type, "control_response");
  const envelope = wire?.response as Record<string, unknown>;
  assert.equal(envelope?.subtype, "success");
  assert.equal(envelope?.request_id, "req-1");

  const inner = envelope?.response as Record<string, unknown>;
  assert.equal(inner?.behavior, "allow");
  assert.equal(inner?.permissionUpdates, undefined, "allow_once must not include permissionUpdates");
  assert.equal(inner?.updatedPermissions, undefined, "never use the legacy updatedPermissions name");
  assert.deepEqual(inner?.updatedInput, { command: "ls" });
});

test("always_allow emits permissionUpdates (not updatedPermissions) with destination=session", () => {
  // This is the field name Claude's control-protocol parser expects. Sending
  // `updatedPermissions` is silently dropped and the rule never lands.
  const wire = captureDecision(
    {
      requestId: "req-2",
      toolName: "Bash",
      input: { command: "ls" },
      // Claude emits permission_suggestions without `destination`. Each entry
      // must be defaulted to "session" before forwarding or Zod rejects it.
      suggestions: [
        { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow" },
        {
          type: "replaceRules",
          rules: [{ toolName: "Bash" }],
          behavior: "allow",
          // Even if Claude does include a destination, preserve it.
          destination: "localSettings",
        },
      ],
    },
    "always_allow"
  );

  const inner = (wire?.response as Record<string, unknown>)?.response as Record<string, unknown>;
  assert.equal(inner?.behavior, "allow");
  assert.equal(inner?.updatedPermissions, undefined, "the legacy name must not be sent");

  const updates = inner?.permissionUpdates as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(updates), "permissionUpdates must be an array");
  assert.equal(updates.length, 2);

  // The first suggestion had no destination — fill in "session".
  assert.equal(updates[0].destination, "session");
  assert.equal(updates[0].type, "addRules");
  assert.equal(updates[0].behavior, "allow");

  // The second already had destination="localSettings"; preserve it.
  assert.equal(updates[1].destination, "localSettings");
  assert.equal(updates[1].type, "replaceRules");
});

test("always_allow with no suggestions emits an empty permissionUpdates array", () => {
  // Some tool calls arrive without permission_suggestions at all (rare but
  // legal — Claude simply has no rule to propose). We still send an empty
  // array under the correct field name so the response parses, rather than
  // omitting the field and confusing the schema with a half-formed payload.
  const wire = captureDecision(
    {
      requestId: "req-3",
      toolName: "Bash",
      input: { command: "ls" },
      suggestions: [],
    },
    "always_allow"
  );

  const inner = (wire?.response as Record<string, unknown>)?.response as Record<string, unknown>;
  assert.equal(inner?.behavior, "allow");
  assert.deepEqual(inner?.permissionUpdates, []);
});

test("deny emits behavior=deny with no permissionUpdates", () => {
  const wire = captureDecision(
    {
      requestId: "req-4",
      toolName: "Bash",
      input: { command: "rm -rf /" },
      suggestions: [],
    },
    "deny"
  );

  const inner = (wire?.response as Record<string, unknown>)?.response as Record<string, unknown>;
  assert.equal(inner?.behavior, "deny");
  assert.equal(inner?.permissionUpdates, undefined);
  assert.equal(inner?.updatedPermissions, undefined);
});

test("ExitPlanMode approval flips the session into acceptEdits via permissionUpdates", () => {
  // ExitPlanMode is special — approving it must also drop the session out
  // of plan mode or the CLI ends the turn still in plan mode. The legacy
  // code wrote this under `updatedPermissions`, which Claude silently
  // dropped and the session was stuck in plan mode forever.
  const wire = captureDecision(
    {
      requestId: "req-plan",
      toolName: "ExitPlanMode",
      input: { plan: "Do the thing." },
      suggestions: [],
    },
    "allow_once"
  );

  const inner = (wire?.response as Record<string, unknown>)?.response as Record<string, unknown>;
  assert.equal(inner?.behavior, "allow");
  assert.equal(inner?.updatedPermissions, undefined);

  const updates = inner?.permissionUpdates as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(updates));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].type, "setMode");
  assert.equal(updates[0].mode, "acceptEdits");
  assert.equal(updates[0].destination, "session");
});

test("sendClaudeApprovalDecision is a no-op when stdin is not writable", () => {
  const stdin = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  Object.defineProperty(stdin, "writable", { value: false });
  const fakeChild = { stdin } as unknown as ChildProcess;
  const sent = sendClaudeApprovalDecision(
    fakeChild,
    {
      requestId: "req-x",
      toolName: "Bash",
      input: {},
      suggestions: [],
    },
    "always_allow"
  );
  assert.equal(sent, false);
});