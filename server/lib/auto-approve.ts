/*
 * Single source of truth for each agent's auto-approval configuration.
 *
 * Auto-approve is ON by default for every agent: the agent runs end-to-end
 * without pausing for permission on the actions it would normally auto-approve
 * (file reads, edits, command execution, …). When a user turns it OFF for an
 * agent, the agent falls back to prompting for those actions and Controller
 * renders each prompt as an approval card.
 *
 * Each agent opts into auto-approval through a different mechanism (a CLI flag,
 * a permission mode, or a JSON-RPC approval policy), so the exact flag set
 * lives here, per agent. The launchers — `server/lib/agents.ts` (CLI spawn) and
 * `server/lib/codex-app-server.ts` (Codex JSON-RPC) — read from this module
 * instead of hardcoding the values inline, so the UI toggle and the launchers
 * never drift out of sync.
 */

/** New agent configurations default to auto-approve = on. */
export const DEFAULT_AUTO_APPROVE = true;

/**
 * Anita opts into auto-approval with `--auto-approve`; omitting it makes the
 * CLI prompt for each tool call. NOTE: the Anita CLI only prompts over a TTY
 * `[y/n]` line today and has no structured stream-json approval event, so the
 * OFF path does not yet render approval cards in Controller — tracked as a
 * follow-up. The flag set below is still the source of truth for what the
 * launcher passes.
 */
export function anitaAutoApproveFlags(autoApprove: boolean): string[] {
  return autoApprove ? ["--auto-approve"] : [];
}

/**
 * Claude Code's permission mode for default (non-plan) turns.
 * `bypassPermissions` runs without prompting; `default` makes the CLI route a
 * `can_use_tool` request to us for every action, which Controller surfaces as
 * an approval card over the stream-json control channel.
 */
export function claudePermissionMode(
  autoApprove: boolean
): "bypassPermissions" | "default" {
  return autoApprove ? "bypassPermissions" : "default";
}

/**
 * Codex `exec` flags for the attachments-only spawn path. Explicit
 * `workspace-write` + `on-request` replaces the deprecated `--full-auto`
 * shorthand without inheriting a prompting approval policy from user config.
 * The OFF variant asks for approval on every command by restricting the sandbox
 * to read-only and using the `untrusted` approval policy. NOTE: `codex exec` is
 * headless and cannot answer prompts mid-run, so OFF on this path degrades
 * rather than rendering cards — the primary Codex path (no attachments) goes
 * through the app-server, which does support interactive approvals. See
 * `codexAppServerApprovalConfig`.
 */
export function codexExecAutoApproveFlags(autoApprove: boolean): string[] {
  return autoApprove
    ? ["--sandbox", "workspace-write", "-c", 'approval_policy="on-request"']
    : ["--sandbox", "read-only", "-c", 'approval_policy="untrusted"'];
}

/**
 * Codex app-server approval configuration (the primary Codex path). When ON,
 * the agent never asks (`never` policy, full-access sandbox). When OFF, every
 * command and file change requires approval by pairing the `untrusted` policy
 * with a read-only sandbox, so the app-server emits
 * `item/commandExecution/requestApproval` / `item/fileChange/requestApproval`
 * for Controller to render.
 */
export interface CodexAppServerApprovalConfig {
  /** `AskForApproval` value for thread/start, thread/resume, and turn/start. */
  approvalPolicy: "never" | "untrusted";
  /** `SandboxMode` for thread/start and thread/resume. */
  sandboxMode: "danger-full-access" | "read-only";
  /** `SandboxPolicy` object for turn/start. */
  sandboxPolicy: { type: "dangerFullAccess" } | { type: "readOnly" };
}

export function codexAppServerApprovalConfig(
  autoApprove: boolean
): CodexAppServerApprovalConfig {
  if (autoApprove) {
    return {
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  return {
    approvalPolicy: "untrusted",
    sandboxMode: "read-only",
    sandboxPolicy: { type: "readOnly" },
  };
}
