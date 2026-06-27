import test from "node:test";
import assert from "node:assert/strict";
import {
  markClaudeSessionPermissionsRevoked,
  consumeClaudeSessionRevocation,
  hasClaudeSessionRevocation,
} from "../session-permissions.ts";

test("revocation flag is consumed exactly once", () => {
  const worktreeId = `wt-${Math.random()}`;
  assert.equal(hasClaudeSessionRevocation(worktreeId), false);
  markClaudeSessionPermissionsRevoked(worktreeId);
  assert.equal(hasClaudeSessionRevocation(worktreeId), true);
  assert.equal(consumeClaudeSessionRevocation(worktreeId), true);
  // Second consume returns false and the flag stays cleared.
  assert.equal(consumeClaudeSessionRevocation(worktreeId), false);
  assert.equal(hasClaudeSessionRevocation(worktreeId), false);
});

test("revocation flags are scoped per worktree", () => {
  const wtA = `wt-a-${Math.random()}`;
  const wtB = `wt-b-${Math.random()}`;
  markClaudeSessionPermissionsRevoked(wtA);
  assert.equal(hasClaudeSessionRevocation(wtA), true);
  assert.equal(hasClaudeSessionRevocation(wtB), false);
  assert.equal(consumeClaudeSessionRevocation(wtB), false);
  assert.equal(consumeClaudeSessionRevocation(wtA), true);
});

test("re-marking after consume restores the flag", () => {
  const worktreeId = `wt-${Math.random()}`;
  markClaudeSessionPermissionsRevoked(worktreeId);
  assert.equal(consumeClaudeSessionRevocation(worktreeId), true);
  markClaudeSessionPermissionsRevoked(worktreeId);
  assert.equal(consumeClaudeSessionRevocation(worktreeId), true);
});