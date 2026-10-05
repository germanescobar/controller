import { openSync, readSync, closeSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildSessionFocus,
  deleteSessionFocus,
  listSessionFocuses,
  readSessionFocus,
  resolveSessionFocusState,
  writeSessionFocus,
  type ResolvedFocusState,
  type SessionFocus,
} from "./focus-state.js";
import { projectStoreDir } from "./paths.js";
import { getProjects } from "./projects.js";
import { getProjectWorktrees } from "./worktrees.js";

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
  // Optional parent session id (issue #353). Set when the session is
  // spawned from `controller sessions start --parent <id>` (or `--parent
  // self`, which the CLI resolves to the calling session via the
  // `CONTROLLER_SESSION_ID` env var the orchestrator injects). Read by
  // the `controller sessions list --parent <id>` filter and by the
  // coordinator pattern from #351. Set once at session creation; never
  // mutated afterwards. Absent when the session was started without a
  // parent (the common case for user-initiated sessions).
  parentId?: string;
  // The three focus-queue fields below are populated by `getSession`
  // and `getSessions` by merging in the Controller-owned sidecar under
  // `<controllerHome>/focus/<sessionId>.json` (e.g.
  // `~/Library/Application Support/Controller/focus/<sessionId>.json` on
  // macOS). They are *not* persisted on the orchestrator-owned
  // `.coding-agent/sessions/<id>.json` file: `saveSession` strips them
  // before writing so the session file stays in a shape any provider can
  // round-trip. After the Ada→Anita rename (#152) the `anita` CLI writes
  // its own session
  // to `.anita/sessions/`, so for new sessions the
  // `.coding-agent/sessions/<id>.json` file is Controller-only —
  // but legacy sessions can still be resumed through the agent
  // (which falls back to `.coding-agent/sessions/`), so stripping
  // remains the safe default. See #139 / #165.
  focusPinnedAt?: string;
  focusDoneAt?: string;
  // Set when the user explicitly unpins the session. Auto-pin on
  // creation/interaction respects this flag and will not re-pin a
  // session the user has deliberately removed from their focus queue.
  // Cleared on archive.
  userUnpinned?: boolean;
  // True when this session was created by the UI's empty-message
  // branch shortcut (issue #364 + #381 P2). The session is keyed by
  // a real provider thread id (the agent spawned at branch time
  // reports it via `run.started`) but the user hasn't typed the
  // first real turn yet. While unstarted, the composer pickers
  // (provider / model / mode) stay unlocked so the user can swap
  // the agent on their first turn — the same affordance a fresh
  // `POST /sessions` provides. Cleared by `persistSessionStart` on
  // the user's first follow-up resume, after which the session
  // behaves like any other and the pickers lock.
  unstarted?: boolean;
  // Provider-thread id (issue #382). Set on the first turn after a
  // branch — the branched session's `id` is a Controller-chosen UUID
  // (so the URL is stable before any agent runs), and the provider
  // picks its own thread id when the first turn starts. We capture
  // the provider's id here so subsequent turns can pass
  // `--resume <providerThreadId>` to the provider while the rest
  // of the Controller machinery (events file, URL, sidebar tree)
  // continues to key off the Controller UUID. Read by
  // `handleSessionStream`'s resume branch; absent for sessions that
  // were never branched (where `id` IS the provider thread id, as it
  // always was pre-#382).
  providerThreadId?: string;
  // Per-session override of the agent-inactivity watchdog timeout
  // (issue #386). When a session is expected to run a long blocking
  // tool call (e.g. `gh pr checks --watch` waiting on CI) the global
  // 5-minute watchdog trips well before the tool call returns. The
  // client can supply an override at session creation; it is
  // persisted here and re-applied on every resume so the user does
  // not have to re-pass it on follow-up turns. The inactivity
  // timeout is read in `handleSessionStream` at stream time and falls
  // back to the global `AGENT_INACTIVITY_TIMEOUT_MS` env var (and
  // then the 5-minute default) when absent.
  agentInactivityTimeoutMs?: number;
}

/**
 * A session without its `messages` history. The conversation transcript can
 * run to hundreds of KB (or megabytes) per session, so list endpoints that
 * only need metadata (the sidebar tree, the focus queue) return summaries to
 * keep the payload small. The full `SessionState` is still served by the
 * single-session endpoint.
 */
export type SessionSummary = Omit<SessionState, "messages">;

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
  // Controller-owned storage lives under the Controller home, not in the
  // project tree. See `projectStoreDir` for why: a project-local
  // `.coding-agent/` collides with the `anita` CLI's own session storage
  // and double-records every event.
  const base = projectStoreDir(projectPath);
  return {
    sessions: path.join(base, "sessions"),
    events: path.join(base, "events"),
    attachments: path.join(base, "attachments"),
  };
}

/**
 * Merge a sidecar focus record into a session-state object. The
 * session-state fields are the public API; the sidecar is internal
 * storage. When the sidecar is missing (default state) the focus
 * fields are dropped from the session so existing clients see the
 * expected absence of pin.
 */
function applyFocus(
  session: SessionState,
  focus: SessionFocus | null
): SessionState {
  if (!focus) {
    delete session.focusPinnedAt;
    delete session.focusDoneAt;
    delete session.userUnpinned;
    return session;
  }
  if (focus.focusPinnedAt) session.focusPinnedAt = focus.focusPinnedAt;
  else delete session.focusPinnedAt;
  if (focus.focusDoneAt) session.focusDoneAt = focus.focusDoneAt;
  else delete session.focusDoneAt;
  if (focus.userUnpinned) session.userUnpinned = focus.userUnpinned;
  else delete session.userUnpinned;
  return session;
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
  // Read the focus sidecars in a single pass so we can merge them
  // into the session list without a per-session round trip.
  const focusById = await listSessionFocuses();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const sessions: SessionState[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(dir, file);
    let session: SessionState;
    try {
      const content = await fs.readFile(filePath, "utf-8");
      session = JSON.parse(content) as SessionState;
    } catch {
      // Skip unreadable / malformed session files so one broken
      // file doesn't take down the whole list.
      continue;
    }
    applyFocus(session, focusById.get(session.id) ?? null);
    sessions.push(session);
  }
  sessions.sort(
    (a, b) =>
      new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
  );
  return sessions.filter((s) => s.status !== "archived");
}

/**
 * List sessions for a worktree without their conversation transcript. Used by
 * the sidebar/focus-queue endpoint, where shipping every transcript would
 * bloat the response to tens of megabytes for projects with many sessions.
 *
 * The summary is built from an explicit allowlist of metadata fields rather
 * than by omitting known-heavy ones: session files also carry undeclared,
 * provider-specific transcript fields (e.g. `conversationItems`) that are just
 * as large as `messages`, and an allowlist guarantees none of them leak into
 * the response as new fields are added.
 */
export async function getSessionSummaries(
  projectPath: string
): Promise<SessionSummary[]> {
  const sessions = await getSessions(projectPath);
  return sessions.map((s) => ({
    id: s.id,
    title: s.title,
    workingDirectory: s.workingDirectory,
    worktreeId: s.worktreeId,
    model: s.model,
    reasoningEffort: s.reasoningEffort,
    serviceTier: s.serviceTier,
    provider: s.provider,
    mode: s.mode,
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
    status: s.status,
    focusPinnedAt: s.focusPinnedAt,
    focusDoneAt: s.focusDoneAt,
    userUnpinned: s.userUnpinned,
    // `parentId` round-trips through the summary mapping so the CLI's
    // `sessions list --parent <id>` filter (issue #353) can match
    // sessions by their declared parent. Without this line the
    // allowlist would silently drop the field — `SessionSummary`
    // declares it via `Omit<SessionState, "messages">`, but the
    // implementation maps fields explicitly so the typing doesn't
    // save us here.
    parentId: s.parentId,
  }));
}

/**
 * Return every session whose `parentId` matches the supplied parent
 * (issue #351 + issue #353). Walks every project × worktree the
 * orchestrator knows about so a parent on the main worktree and a
 * child on a feature worktree are both found. The earlier
 * single-project implementation was the latent bug: a parent on the
 * Controller project's main worktree and a child on its `issue-351`
 * worktree live in different per-worktree stores
 * (`projectStoreDir(worktreePath)` keys by hash of the absolute
 * path), so scoping the search to one worktree missed the cross-
 * worktree case entirely. The `controller sessions children <id>`
 * CLI and the strict-archive rule both call into this helper, so
 * getting the walk right fixes both.
 *
 * Archived children are excluded (matching the rest of the surface).
 * The summary allowlist mirrors `getSessionSummaries` and adds
 * `parentId` so the children endpoint can echo it back to the
 * client (the sidebar's coordinator tree reads it).
 */
export async function listChildSessions(
  parentId: string
): Promise<SessionSummary[]> {
  const projects = await getProjects();
  const seen = new Set<string>();
  const collected: SessionState[] = [];
  for (const project of projects) {
    const worktrees = await getProjectWorktrees(project.id).catch(() => []);
    for (const worktree of worktrees) {
      // Per-worktree session store. `getSessions` already merges the
      // focus sidecar and filters archived; we keep that here so the
      // strict-archive caller doesn't have to repeat the filter.
      const sessions = await getSessions(worktree.path).catch(() => []);
      for (const session of sessions) {
        if (session.parentId !== parentId) continue;
        if (seen.has(session.id)) continue;
        seen.add(session.id);
        collected.push(session);
      }
    }
  }
  // Sort by last-active descending so the sidebar / CLI list reads
  // naturally. `getSessions` already sorts per-worktree, but a
  // cross-worktree merge can interleave, so re-sort.
  collected.sort(
    (a, b) =>
      new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
  );
  return collected.map((s) => ({
    id: s.id,
    title: s.title,
    workingDirectory: s.workingDirectory,
    worktreeId: s.worktreeId,
    model: s.model,
    reasoningEffort: s.reasoningEffort,
    serviceTier: s.serviceTier,
    provider: s.provider,
    mode: s.mode,
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
    status: s.status,
    focusPinnedAt: s.focusPinnedAt,
    focusDoneAt: s.focusDoneAt,
    userUnpinned: s.userUnpinned,
    parentId: s.parentId,
  }));
}

export async function getSession(
  projectPath: string,
  sessionId: string
): Promise<SessionState | null> {
  const filePath = path.join(
    storagePaths(projectPath).sessions,
    `${sessionId}.json`
  );
  // Read and parse in the same try block. The session file can
  // be rewritten mid-run (e.g. for legacy resumed sessions the
  // agent still co-writes it via the `.coding-agent/sessions/`
  // fallback), so a request can race the writer and observe an
  // empty or partially written file; both the read and the parse
  // must be non-fatal so the routes (e.g. `GET /sessions/:sessionId`,
  // `GET .../runtime`) keep returning a clean 404 instead of
  // turning a transient bad read into a 500.
  let session: SessionState;
  try {
    const content = await fs.readFile(filePath, "utf-8");
    session = JSON.parse(content) as SessionState;
  } catch {
    return null;
  }
  // Strip any legacy focus fields that may still be on the
  // session file from before issue #139 — the sidecar is the
  // source of truth now. We do this even before merging so a
  // stale on-disk value can't leak into the response.
  delete session.focusPinnedAt;
  delete session.focusDoneAt;
  delete session.userUnpinned;
  const focus = await readSessionFocus(sessionId);
  return applyFocus(session, focus);
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
    // session starts with a clean focus-queue slate. The sidecar is
    // deleted entirely so the focus state is fully reset.
    delete session.focusPinnedAt;
    delete session.focusDoneAt;
    delete session.userUnpinned;
    await fs.writeFile(filePath, JSON.stringify(session, null, 2));
    await deleteSessionFocus(sessionId);
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
  // Read the focus sidecar and the session file in parallel: the
  // former holds the prior focus state we may need to preserve
  // (e.g. an existing pin timestamp), and the latter confirms the
  // session exists so the routes can return 404 otherwise.
  const [existingFocus, sessionExists] = await Promise.all([
    readSessionFocus(sessionId),
    getSession(projectPath, sessionId),
  ]);
  if (!sessionExists) return null;

  let next: ResolvedFocusState;

  if (action === "pin") {
    next = {
      focusPinnedAt: existingFocus?.focusPinnedAt ?? new Date().toISOString(),
      focusDoneAt: undefined,
      // An explicit pin always overrides a previous unpin: the user
      // is telling us they want this session in the focus queue
      // right now.
      userUnpinned: undefined,
    };
  } else if (action === "unpin") {
    next = {
      focusPinnedAt: undefined,
      focusDoneAt: undefined,
      // Record that the user explicitly removed this session from
      // the focus queue. Future auto-pin attempts will no-op until
      // the session is archived (or the user pins it explicitly).
      userUnpinned: true,
    };
  } else {
    next = {
      focusPinnedAt: undefined,
      focusDoneAt: new Date().toISOString(),
      // "Done" is a workflow state, not a user opt-out of the focus
      // queue — clear any prior explicit-unpin signal.
      userUnpinned: undefined,
    };
  }

  const focus = buildSessionFocus(sessionId, next);
  await writeSessionFocus(focus);

  // Return the merged session so callers (the focus-action routes)
  // see the new state immediately without a third read.
  return getSession(projectPath, sessionId);
}

/**
 * Persist a user-supplied title for a session, overriding the title that
 * was auto-generated from the first user message. An empty/whitespace
 * title clears the field so the UI falls back to its placeholder. Returns
 * the updated session, or `null` if the session does not exist.
 */
export async function updateSessionTitle(
  projectPath: string,
  sessionId: string,
  title: string
): Promise<SessionState | null> {
  const filePath = path.join(
    storagePaths(projectPath).sessions,
    `${sessionId}.json`
  );
  // Read and parse in the same try block: the session file can be
  // rewritten mid-run (e.g. for legacy resumed sessions the agent
  // still co-writes it via the `.coding-agent/sessions/` fallback),
  // so a transient empty or partial file must not surface as an
  // unhandled exception to the route. Returning `null` matches the
  // pre-PR behavior (when this function went through `getSession`,
  // which had the same read+parse envelope).
  let session: SessionState;
  try {
    const content = await fs.readFile(filePath, "utf-8");
    session = JSON.parse(content) as SessionState;
  } catch {
    return null;
  }

  const trimmed = title.trim();
  if (trimmed) {
    session.title = trimmed;
  } else {
    delete session.title;
  }

  // `updateSessionTitle` must not touch the focus sidecar, and the
  // session file should keep the shape any provider can round-trip.
  // Strip the focus fields defensively in case a future change
  // accidentally re-introduces them — focus state lives in the
  // sidecar at `<controllerHome>/focus/<sessionId>.json`.
  delete session.focusPinnedAt;
  delete session.focusDoneAt;
  delete session.userUnpinned;

  await fs.writeFile(filePath, JSON.stringify(session, null, 2));
  return getSession(projectPath, sessionId);
}

/**
 * Pin a session to the focus queue if it is not already pinned and
 * not previously explicitly unpinned by the user. Returns the
 * (possibly updated) session, or `null` if the session does not
 * exist. If the session is already pinned (or blocked by
 * `userUnpinned`) the sidecar is left untouched and the existing
 * session is returned.
 */
export async function pinSessionIfNeeded(
  projectPath: string,
  sessionId: string
): Promise<SessionState | null> {
  // Read the session file to confirm the session exists and is
  // not archived. The focus sidecar is read separately.
  const session = await getSession(projectPath, sessionId);
  if (!session) return null;
  if (session.status === "archived") return session;

  const existing = await readSessionFocus(sessionId);
  if (existing?.focusPinnedAt) return session;
  if (existing?.userUnpinned) return session;

  const focus = buildSessionFocus(
    sessionId,
    resolveSessionFocusState(existing)
  );
  await writeSessionFocus(focus);
  return getSession(projectPath, sessionId);
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

/**
 * Read just the last `limit` events from a session's append-only JSONL file
 * (issue #404). Designed for the "open a long conversation fast" path:
 * the client only paints the bottom of the timeline on first open, so the
 * server used to ship (and JSON.parse + dedupe) thousands of events the
 * user wouldn't see for minutes. The events file is append-only
 * (`appendEvent` is the only writer and always writes to EOF), so the
 * last N lines are a constant-memory scan from EOF backward.
 *
 * Returns events in chronological order (oldest first) so the client can
 * prepend them as-is. When the file has fewer than `limit` events the
 * full transcript is returned; when the file is empty, the empty array.
 * Malformed tail lines are skipped (same behavior as the existing
 * `getEvents` would have for them) so a half-flushed append never wedges
 * the open path.
 *
 * Read uses `fs.open` + chunked backward reads so we only allocate the
 * last N lines rather than reading the whole file into memory and then
 * discarding the head. A `before` id may also be supplied to "give me
 * the page ending at (but not including) this event id" — used by the
 * client when the user scrolls up for the previous page. `before`
 * requires `limit > 0`.
 */
export async function getEventsTail(
  projectPath: string,
  sessionId: string,
  options: { limit?: number; before?: string } = {}
): Promise<AgentEvent[]> {
  const limit = options.limit ?? 0;
  const before = options.before;
  if (limit <= 0) {
    throw new Error("getEventsTail requires a positive limit");
  }
  if (before !== undefined && before.length === 0) {
    throw new Error("getEventsTail `before` must be a non-empty event id");
  }
  const filePath = path.join(
    storagePaths(projectPath).events,
    `${sessionId}.jsonl`
  );
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return [];
  }
  if (size === 0) return [];
  // The read loop walks the file from EOF backward in chunked byte
  // reads, splitting on `\n`, until one of:
  //
  //   (a) `before` is unset and we've collected `limit` lines
  //       (the "give me the last N events" case),
  //   (b) `before` is set and we've found the anchor line AND
  //       collected `limit` lines OLDER than the anchor (the
  //       pagination case). The caller wants the page that ends
  //       *just before* the anchor in chronological order, so we
  //       must read past the anchor by `limit` lines. The
  //       original implementation capped the read budget at
  //       `limit + 2` lines from EOF, which stranded 800+ events
  //       on a 1000-event transcript (PR review P1 from
  //       chatgpt-codex-connector on #405): the anchor lived
  //       outside the read window, the page kept shrinking
  //       toward zero, and the client latched
  //       `reachedTranscriptStart` while hundreds of turns
  //       remained in the file.
  //   (c) we've consumed the whole file (anchor not found — the
  //       caller passed a stale id, or the file was truncated
  //       mid-session; we return `[]` below).
  //
  // Reads are 64KiB and aligned to newline boundaries so we don't
  // depend on UTF-8 multi-byte characters being split across a
  // chunk — the JSONL payload is required to be one line per
  // event so a `\n` is always a line boundary.
  const readChunkSize = 64 * 1024;
  // `linesAfterAnchor` counts lines we've read that are NEWER
  // than the anchor in file order (i.e. the lines we encountered
  // BEFORE the anchor while reading backward from EOF). It does
  // NOT count the anchor itself. The page the caller wants is
  // the `limit` lines that come AFTER the anchor in file order
  // (= the lines we encounter AFTER the anchor while continuing
  // to read backward, which are OLDER in file order).
  const tailLines: string[] = [];
  const anchorNeedle = before !== undefined ? `"id":"${before}"` : null;
  let foundAnchor = false;
  let linesBeforeAnchor = 0;
  const fd = openSync(filePath, "r");
  try {
    let position = size;
    let pending = Buffer.alloc(0);
    while (position > 0 || pending.length > 0) {
      if (before === undefined && tailLines.length >= limit) {
        // No anchor — we just need the last `limit` lines.
        break;
      }
      if (before !== undefined && foundAnchor && linesBeforeAnchor >= limit) {
        // We've collected `limit` lines older than the anchor.
        // The response will be these `limit` lines in
        // chronological order; the anchor itself and everything
        // newer is already in the client's loaded page.
        break;
      }
      if (position > 0) {
        const readSize = Math.min(readChunkSize, position);
        position -= readSize;
        const buf = Buffer.alloc(readSize);
        readSync(fd, buf, 0, readSize, position);
        pending = Buffer.concat([buf, pending]);
      }
      let newlineIdx = pending.length;
      let madeProgress = false;
      while (newlineIdx > 0) {
        if (before === undefined && tailLines.length >= limit) break;
        if (
          before !== undefined &&
          foundAnchor &&
          linesBeforeAnchor >= limit
        ) {
          break;
        }
        const prev = pending.lastIndexOf(0x0a, newlineIdx - 1);
        if (prev < 0) break;
        const line = pending
          .subarray(prev + 1, newlineIdx)
          .toString("utf-8")
          .replace(/\r$/, "");
        // Skip empty lines — they happen at the tail when the
        // file ends with `\n` (the bytes after the last newline
        // are an empty string) and at the head when the file has
        // a leading newline. Counting them toward the line
        // budget would shrink the page we hand back without any
        // benefit; drop them at extraction time.
        if (line) {
          tailLines.push(line);
          if (anchorNeedle !== null && !foundAnchor && line.includes(anchorNeedle)) {
            // First time we see the anchor — keep going, we
            // need to collect `limit` lines after it (older
            // in file order).
            foundAnchor = true;
          } else if (foundAnchor) {
            // Line is older than the anchor in file order
            // (we're past the anchor in the backward scan).
            linesBeforeAnchor += 1;
          }
        }
        newlineIdx = prev;
        madeProgress = true;
      }
      if (madeProgress) {
        // Trim the consumed suffix off `pending`. `newlineIdx` is
        // the start of the unconsumed head; if it's > 0 there is
        // a head-of-file partial line waiting for the next chunk;
        // if it's 0 the inner loop consumed everything down to
        // byte 0.
        pending =
          newlineIdx > 0 ? pending.subarray(0, newlineIdx) : Buffer.alloc(0);
      } else if (position === 0) {
        // We've read the whole file and the remaining `pending`
        // is a head-of-file line with no trailing newline (the
        // file may legitimately lack a trailing newline if the
        // last append is mid-flight). Push it as the oldest line
        // so it survives into the result. Same semantics as
        // `getEvents`'s `filter(Boolean)` on the split: a
        // non-empty head with no trailing newline is still a line.
        if (pending.length > 0) {
          tailLines.push(pending.toString("utf-8"));
          if (anchorNeedle !== null && !foundAnchor && pending.toString("utf-8").includes(anchorNeedle)) {
            foundAnchor = true;
          } else if (foundAnchor) {
            linesBeforeAnchor += 1;
          }
        }
        pending = Buffer.alloc(0);
      } else {
        // No newline found in this chunk — `pending` is a single
        // line that spans the entire chunk boundary. Read more.
        continue;
      }
    }
  } finally {
    closeSync(fd);
  }
  // If `before` was requested but the anchor was never found, the
  // caller passed a stale id (or the file was truncated mid-session
  // and the anchor fell off). Surface an empty page — the client's
  // `reachedTranscriptStart` latch will turn this into "we've
  // reached the top" on its next scroll, which is the right
  // observable behavior even though the underlying state is
  // inconsistent.
  if (before !== undefined && !foundAnchor) {
    return [];
  }
  // Walk the collected lines in reverse (oldest-first) and parse
  // them. With `before` set, `tailLines` holds the anchor + the
  // `limit` lines that are older than it in file order (and a
  // few "wasted" lines newer than the anchor that we had to
  // read to find it — those get dropped by the `if (found)` /
  // `break` path below). With `before` unset, `tailLines`
  // holds exactly the last `limit` lines in file order.
  const ordered = tailLines.reverse();
  const events: AgentEvent[] = [];
  let sawAnchor = false;
  for (const line of ordered) {
    if (!line) continue;
    let event: AgentEvent;
    try {
      event = JSON.parse(line) as AgentEvent;
    } catch {
      // Malformed tail line: skip it (matches `getEvents` tolerating
      // bad JSON via the broader read+parse, which would also
      // produce an exception; the caller is in charge of retrying
      // or showing an error). Don't break the loop — keep reading
      // so the page size is honored as best we can.
      continue;
    }
    if (before !== undefined && event.id === before) {
      // Anchor reached. Everything we already pushed into
      // `events` was read AFTER the anchor in the backward scan,
      // which means it's OLDER than the anchor in file order —
      // exactly the page the caller asked for. The anchor
      // itself and anything newer is already in the client's
      // loaded page; drop them.
      sawAnchor = true;
      break;
    }
    events.push(event);
  }
  if (before !== undefined && !sawAnchor) {
    // The anchor was inside `tailLines` (the read loop found
    // it) but the post-process JSON.parse couldn't parse it
    // (e.g. the raw-line prefilter matched a substring that
    // isn't actually the anchor's id). Treat as "anchor not
    // found" so the client latches the end-of-transcript
    // state instead of silently prepending garbage.
    return [];
  }
  // Cap the result at `limit` so callers get exactly the page
  // size they asked for even when the file has more lines than
  // the read window.
  if (events.length > limit) {
    events.splice(0, events.length - limit);
  }
  return events;
}

/**
 * Ensure session and event directories exist, then save/update a
 * session file. Focus fields are stripped from the payload before
 * writing so the on-disk file stays in a shape any provider can
 * round-trip without losing Controller-managed fields. After the
 * Ada→Anita rename (#152) the `anita` CLI writes its own session
 * to `.anita/sessions/`, so for new sessions
 * `.coding-agent/sessions/<id>.json` is Controller-only — but
 * legacy sessions can still be resumed through the agent (which
 * falls back to `.coding-agent/sessions/`), and any future
 * provider that re-introduces an on-disk writer would silently
 * drop unknown fields. Focus state is persisted separately in
 * `<controllerHome>/focus/<sessionId>.json` (e.g.
 * `~/Library/Application Support/Controller/focus/<sessionId>.json` on
 * macOS) via `writeSessionFocus`. See #139 / #165.
 */
export async function saveSession(
  projectPath: string,
  session: SessionState
): Promise<void> {
  const { sessions } = storagePaths(projectPath);
  await fs.mkdir(sessions, { recursive: true });
  const filePath = path.join(sessions, `${session.id}.json`);
  // Strip Controller-managed focus fields before writing so the
  // session file stays in a shape any provider can round-trip.
  // Focus state lives separately in `<controllerHome>/focus/<sessionId>.json`.
  const persisted: SessionState = { ...session };
  delete persisted.focusPinnedAt;
  delete persisted.focusDoneAt;
  delete persisted.userUnpinned;
  await fs.writeFile(filePath, JSON.stringify(persisted, null, 2));
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
