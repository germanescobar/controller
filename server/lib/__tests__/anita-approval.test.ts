import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { sendAnitaApprovalDecision } from "../agents.js";

/**
 * Capture the newline-delimited JSON line `sendAnitaApprovalDecision` writes to
 * the Anita child's stdin. Anita's `--stream-json` responder matches the line
 * to the in-flight request by `id` (the tool-call id), so the wire shape and
 * the `approved` boolean are what the test pins down.
 */
function captureDecision(
  requestId: string,
  decision: Parameters<typeof sendAnitaApprovalDecision>[2]
): Record<string, unknown> | null {
  const chunks: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  Object.defineProperty(stdin, "writable", { value: true });

  const fakeChild = { stdin } as unknown as ChildProcess;
  const sent = sendAnitaApprovalDecision(fakeChild, requestId, decision);
  assert.equal(sent, true, "should write when stdin is writable");

  const payload = chunks.join("");
  assert.ok(payload.endsWith("\n"), "the protocol is line-delimited");
  return JSON.parse(payload) as Record<string, unknown>;
}

test("allow_once writes approval.response with approved=true", () => {
  const wire = captureDecision("call-1", "allow_once");
  assert.deepEqual(wire, { type: "approval.response", id: "call-1", approved: true });
});

test("always_allow collapses to approved=true (Anita has no persisted rules)", () => {
  const wire = captureDecision("call-2", "always_allow");
  assert.deepEqual(wire, { type: "approval.response", id: "call-2", approved: true });
});

test("deny writes approved=false", () => {
  const wire = captureDecision("call-3", "deny");
  assert.deepEqual(wire, { type: "approval.response", id: "call-3", approved: false });
});

test("sendAnitaApprovalDecision is a no-op when stdin is not writable", () => {
  const stdin = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  Object.defineProperty(stdin, "writable", { value: false });
  const fakeChild = { stdin } as unknown as ChildProcess;
  const sent = sendAnitaApprovalDecision(fakeChild, "call-x", "allow_once");
  assert.equal(sent, false);
});
