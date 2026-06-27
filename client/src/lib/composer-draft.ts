/*
 * Composer draft persistence (issue #251).
 *
 * The chat composer text + active skill chips are mirrored to localStorage so
 * an in-progress message survives navigation that re-mounts SessionView
 * (session / worktree / project switch, opening Settings, archive flows) and a
 * reload.
 *
 * Scope is per-session so drafts never bleed across sessions. A session that
 * doesn't exist yet (the new-session view) is keyed by project + worktree so a
 * half-written prompt survives navigating into and out of that view.
 *
 * Pending attachments are intentionally NOT persisted: they wrap live `File`
 * objects, which can't be serialized to localStorage without copying
 * potentially large blobs and would still lose file identity on restore. Only
 * the text and skill chips are restored.
 */
import type { AgentSkill } from "../api.ts";

export interface ComposerDraft {
  text: string;
  skills: AgentSkill[];
}

const EMPTY_DRAFT: ComposerDraft = { text: "", skills: [] };

/** Build the localStorage key for a session's (or new-session view's) draft. */
export function buildComposerDraftKey(
  sessionId: string | undefined,
  projectId: string,
  worktreeId?: string
): string {
  if (sessionId) return `composerDraft:${sessionId}`;
  return `composerDraft:new:${projectId}:${worktreeId ?? "main"}`;
}

/** Read and validate a stored draft. Returns an empty draft on miss/corruption. */
export function loadComposerDraft(key: string): ComposerDraft {
  if (typeof window === "undefined") return EMPTY_DRAFT;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return EMPTY_DRAFT;
    const parsed = JSON.parse(raw) as { text?: unknown; skills?: unknown };
    return {
      text: typeof parsed.text === "string" ? parsed.text : "",
      skills: normalizeDraftSkills(parsed.skills),
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

/** Persist a draft. Best-effort: storage failures (quota) are swallowed. */
export function saveComposerDraft(key: string, draft: ComposerDraft): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Best-effort: a quota or serialization failure shouldn't break typing.
  }
}

/** Remove a stored draft (after send/steer or an explicit clear). */
export function clearComposerDraft(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Best-effort: ignore storage failures.
  }
}

/** Keep only entries that match the AgentSkill shape; drop anything malformed. */
function normalizeDraftSkills(value: unknown): AgentSkill[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is AgentSkill =>
      Boolean(entry) &&
      typeof (entry as AgentSkill).name === "string" &&
      typeof (entry as AgentSkill).description === "string" &&
      typeof (entry as AgentSkill).path === "string" &&
      typeof (entry as AgentSkill).scope === "string"
  );
}
