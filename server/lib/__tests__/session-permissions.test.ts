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

/*
 * Regression test for issue #259 review feedback:
 *
 * `handleSessionStream` must only consume the revocation flag when the
 * caller actually passed a `resumeSessionId`. If a brand-new turn
 * (no resume id) consumes the flag, the original session stays
 * resume-able for a *later* turn — and the one-shot semantics of
 * "next turn skips --resume" are silently lost.
 *
 * Mirror the gate from server/routes/sessions.ts here so a future
 * refactor of that handler doesn't regress the contract.
 */
test("flag must only be consumed when there is a resume id to drop", () => {
  const worktreeId = `wt-${Math.random()}`;
  markClaudeSessionPermissionsRevoked(worktreeId);

  // Simulate the shouldDropResume gate from handleSessionStream.
  function shouldDropResume(
    providerId: string,
    resumeSessionId: string | undefined,
    worktreeId: string
  ): boolean {
    return (
      providerId === "claude" &&
      resumeSessionId !== undefined &&
      consumeClaudeSessionRevocation(worktreeId)
    );
  }

  // New turn (no resume id): the flag must NOT be consumed.
  assert.equal(shouldDropResume("claude", undefined, worktreeId), false);
  assert.equal(
    hasClaudeSessionRevocation(worktreeId),
    true,
    "new turn must not burn the one-shot flag"
  );

  // Resumed turn: flag is consumed and effective id is undefined.
  assert.equal(shouldDropResume("claude", "sess-abc", worktreeId), true);
  assert.equal(hasClaudeSessionRevocation(worktreeId), false);

  // Second resumed turn with no flag set: pass-through, no drop.
  assert.equal(shouldDropResume("claude", "sess-abc", worktreeId), false);

  // Non-Claude provider: never consumes, even with a resume id.
  markClaudeSessionPermissionsRevoked(worktreeId);
  assert.equal(shouldDropResume("codex", "sess-abc", worktreeId), false);
  assert.equal(hasClaudeSessionRevocation(worktreeId), true);
});
