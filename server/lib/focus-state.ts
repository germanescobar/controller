import fs from "node:fs/promises";
import path from "node:path";

/**
 * Controller-owned focus-queue state for a session.
 *
 * Lives in a sidecar file at `<projectPath>/.coding-orchestrator/focus/<sessionId>.json`
 * rather than on the agent-owned `.coding-agent/sessions/<sessionId>.json`,
 * because that file is shared with the agent process (e.g. Ada writes it
 * eight times per run) and the agent's `SessionStore.save()` only knows
 * about its own fields — anything the Controller adds gets silently
 * dropped on the next save (issue #139).
 *
 * Keeping focus state in a Controller-owned file decouples it from the
 * agent's session format and ensures the auto-pin survives every
 * agent-side write.
 */
export interface SessionFocus {
  sessionId: string;
  focusPinnedAt?: string;
  focusDoneAt?: string;
  // Set when the user explicitly unpins the session. Auto-pin on
  // creation/interaction respects this flag and will not re-pin a
  // session the user has deliberately removed from their focus queue.
  userUnpinned?: boolean;
  updatedAt: string;
}

export interface ResolvedFocusState {
  focusPinnedAt: string | undefined;
  focusDoneAt: string | undefined;
  userUnpinned: boolean | undefined;
}

function focusDir(projectPath: string): string {
  return path.join(projectPath, ".coding-orchestrator", "focus");
}

function focusFilePath(projectPath: string, sessionId: string): string {
  return path.join(focusDir(projectPath), `${sessionId}.json`);
}

/**
 * Read the focus state for a session. Returns `null` if no sidecar
 * exists (which is the default for any session the Controller has
 * not yet auto-pinned or that has not been explicitly touched by
 * the user).
 */
export async function readSessionFocus(
  projectPath: string,
  sessionId: string
): Promise<SessionFocus | null> {
  const filePath = focusFilePath(projectPath, sessionId);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as SessionFocus;
  } catch {
    return null;
  }
}

/**
 * Persist focus state for a session. Creates the focus directory on
 * demand. Replaces any existing sidecar for the session. Callers
 * should pass a record built by `buildSessionFocus` so `sessionId`
 * and `updatedAt` are stamped correctly.
 */
export async function writeSessionFocus(
  projectPath: string,
  focus: SessionFocus
): Promise<void> {
  const dir = focusDir(projectPath);
  await fs.mkdir(dir, { recursive: true });
  const filePath = focusFilePath(projectPath, focus.sessionId);
  await fs.writeFile(filePath, JSON.stringify(focus, null, 2));
}

/**
 * Remove the focus sidecar for a session. Idempotent: returns silently
 * if no sidecar exists.
 */
export async function deleteSessionFocus(
  projectPath: string,
  sessionId: string
): Promise<void> {
  const filePath = focusFilePath(projectPath, sessionId);
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/**
 * Read every focus sidecar in the project's focus directory and
 * return them keyed by `sessionId`. Used by `getSessions` to merge
 * focus state into the agent-session list in a single readdir pass.
 */
export async function listSessionFocuses(
  projectPath: string
): Promise<Map<string, SessionFocus>> {
  const dir = focusDir(projectPath);
  const result = new Map<string, SessionFocus>();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return result;
  }
  await Promise.all(
    files.map(async (file) => {
      if (!file.endsWith(".json")) return;
      const filePath = path.join(dir, file);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const focus = JSON.parse(content) as SessionFocus;
        if (focus && typeof focus.sessionId === "string") {
          result.set(focus.sessionId, focus);
        }
      } catch {
        // Skip unreadable or malformed sidecars — a corrupted focus
        // file must never break session listing.
      }
    })
  );
  return result;
}

/**
 * Returns the focus state a session should be persisted with at
 * first-write time. Brand-new sessions (no existing sidecar) are
 * always auto-pinned. Existing sessions are also auto-pinned on
 * reply unless the user has explicitly unpinned them (`userUnpinned`
 * flag), so replying to an untracked session surfaces it in the
 * focus queue automatically.
 *
 * The route handlers use this when calling `writeSessionFocus` so
 * the auto-pin rule (and the "respect prior unpin" carve-out) lives
 * in one testable place.
 */
export function resolveSessionFocusState(
  existing: SessionFocus | null
): ResolvedFocusState {
  if (!existing) {
    return {
      focusPinnedAt: new Date().toISOString(),
      focusDoneAt: undefined,
      userUnpinned: undefined,
    };
  }
  // Auto-pin on reply if not already pinned and not manually unpinned.
  const shouldAutoPin = !existing.focusPinnedAt && !existing.userUnpinned;
  return {
    focusPinnedAt: shouldAutoPin
      ? new Date().toISOString()
      : existing.focusPinnedAt,
    focusDoneAt: shouldAutoPin ? undefined : existing.focusDoneAt,
    userUnpinned: existing.userUnpinned,
  };
}

/**
 * Build the full `SessionFocus` record that should be persisted for
 * `sessionId` given the desired focus state. Centralizes the
 * `sessionId`/`updatedAt` plumbing so callers don't have to
 * remember to stamp them.
 */
export function buildSessionFocus(
  sessionId: string,
  state: ResolvedFocusState
): SessionFocus {
  const now = new Date().toISOString();
  const focus: SessionFocus = { sessionId, updatedAt: now };
  if (state.focusPinnedAt) focus.focusPinnedAt = state.focusPinnedAt;
  if (state.focusDoneAt) focus.focusDoneAt = state.focusDoneAt;
  if (state.userUnpinned) focus.userUnpinned = state.userUnpinned;
  return focus;
}
