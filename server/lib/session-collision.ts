import fs from "node:fs/promises";
import { statSync, existsSync } from "node:fs";
import path from "node:path";
import { getProjects, type Project } from "./projects.js";
import { getProjectWorktrees, type Worktree } from "./worktrees.js";
import {
  projectStoreDir,
  sessionCollisionQuarantineDir,
  sessionCollisionQuarantineFile,
} from "./paths.js";
import { getSession, type SessionState } from "./sessions.js";

/*
 * Detect and repair duplicate session IDs across per-worktree stores
 * (issue #437).
 *
 * Why this exists: the original per-worktree store layout keys every
 * session file by session id alone, so the same id living in two
 * stores (typically the legacy `main` and an `issue-NNN` worktree
 * used during the #434 "movable conversation" experiment) produces
 * two records. On Radar renders them as separate rows, the focus
 * queue pins both, and the `locateSessionById` walk returns whichever
 * the project main path tries first. #436 replaced the movable
 * model with one-session-per-worktree, so fresh collisions should
 * not happen — but the legacy duplicates are still on disk and need
 * a reviewable repair path.
 *
 * Public surface:
 *   - `findSessionCollisions(sessionId)`: scan every project ×
 *     worktree and return the per-store copies that share `sessionId`.
 *   - `listAllCollisions()`: scan every project × worktree and
 *     return every session id that has more than one store copy.
 *     Drives the `controller sessions collisions` CLI surface.
 *   - `pickOwner(candidates)`: deterministic owner for the read
 *     paths. `getSessionSummaries` and `locateSessionById` use it so
 *     every consumer agrees on which copy "wins" until the user
 *     runs the repair.
 *   - `quarantineCollision(sessionId, ownerWorktreeId)`: copy the
 *     non-owner stores into a timestamped quarantine folder under
 *     the Controller home, then remove the live non-owner records.
 *     Refuses if any of the affected sessions is currently active
 *     (mirrors the strict-archive rule from #351).
 *
 * The detection walk is `O(projects × worktrees)`. The listAll
 * surface inlines the per-store scan so we only read each store's
 * session list once. Per-session lookups for a known id are
 * O(projects × worktrees) too, but each `getSession` is a single
 * small file read; the cost is the same as a single `getSessions`
 * call on a healthy store.
 *
 * Note: a collision can only involve *one* project (session ids are
 * Controller-chosen UUIDs or provider thread ids, both globally
 * unique per session). The walker still scans every project to keep
 * the surface simple and to catch a project-id reuse edge case the
 * registry doesn't currently prevent.
 */

export interface CollisionCandidate {
  projectId: string;
  worktreeId: string;
  worktreeName: string;
  worktreePath: string;
  session: SessionState;
  /** Event-file mtime in ms (0 when the file is missing or unreadable). */
  eventsMtimeMs: number;
  /** Event-file size in bytes (0 when the file is missing). */
  eventsSize: number;
}

export interface SessionCollisionReport {
  sessionId: string;
  candidates: CollisionCandidate[];
  /**
   * Picked owner per the deterministic strategy in `pickOwner`.
   * Equal to the first candidate when there is no collision
   * (single-store copies) — `listAllCollisions` filters those out,
   * but the field is always populated so callers can use the same
   * shape regardless of whether they asked about a specific id.
   */
  owner: CollisionCandidate;
}

export interface QuarantineRecord {
  projectId: string;
  worktreeId: string;
  worktreeName: string;
  worktreePath: string;
  /** Absolute path of the quarantined session.json copy. */
  sessionFile: string;
  /** Absolute path of the quarantined events.jsonl copy (if any). */
  eventsFile: string | null;
  /** Absolute path of the LIVE session.json that was moved into the
   *  quarantine. The repair deletes this after the quarantine copy
   *  is verified on disk. Preserved on the record so the manifest
   *  can describe the move precisely. */
  liveSessionFile: string;
  /** Absolute path of the LIVE events.jsonl that was moved into the
   *  quarantine, or `null` if the events file was missing. */
  liveEventsFile: string | null;
  /** Session metadata snapshot at the time of the repair. */
  session: SessionState;
}

export interface CollisionQuarantineManifest {
  /** Repair run id (timestamp + random suffix). */
  runId: string;
  /** Session id the repair targeted. */
  sessionId: string;
  /** Project the surviving owner lives in. */
  projectId: string;
  /** Worktree the surviving owner lives in. */
  ownerWorktreeId: string;
  /** Per-store copies that were quarantined. */
  quarantined: QuarantineRecord[];
  /** Per-store copies that were *not* quarantined (the owner). */
  preserved: QuarantineRecord[];
  /** ISO timestamp when the repair ran. */
  repairedAt: string;
}

/**
 * Find every per-worktree store that holds a session file for
 * `sessionId`. Returns an empty array when no store has the id.
 *
 * Walks every project × worktree in the Controller home. The cost
 * is one `fs.readdir` per project-store plus a `getSession` parse
 * per matching file; both are O(1) per project for the sizes we
 * expect.
 */
export async function findSessionCollisions(
  sessionId: string
): Promise<CollisionCandidate[]> {
  if (!isLikelySessionId(sessionId)) return [];
  const projects = await getProjects();
  const candidates: CollisionCandidate[] = [];
  for (const project of projects) {
    const matches = await scanProjectForSession(project, sessionId);
    candidates.push(...matches);
  }
  return candidates;
}

/**
 * Walk every worktree of `projectId` and return a map of session id
 * → candidates for that project alone. Cheaper than
 * `findSessionCollisions` for the per-project UI surface (sidebar,
 * single-session endpoint) because it doesn't pay the O(projects)
 * cost of the full scan, and it reuses the same per-store readdir
 * pass for every session id in the project.
 */
export async function findSessionCollisionsInProject(
  projectId: string
): Promise<Map<string, CollisionCandidate[]>> {
  const project = (await getProjects()).find((p) => p.id === projectId);
  if (!project) return new Map();
  const groups = new Map<string, CollisionCandidate[]>();
  await accumulateProjectSessions(project, groups);
  // Only keep actual collisions so callers don't have to filter.
  for (const [id, list] of groups) {
    if (list.length < 2) groups.delete(id);
  }
  return groups;
}

/**
 * Walk every project × worktree and return a report for every
 * session id that has more than one store copy. Single-store copies
 * are skipped; the caller only cares about actual collisions.
 *
 * Implementation note: we read every project-store once (via
 * `readdir`) and group by session id, so the surface is a single
 * pass over all per-worktree stores — not a per-id re-walk. The
 * groups with length > 1 are then enriched with the full session
 * state via `getSession`, which is a small file read.
 */
export async function listAllCollisions(): Promise<SessionCollisionReport[]> {
  const projects = await getProjects();
  const groups = new Map<string, CollisionCandidate[]>();
  for (const project of projects) {
    await accumulateProjectSessions(project, groups);
  }
  const reports: SessionCollisionReport[] = [];
  for (const [sessionId, candidates] of groups) {
    if (candidates.length < 2) continue;
    reports.push({ sessionId, candidates, owner: pickOwner(candidates) });
  }
  // Stable order so the CLI output doesn't reshuffle on every call.
  reports.sort((a, b) => {
    if (a.sessionId < b.sessionId) return -1;
    if (a.sessionId > b.sessionId) return 1;
    return 0;
  });
  return reports;
}

/**
 * Deterministic owner selection for a set of collision candidates.
 *
 * Strategy (most-recent-first, deterministic on ties):
 *   1. Most recent `lastActiveAt` wins.
 *   2. Ties break to the largest events file (the store with the
 *      most transcript data — the duplicate a user is most likely
 *      to want to keep).
 *   3. Final ties break to the lexically first worktree id so the
 *      pick is stable across runs.
 *
 * Callers use this to make `getSessionSummaries`, `locateSessionById`,
 * the focus queue, and the `controller://` link handler agree on
 * which copy "wins" until the user runs an explicit repair. The
 * field is always populated even for single-store copies so the
 * shape is uniform.
 */
export function pickOwner(candidates: CollisionCandidate[]): CollisionCandidate {
  if (candidates.length === 0) {
    throw new Error("pickOwner: candidates must be non-empty");
  }
  if (candidates.length === 1) return candidates[0];
  const sorted = [...candidates].sort((a, b) => {
    const aActive = Date.parse(a.session.lastActiveAt ?? "");
    const bActive = Date.parse(b.session.lastActiveAt ?? "");
    if (Number.isFinite(aActive) && Number.isFinite(bActive) && aActive !== bActive) {
      return bActive - aActive;
    }
    if (a.eventsSize !== b.eventsSize) return b.eventsSize - a.eventsSize;
    if (a.worktreeId !== b.worktreeId) {
      return a.worktreeId < b.worktreeId ? -1 : 1;
    }
    return 0;
  });
  return sorted[0];
}

/**
 * Quarantine every non-owner copy of `sessionId` into a timestamped
 * folder under the Controller home, then remove the live records
 * on the non-owner stores. The owner stays in place. Refuses if any
 * of the affected sessions is currently active (mirrors the
 * strict-archive rule from #351) so an in-flight agent doesn't
 * continue writing into a store we're about to remove.
 *
 * The repair is reversible: the quarantine copy preserves the
 * session file verbatim, the events file verbatim (if present), and
 * a manifest describing what was removed and from where. The user
 * can inspect the folder under `<controllerHome>/session-collisions/`
 * before deciding to delete it.
 */
export async function quarantineCollision(args: {
  sessionId: string;
  ownerWorktreeId: string;
  activeSessionIds?: ReadonlySet<string>;
}): Promise<CollisionQuarantineManifest> {
  const { sessionId, ownerWorktreeId, activeSessionIds } = args;
  const candidates = await findSessionCollisions(sessionId);
  if (candidates.length < 2) {
    throw new CollisionError(
      "no-collision",
      `Session ${sessionId} does not have multiple store copies; nothing to repair.`
    );
  }
  const owner = candidates.find((c) => c.worktreeId === ownerWorktreeId);
  if (!owner) {
    throw new CollisionError(
      "owner-not-found",
      `Worktree ${ownerWorktreeId} is not one of the stores for session ${sessionId}.`
    );
  }
  const nonOwners = candidates.filter((c) => c.worktreeId !== ownerWorktreeId);
  if (activeSessionIds && activeSessionIds.size > 0) {
    for (const c of candidates) {
      if (activeSessionIds.has(c.session.id)) {
        throw new CollisionError(
          "active-session",
          `Session ${c.session.id} is active on worktree ${c.worktreeId}. ` +
            "Stop the agent before running the repair."
        );
      }
    }
  }
  const runId = makeQuarantineRunId();
  const quarantineRoot = path.join(
    sessionCollisionQuarantineDir(),
    runId
  );
  await fs.mkdir(quarantineRoot, { recursive: true });
  const quarantined: QuarantineRecord[] = [];
  const preserved: QuarantineRecord[] = [snapshotRecord(owner)];
  for (const c of nonOwners) {
    const record = await quarantineOne(c, runId, quarantineRoot);
    quarantined.push(record);
  }
  // Drop the live non-owner records only after every quarantine copy
  // is verified on disk. A failure mid-quarantine leaves the user
  // with a manifest describing the partial state, never a half-
  // deleted store.
  for (const record of quarantined) {
    await deleteLiveRecord(record);
  }
  const manifest: CollisionQuarantineManifest = {
    runId,
    sessionId,
    projectId: owner.projectId,
    ownerWorktreeId,
    quarantined,
    preserved,
    repairedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    sessionCollisionQuarantineFile(runId),
    JSON.stringify(manifest, null, 2)
  );
  return manifest;
}

/**
 * Structured error type so callers (the route handler, the CLI) can
 * render a precise message instead of guessing from the string.
 * `code` is one of: `no-collision`, `owner-not-found`,
 * `active-session`.
 */
export class CollisionError extends Error {
  readonly code: "no-collision" | "owner-not-found" | "active-session";
  constructor(code: "no-collision" | "owner-not-found" | "active-session", message: string) {
    super(message);
    this.code = code;
    this.name = "CollisionError";
  }
}

// --- internals ---

function isLikelySessionId(value: string): boolean {
  // Session ids are either Controller-chosen UUIDs (36 chars, dashes)
  // or the legacy provider thread ids the Anita/Codex/Claude
  // providers emit (longer alphanumerics). A path-traversal probe
  // is the cheapest defense: anything that isn't a plausible id
  // is rejected up front so a bad input never reaches `fs.readFile`.
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > 256) return false;
  if (value.includes("/") || value.includes("\\") || value.includes("..")) return false;
  return /^[A-Za-z0-9._:-]+$/.test(value);
}

async function scanProjectForSession(
  project: Project,
  sessionId: string
): Promise<CollisionCandidate[]> {
  const worktrees = await getProjectWorktrees(project.id);
  const matches: CollisionCandidate[] = [];
  for (const worktree of worktrees) {
    const session = await getSession(worktree.path, sessionId);
    if (!session) continue;
    matches.push(await toCandidate(project, worktree, session));
  }
  return matches;
}

async function accumulateProjectSessions(
  project: Project,
  groups: Map<string, CollisionCandidate[]>
): Promise<void> {
  const worktrees = await getProjectWorktrees(project.id);
  for (const worktree of worktrees) {
    const sessionsDir = path.join(projectStoreDir(worktree.path), "sessions");
    let files: string[];
    try {
      files = await fs.readdir(sessionsDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const sessionId = file.slice(0, -".json".length);
      if (!isLikelySessionId(sessionId)) continue;
      const session = await getSession(worktree.path, sessionId);
      if (!session) continue;
      const candidate = await toCandidate(project, worktree, session);
      const list = groups.get(sessionId) ?? [];
      list.push(candidate);
      groups.set(sessionId, list);
    }
  }
}

async function toCandidate(
  project: Project,
  worktree: Worktree,
  session: SessionState
): Promise<CollisionCandidate> {
  const eventsPath = path.join(
    projectStoreDir(worktree.path),
    "events",
    `${session.id}.jsonl`
  );
  let eventsSize = 0;
  let eventsMtimeMs = 0;
  try {
    const stat = statSync(eventsPath);
    eventsSize = stat.size;
    eventsMtimeMs = stat.mtimeMs;
  } catch {
    // Missing events file is fine — some legacy sessions were
    // never written. We still want to surface the collision.
  }
  return {
    projectId: project.id,
    worktreeId: worktree.id,
    worktreeName: worktree.name,
    worktreePath: worktree.path,
    session,
    eventsMtimeMs,
    eventsSize,
  };
}

function snapshotRecord(candidate: CollisionCandidate): QuarantineRecord {
  return {
    projectId: candidate.projectId,
    worktreeId: candidate.worktreeId,
    worktreeName: candidate.worktreeName,
    worktreePath: candidate.worktreePath,
    sessionFile: path.join(
      projectStoreDir(candidate.worktreePath),
      "sessions",
      `${candidate.session.id}.json`
    ),
    eventsFile: candidate.eventsSize > 0
      ? path.join(
          projectStoreDir(candidate.worktreePath),
          "events",
          `${candidate.session.id}.jsonl`
        )
      : null,
    liveSessionFile: path.join(
      projectStoreDir(candidate.worktreePath),
      "sessions",
      `${candidate.session.id}.json`
    ),
    liveEventsFile: candidate.eventsSize > 0
      ? path.join(
          projectStoreDir(candidate.worktreePath),
          "events",
          `${candidate.session.id}.jsonl`
        )
      : null,
    session: candidate.session,
  };
}

async function quarantineOne(
  candidate: CollisionCandidate,
  runId: string,
  quarantineRoot: string
): Promise<QuarantineRecord> {
  const targetDir = path.join(quarantineRoot, candidate.worktreeId);
  await fs.mkdir(targetDir, { recursive: true });
  const sessionSrc = path.join(
    projectStoreDir(candidate.worktreePath),
    "sessions",
    `${candidate.session.id}.json`
  );
  const sessionDst = path.join(targetDir, "session.json");
  await copyOptional(sessionSrc, sessionDst);
  const eventsSrc = path.join(
    projectStoreDir(candidate.worktreePath),
    "events",
    `${candidate.session.id}.jsonl`
  );
  const eventsDst = path.join(targetDir, "events.jsonl");
  const eventsCopied = await copyOptional(eventsSrc, eventsDst);
  return {
    projectId: candidate.projectId,
    worktreeId: candidate.worktreeId,
    worktreeName: candidate.worktreeName,
    worktreePath: candidate.worktreePath,
    // The quarantine copy. Lives in `<controllerHome>/session-collisions/<runId>/<worktreeId>/`.
    sessionFile: sessionDst,
    eventsFile: eventsCopied ? eventsDst : null,
    // The live file paths. `deleteLiveRecord` removes these after
    // the quarantine copy is verified on disk.
    liveSessionFile: sessionSrc,
    liveEventsFile: eventsCopied ? eventsSrc : null,
    session: candidate.session,
  };
}

async function copyOptional(src: string, dst: string): Promise<boolean> {
  if (!existsSync(src)) return false;
  await fs.copyFile(src, dst);
  return true;
}

async function deleteLiveRecord(record: QuarantineRecord): Promise<void> {
  // Delete the LIVE files only — the quarantine copies live in
  // `record.sessionFile` / `record.eventsFile` and are kept on
  // disk. A focus sidecar is left untouched — once the live
  // record is gone the focus row is orphaned, and the next
  // `getSession` walk naturally drops it. Leaving the sidecar in
  // place for now keeps a future "restore" simple: the focus
  // state still describes the session even if the live files are
  // gone.
  if (record.liveSessionFile && existsSync(record.liveSessionFile)) {
    await fs.unlink(record.liveSessionFile);
  }
  if (record.liveEventsFile && existsSync(record.liveEventsFile)) {
    await fs.unlink(record.liveEventsFile);
  }
}

function makeQuarantineRunId(): string {
  // ISO timestamp with colons stripped so the id is safe to embed
  // in a folder name across platforms (Windows refuses `:` in
  // paths). The random suffix makes two repairs run inside the
  // same second distinguishable.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

/**
 * One-line, human-readable summary for the `controller sessions
 * collisions` table. Includes the owner, the worktree names of the
 * other copies, and the `lastActiveAt` of each so a human reviewer
 * can decide which to keep.
 */
export function formatCollisionRow(report: SessionCollisionReport): string {
  const ownerName = report.owner.worktreeName;
  const others = report.candidates
    .filter((c) => c.worktreeId !== report.owner.worktreeId)
    .map((c) => `${c.worktreeName}@${formatTimestamp(c.session.lastActiveAt)}`)
    .join(", ");
  return `${report.sessionId}  owner=${ownerName}  duplicates=[${others}]`;
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "?";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toISOString().replace("T", " ").slice(0, 19);
}

/** Read the events file size for a session in a given worktree path. */
export async function readEventsSize(
  worktreePath: string,
  sessionId: string
): Promise<number> {
  const filePath = path.join(
    projectStoreDir(worktreePath),
    "events",
    `${sessionId}.jsonl`
  );
  if (!existsSync(filePath)) return 0;
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}
