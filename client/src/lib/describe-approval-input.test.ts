import test from "node:test";
import assert from "node:assert/strict";
import { describeApprovalInput } from "./describe-approval-input.ts";

test("Claude Code Bash renders the command", () => {
  assert.equal(
    describeApprovalInput("Bash", { command: "ls -la /tmp" }),
    "ls -la /tmp"
  );
});

test("Claude Code Edit/Write renders the file_path", () => {
  assert.equal(
    describeApprovalInput("Edit", { file_path: "/Users/me/x.ts" }),
    "/Users/me/x.ts"
  );
  assert.equal(
    describeApprovalInput("Write", { file_path: "/Users/me/x.ts" }),
    "/Users/me/x.ts"
  );
});

test("Codex v1 Shell joins the argv array", () => {
  assert.equal(
    describeApprovalInput("Shell", { command: ["sh", "-c", "echo hi"] }),
    "sh -c echo hi"
  );
});

test("Codex v1 Edit joins file_changes paths", () => {
  assert.equal(
    describeApprovalInput("Edit", {
      file_changes: { "/a.ts": { type: "update" }, "/b.ts": { type: "add" } },
    }),
    "/a.ts\n/b.ts"
  );
});

test("Codex v2 unified permissions renders commands under a label", () => {
  assert.equal(
    describeApprovalInput("Edit", {
      permissions: {
        commands: [{ argv: ["npm", "test"] }, { argv: ["echo", "ok"] }],
      },
    }),
    "Commands:\nnpm test\necho ok"
  );
});

test("Codex v2 permissions with fileSystem lists paths under Editing", () => {
  assert.equal(
    describeApprovalInput("Edit", {
      permissions: {
        fileSystem: { "/a.ts": { read: true }, "/b.ts": { write: true } },
      },
    }),
    "Editing:\n/a.ts\n/b.ts"
  );
});

test("Codex v2 permissions with all three buckets joins them", () => {
  const out = describeApprovalInput("Edit", {
    permissions: {
      commands: [{ argv: ["git", "push"] }],
      fileSystem: { "/x.ts": {} },
      network: { http: { allow: ["example.com"] } },
    },
  });
  assert.match(out, /^Commands:\ngit push$/m);
  assert.match(out, /^Editing:\n\/x\.ts$/m);
  assert.match(out, /Network: /);
});

test("Codex v2 with only reason field surfaces the reason", () => {
  assert.equal(
    describeApprovalInput("Edit", { reason: "needs write access" }),
    "needs write access"
  );
});

test("returns empty when only identifier bookkeeping is present (screenshot case)", () => {
  // This is the exact input the screenshot showed: every field is an
  // identifier, no command, no path, no permissions — just JSON noise.
  const input = {
    threadId: "019f0a5a-f6b0-7051-834e-be2f3cb98bac",
    turnId: "019f0a5a-f72b-7361-a312-9451ed705061",
    itemId: "call_XFAWXwbko70kS0rEXqzlBSMf",
    startedAtMs: 1782585178792,
    reason: null,
    grantRoot: null,
  };
  assert.equal(describeApprovalInput("Edit", input), "");
});

test("falls back to a meaningful-key JSON dump if unknown fields appear", () => {
  const out = describeApprovalInput("Edit", {
    threadId: "abc",
    somethingNew: { nested: true },
  });
  assert.match(out, /somethingNew/);
  assert.match(out, /threadId/);
});

test("returns empty for empty input", () => {
  assert.equal(describeApprovalInput("Edit", {}), "");
});