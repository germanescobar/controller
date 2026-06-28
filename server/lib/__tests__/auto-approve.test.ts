import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AUTO_APPROVE,
  anitaAutoApproveFlags,
  claudePermissionMode,
  codexExecAutoApproveFlags,
  codexAppServerApprovalConfig,
} from "../auto-approve.js";

test("auto-approve defaults to on", () => {
  assert.equal(DEFAULT_AUTO_APPROVE, true);
});

test("anita flag set: --auto-approve only when on", () => {
  assert.deepEqual(anitaAutoApproveFlags(true), ["--auto-approve"]);
  assert.deepEqual(anitaAutoApproveFlags(false), []);
});

test("claude permission mode follows auto-approve", () => {
  assert.equal(claudePermissionMode(true), "bypassPermissions");
  assert.equal(claudePermissionMode(false), "default");
});

test("codex exec flags use workspace-write when on and a restricted, prompting sandbox when off", () => {
  assert.deepEqual(codexExecAutoApproveFlags(true), [
    "--sandbox",
    "workspace-write",
  ]);
  const off = codexExecAutoApproveFlags(false);
  assert.ok(!off.includes("--full-auto"), "off must not auto-approve");
  assert.ok(off.includes("read-only"), "off restricts the sandbox");
  assert.ok(
    off.some((flag) => flag.includes("approval_policy")),
    "off sets an approval policy"
  );
});

test("codex app-server approval config: never/full-access when on, untrusted/read-only when off", () => {
  assert.deepEqual(codexAppServerApprovalConfig(true), {
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
    sandboxPolicy: { type: "dangerFullAccess" },
  });
  assert.deepEqual(codexAppServerApprovalConfig(false), {
    approvalPolicy: "untrusted",
    sandboxMode: "read-only",
    sandboxPolicy: { type: "readOnly" },
  });
});
