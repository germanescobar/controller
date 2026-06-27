/*
 * Per-worktree "session permissions revoked" state.
 *
 * When the user clicks "Reset session permissions" for Claude Code in
 * the agent settings, we record the worktree here. On the next session
 * start in that worktree, the session-start route drops `resumeSessionId`
 * so Claude starts a fresh session id, losing any
 * `updatedPermissions.destination: "session"` rules the user previously
 * granted via "Always allow". This is the only mechanism the Claude
 * control protocol exposes for revoking session-scoped permissions —
 * there's no additive "remove these rules" message.
 *
 * Codex doesn't need this: revoking Codex session permissions is handled
 * directly by `CodexAppServerManager.resetAllSessions()` which tears down
 * the live `codex app-server` child and its thread state.
 */

const revokedWorktrees = new Set<string>();

/** Mark a worktree as "next turn must start a fresh Claude session". */
export function markClaudeSessionPermissionsRevoked(worktreeId: string): void {
  revokedWorktrees.add(worktreeId);
}

/** Returns true (and clears the flag) if the next Claude turn in this
 * worktree should skip `--resume`. Idempotent. */
export function consumeClaudeSessionRevocation(worktreeId: string): boolean {
  if (!revokedWorktrees.has(worktreeId)) return false;
  revokedWorktrees.delete(worktreeId);
  return true;
}

/** True if the worktree has a pending revocation. Useful for the UI
 * to show "revocation pending — next turn will start a fresh session". */
export function hasClaudeSessionRevocation(worktreeId: string): boolean {
  return revokedWorktrees.has(worktreeId);
}