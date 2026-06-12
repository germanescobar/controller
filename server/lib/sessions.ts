import fs from "node:fs/promises";
import path from "node:path";

export interface SessionState {
  id: string;
  title?: string;
  workingDirectory: string;
  worktreeId?: string;
  model: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  serviceTier?: "fast" | "flex";
  provider?: string;
  mode?: "default" | "plan";
  messages: unknown[];
  createdAt: string;
  lastActiveAt: string;
  status: string;
  focusPinnedAt?: string;
  focusDoneAt?: string;
  // Set when the user explicitly unpins the session. Auto-pin on
  // creation/interaction respects this flag and will not re-pin a
  // session the user has deliberately removed from their focus queue.
  // Cleared on archive.
  userUnpinned?: boolean;
}

export interface AgentEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

export interface AttachmentMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
  isImage: boolean;
  createdAt: string;
}

function storagePaths(projectPath: string) {
  const base = path.join(projectPath, ".coding-agent");
  return {
    sessions: path.join(base, "sessions"),
    events: path.join(base, "events"),
    attachments: path.join(base, "attachments"),
  };
}

export async function saveAttachment(
  projectPath: string,
  attachment: AttachmentMetadata,
  data: Buffer
): Promise<AttachmentMetadata> {
  const { attachments } = storagePaths(projectPath);
  const dir = path.join(attachments, attachment.id);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, attachment.name);
  const metadataPath = path.join(dir, "metadata.json");
  const saved = { ...attachment, path: filePath };
  await fs.writeFile(filePath, data);
  await fs.writeFile(metadataPath, JSON.stringify(saved, null, 2));
  return saved;
}

export async function getAttachment(
  projectPath: string,
  attachmentId: string
): Promise<AttachmentMetadata | null> {
  if (!/^[a-zA-Z0-9._-]+$/.test(attachmentId)) return null;
  const metadataPath = path.join(
    storagePaths(projectPath).attachments,
    attachmentId,
    "metadata.json"
  );
  try {
    const content = await fs.readFile(metadataPath, "utf-8");
    return JSON.parse(content) as AttachmentMetadata;
  } catch {
    return null;
  }
}

export async function getAttachments(
  projectPath: string,
  attachmentIds: string[]
): Promise<AttachmentMetadata[]> {
  const attachments = await Promise.all(
    attachmentIds.map((id) => getAttachment(projectPath, id))
  );
  return attachments.filter((item): item is AttachmentMetadata => Boolean(item));
}

export async function getSessions(
  projectPath: string
): Promise<SessionState[]> {
  const dir = storagePaths(projectPath).sessions;
  try {
    const files = await fs.readdir(dir);
    const sessions: SessionState[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const content = await fs.readFile(path.join(dir, file), "utf-8");
      sessions.push(JSON.parse(content) as SessionState);
    }
    sessions.sort(
      (a, b) =>
        new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
    );
    return sessions.filter((s) => s.status !== "archived");
  } catch {
    return [];
  }
}

export async function getSession(
  projectPath: string,
  sessionId: string
): Promise<SessionState | null> {
  const filePath = path.join(
    storagePaths(projectPath).sessions,
    `${sessionId}.json`
  );
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as SessionState;
  } catch {
    return null;
  }
}

export async function archiveSession(
  projectPath: string,
  sessionId: string
): Promise<boolean> {
  const filePath = path.join(
    storagePaths(projectPath).sessions,
    `${sessionId}.json`
  );
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const session = JSON.parse(content) as SessionState;
    session.status = "archived";
    // Archiving drops any prior explicit-unpin signal: a rehydrated
    // session starts with a clean focus-queue slate.
    delete session.userUnpinned;
    await fs.writeFile(filePath, JSON.stringify(session, null, 2));
    return true;
  } catch {
    return false;
  }
}

export async function updateSessionFocus(
  projectPath: string,
  sessionId: string,
  action: "pin" | "unpin" | "done"
): Promise<SessionState | null> {
  const session = await getSession(projectPath, sessionId);
  if (!session) return null;

  if (action === "pin") {
    session.focusPinnedAt = session.focusPinnedAt ?? new Date().toISOString();
    delete session.focusDoneAt;
    // An explicit pin always overrides a previous unpin: the user is
    // telling us they want this session in the focus queue right now.
    delete session.userUnpinned;
  } else if (action === "unpin") {
    delete session.focusPinnedAt;
    delete session.focusDoneAt;
    // Record that the user explicitly removed this session from the
    // focus queue. Future auto-pin attempts will no-op until the
    // session is archived (or the user pins it explicitly).
    session.userUnpinned = true;
  } else {
    delete session.focusPinnedAt;
    session.focusDoneAt = new Date().toISOString();
    // "Done" is a workflow state, not a user opt-out of the focus
    // queue — clear any prior explicit-unpin signal.
    delete session.userUnpinned;
  }

  await saveSession(projectPath, session);
  return session;
}

/**
 * Pin a session to the focus queue if it is not already pinned, not
 * archived, and not previously explicitly unpinned by the user. Returns
 * the (possibly updated) session, or `null` if the session does not
 * exist. If the session is already pinned (or blocked by `userUnpinned`)
 * the file is left untouched and the existing session is returned.
 */
export async function pinSessionIfNeeded(
  projectPath: string,
  sessionId: string
): Promise<SessionState | null> {
  const session = await getSession(projectPath, sessionId);
  if (!session) return null;
  if (session.status === "archived") return session;
  if (session.focusPinnedAt) return session;
  if (session.userUnpinned) return session;

  session.focusPinnedAt = new Date().toISOString();
  delete session.focusDoneAt;
  await saveSession(projectPath, session);
  return session;
}

/**
 * Returns the focus-queue fields a session should be persisted with at
 * first-write time. Brand-new sessions are always auto-pinned. Existing
 * sessions are also auto-pinned on reply unless the user has explicitly
 * unpinned them (`userUnpinned` flag), so replying to an untracked session
 * surfaces it in the focus queue automatically.
 *
 * The route handlers use this when calling `saveSession` so the
 * auto-pin rule (and the "respect prior unpin" carve-out) lives in
 * one testable place rather than being inlined into two `saveSession`
 * call sites.
 */
export function resolveSessionFocusState(
  existing: SessionState | null
): {
  focusPinnedAt: string | undefined;
  focusDoneAt: string | undefined;
  userUnpinned: boolean | undefined;
} {
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

export async function getEvents(
  projectPath: string,
  sessionId: string
): Promise<AgentEvent[]> {
  const filePath = path.join(
    storagePaths(projectPath).events,
    `${sessionId}.jsonl`
  );
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AgentEvent);
  } catch {
    return [];
  }
}

/** Ensure session and event directories exist, then save/update a session file. */
export async function saveSession(
  projectPath: string,
  session: SessionState
): Promise<void> {
  const { sessions } = storagePaths(projectPath);
  await fs.mkdir(sessions, { recursive: true });
  const filePath = path.join(sessions, `${session.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(session, null, 2));
}

/** Append a single event to the JSONL events file. */
export async function appendEvent(
  projectPath: string,
  sessionId: string,
  event: AgentEvent
): Promise<void> {
  const { events } = storagePaths(projectPath);
  await fs.mkdir(events, { recursive: true });
  const filePath = path.join(events, `${sessionId}.jsonl`);
  await fs.appendFile(filePath, JSON.stringify(event) + "\n");
}
