import { getProjects, type Project } from "./projects.js";
import { getProjectWorktrees } from "./worktrees.js";
import { getSession } from "./sessions.js";
import {
  findSessionCollisionsInProject,
  pickOwner,
  type CollisionCandidate,
} from "./session-collision.js";

/*
 * Shared session locator (issue #339 review).
 *
 * The original wake / goal / monitor ID-only handlers (and the wakes
 * consumer in `wakes.ts`, and the goal-evaluator's `locateSession` dep)
 * each rolled their own "find which project owns a session" walk. Every
 * one of them stopped at `project.path` — the *main* worktree's path.
 * Sessions created in a non-main worktree live under
 * `projectStoreDir(worktree.path)`, so the original lookup returned
 * 404 (or null) for the majority of projects with more than one
 * worktree.
 *
 * This module is the single source of truth: enumerate every project,
 * enumerate every worktree, and try `getSession` against each
 * worktree path. The lookup cost is `O(projects × worktrees)` per
 * resolution — fine for the sizes we expect and identical to what a
 * future UI sidebar would do. Returning the worktree-id alongside the
 * project id lets callers route the queue advance through the
 * `resolveWorktree` plumbing instead of guessing the main worktree.
 *
 * Issue #437 owner-pick: when the same session id lives in more than
 * one per-worktree store (a legacy collision from the #434
 * "movable conversation" experiment), this helper returns the
 * deterministic owner via `pickOwner` — the most-recently-active
 * copy, ties broken by events-file size. Without this, the locator
 * silently chose whichever store the main-worktree-first walk hit
 * first, regardless of which copy had the fresher transcript. The
 * picked owner is exposed as `located.duplicates` so the route
 * handler can surface a "duplicate copy" diagnostic on the
 * single-session endpoint.
 */

export interface LocatedSession {
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>;
  projectId: string;
  worktreeId: string;
  /** Absolute filesystem path of the worktree that owns the session. */
  worktreePath: string;
  /**
   * Other per-worktree stores that hold a record for the same
   * session id (issue #437). Populated when a collision is
   * detected; empty/absent otherwise. The list omits the picked
   * owner's worktree — it's implicit in `worktreeId` /
   * `worktreePath` above.
   */
  duplicates?: Array<{
    worktreeId: string;
    worktreeName: string;
    worktreePath: string;
    lastActiveAt: string;
    eventsSize: number;
  }>;
}

/**
 * Walk every project × worktree pair and return the picked owner
 * for `sessionId`. Returns `null` when the session id is unknown —
 * the session was archived + deleted, or never existed.
 */
export async function locateSessionById(
  sessionId: string
): Promise<LocatedSession | null> {
  const projects = await getProjects();
  for (const project of projects) {
    const located = await locateSessionInProject(project, sessionId);
    if (located) return located;
  }
  return null;
}

/**
 * Path-only variant for the wakes consumer (issue #339 review). The
 * consumer only needs the project id + worktree path to fire the
 * queue advance; re-reading the full session state would be wasted
 * I/O on every scheduler tick.
 *
 * Implemented as a `getSession`-based walk so it shares the canonical
 * `projectStoreDir` resolution with the rest of the codebase — no
 * hand-rolled `path.resolve` math that could drift out of sync. The
 * cost is one `getSession` parse per worktree (the JSON file is
 * small), and the wakes consumer calls this exactly once per
 * session id per tick.
 */
export interface LocatedSessionPath {
  projectId: string;
  worktreeId: string;
  worktreePath: string;
}

export async function locateSessionPath(
  sessionId: string
): Promise<LocatedSessionPath | null> {
  const located = await locateSessionById(sessionId);
  if (!located) return null;
  return {
    projectId: located.projectId,
    worktreeId: located.worktreeId,
    worktreePath: located.worktreePath,
  };
}

/**
 * Look up a session within one project by enumerating that project's
 * worktrees (main + non-main). When the session id lives in more
 * than one per-worktree store, the collisions walk picks the
 * deterministic owner and exposes the others via
 * `LocatedSession.duplicates`.
 */
async function locateSessionInProject(
  project: Project,
  sessionId: string
): Promise<LocatedSession | null> {
  // First try the main worktree — most legacy sessions live there.
  const mainCandidate = await getSession(project.path, sessionId);
  // Collision short-circuit: if the main store has the id AND
  // another worktree in the project also has it, skip the
  // happy-path return and fall through to the collision-aware
  // path below. The pre-#437 implementation returned the main
  // copy here regardless of which store was fresher, so the
  // collision-aware path is the only place the picked owner
  // can surface.
  if (mainCandidate) {
    if (await isCollision(project.id, sessionId)) {
      return await locateCollidingSession(project, sessionId);
    }
    return {
      session: mainCandidate,
      projectId: project.id,
      worktreeId: mainCandidate.worktreeId ?? "",
      worktreePath: project.path,
    };
  }
  // Main didn't have it. Fall through to non-main worktrees via
  // the registered registry. A non-main-only collision is rare
  // (collisions only happen with the main path) but possible if
  // a worktree was added after the colliding session was created
  // — handle it the same way the main-path branch does.
  const worktrees = await getProjectWorktrees(project.id).catch(() => []);
  for (const worktree of worktrees) {
    if (worktree.path === project.path) continue; // already tried main
    const candidate = await getSession(worktree.path, sessionId);
    if (candidate) {
      if (await isCollision(project.id, sessionId)) {
        return await locateCollidingSession(project, sessionId);
      }
      return {
        session: candidate,
        projectId: project.id,
        worktreeId: candidate.worktreeId ?? worktree.id,
        worktreePath: worktree.path,
      };
    }
  }
  return null;
}

/**
 * Cheap predicate — used by the happy path to avoid running the full
 * collision walk when the session is unique. Returns `true` when the
 * session id has more than one store copy in `projectId`.
 */
async function isCollision(projectId: string, sessionId: string): Promise<boolean> {
  const groups = await findSessionCollisionsInProject(projectId);
  return groups.has(sessionId);
}

/**
 * Build a `LocatedSession` for a colliding session id. Picks the
 * owner via `pickOwner` and returns the non-owner copies on
 * `duplicates`. Excludes the owner itself from the duplicates list
 * — it's implicit in the top-level fields.
 */
async function locateCollidingSession(
  project: Project,
  sessionId: string
): Promise<LocatedSession | null> {
  const groups = await findSessionCollisionsInProject(project.id);
  const candidates = groups.get(sessionId);
  if (!candidates || candidates.length === 0) {
    // Race: a session was deleted between the first-match probe and
    // the collision walk. Fall through to the caller (no collision
    // any more, return null so the user gets a clean 404).
    return null;
  }
  const owner = pickOwner(candidates);
  const duplicates = candidates
    .filter((c) => c.worktreeId !== owner.worktreeId)
    .map(duplicateFromCandidate);
  return {
    session: owner.session,
    projectId: project.id,
    worktreeId: owner.worktreeId,
    worktreePath: owner.worktreePath,
    duplicates,
  };
}

function duplicateFromCandidate(c: CollisionCandidate) {
  return {
    worktreeId: c.worktreeId,
    worktreeName: c.worktreeName,
    worktreePath: c.worktreePath,
    lastActiveAt: c.session.lastActiveAt,
    eventsSize: c.eventsSize,
  };
}