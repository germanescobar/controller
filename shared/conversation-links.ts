/*
 * Parsing for `controller://` internal conversation links.
 *
 * The agent emits references to other conversations as URIs so a human can
 * jump straight to the linked session:
 *
 *   controller://project/<projectId>/worktree/<worktreeId>/session/<sessionId>
 *
 * The URI always carries the full path, so navigation is a pure client-side
 * lookup — no server resolution. Controller controls the only emitter (the
 * session-start flow), so the contract is "always emit the full path".
 *
 * This module is shared between the Electron and web renderers so both detect
 * and parse links with identical rules. Keep it free of DOM/Node dependencies.
 */

export interface ControllerLinkTarget {
  projectId: string;
  worktreeId: string;
  sessionId: string;
}

// A single path segment of a controller:// URI. Ids are UUIDs in practice but
// we accept any non-empty run of url-safe id characters so we don't reject
// links the agent produces with a different id scheme.
const SEGMENT = "[A-Za-z0-9_-]+";

/*
 * Global, case-insensitive pattern for finding controller:// URIs embedded in
 * free text (used by the markdown linkifier). `sessions?` accepts both the
 * singular `session` the server emits and the plural `sessions` that appears
 * in some skill docs.
 */
export const CONTROLLER_URI_PATTERN = new RegExp(
  `controller:\\/\\/project\\/${SEGMENT}\\/worktree\\/${SEGMENT}\\/sessions?\\/${SEGMENT}`,
  "gi"
);

const FULL_URI = new RegExp(
  `^controller:\\/\\/project\\/(${SEGMENT})\\/worktree\\/(${SEGMENT})\\/sessions?\\/(${SEGMENT})$`,
  "i"
);

/*
 * Parse a single controller:// URI. Returns the navigation target, or null if
 * the value isn't a well-formed controller:// link. The whole (trimmed) string
 * must be the URI — callers detecting links inside larger text should use
 * `CONTROLLER_URI_PATTERN` first and pass each match here.
 */
export function parseControllerUri(
  value: string | undefined | null
): ControllerLinkTarget | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const full = trimmed.match(FULL_URI);
  if (!full) return null;

  return { projectId: full[1], worktreeId: full[2], sessionId: full[3] };
}
