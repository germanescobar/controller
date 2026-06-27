/*
 * Render the payload of a `tool.approval_requested` event as a short
 * human-readable summary for the approval card. The shape of the input
 * depends on which agent and which protocol version emitted the event:
 *
 *   - Claude Code (`can_use_tool`) sends snake_case fields like
 *     `command` and `file_path` directly on the input.
 *   - Codex app-server v1 sends separate notifications for command
 *     execution and file changes; the `command` arrives as a string
 *     array (argv) and file changes as a `file_changes` map keyed by
 *     absolute path.
 *   - Codex app-server v2 unified permissions notifications send a
 *     `permissions` object with `commands` (each carrying `argv`),
 *     `fileSystem`, and `network` buckets.
 *
 * The function picks the first useful representation it finds. If all
 * that's left is bookkeeping fields (threadId, turnId, itemId, etc.)
 * with nothing a human would act on, it returns an empty string so the
 * card just shows the header and decision buttons instead of a raw
 * JSON dump.
 */

const IDENTIFIER_KEYS = new Set([
  "threadId",
  "turnId",
  "itemId",
  "callId",
  "conversationId",
  "requestId",
  "startedAtMs",
  "startedAt",
  "grantRoot",
  "environmentId",
  "scope",
  "approval_id",
  "approvalId",
  "toolUseId",
  // Codex bookkeeping surfaced as null in the v2 unified request
  // shape — no information for a human reviewer even when present.
  "reason",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinArgv(argv: unknown): string {
  if (!Array.isArray(argv)) return JSON.stringify(argv);
  return argv.map((part) => String(part)).join(" ");
}

export function describeApprovalInput(
  toolName: string,
  input: Record<string, unknown>
): string {
  // Claude Code paths — kept first because they're the original case
  // the renderer was written for.
  if (toolName === "Bash" && typeof input.command === "string") {
    return input.command;
  }
  if (
    (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") &&
    typeof input.file_path === "string"
  ) {
    return input.file_path;
  }

  // Codex app-server v1 — command execution.
  if (toolName === "Shell" || toolName === "Bash") {
    const command = input.command;
    if (Array.isArray(command)) return command.map(String).join(" ");
    if (typeof command === "string") return command;
  }

  // Codex app-server v1 — file change. v1 used snake_case `file_changes`,
  // v2 unified permissions notifications use camelCase `fileChanges`.
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
    const changes = input.file_changes ?? input.fileChanges;
    if (isPlainObject(changes)) {
      const paths = Object.keys(changes);
      if (paths.length > 0) return paths.join("\n");
    }
  }

  // Codex app-server v2 — unified `permissions` object.
  if (isPlainObject(input.permissions)) {
    const lines: string[] = [];
    const perms = input.permissions;

    if (Array.isArray(perms.commands) && perms.commands.length > 0) {
      const preview = perms.commands
        .map((c) => {
          if (isPlainObject(c) && "argv" in c) return joinArgv(c.argv);
          return JSON.stringify(c);
        })
        .join("\n");
      lines.push(`Commands:\n${preview}`);
    }

    if (isPlainObject(perms.fileSystem)) {
      const paths = Object.keys(perms.fileSystem);
      if (paths.length > 0) lines.push(`Editing:\n${paths.join("\n")}`);
    }

    if (isPlainObject(perms.network) && Object.keys(perms.network).length > 0) {
      lines.push(`Network: ${JSON.stringify(perms.network)}`);
    }

    if (lines.length > 0) return lines.join("\n\n");
  }

  // Codex-provided explanation, when present, is usually the most
  // useful single string to surface.
  if (typeof input.reason === "string" && input.reason.trim()) {
    return input.reason;
  }

  // Fallback: if the only remaining fields are bookkeeping identifiers,
  // return empty so the card suppresses the body. Otherwise dump the
  // remaining keys so a future protocol field is still visible.
  const meaningful = Object.keys(input).filter((k) => !IDENTIFIER_KEYS.has(k));
  if (meaningful.length === 0) return "";

  try {
    const json = JSON.stringify(input, null, 2);
    return json && json !== "{}" ? json : "";
  } catch {
    return "";
  }
}