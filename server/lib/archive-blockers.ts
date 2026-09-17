/*
 * Issue #351: strict-archive rule.
 *
 * Archiving a session drops it from the focus queue + sidebar +
 * focus-queue advance. Doing that while the session is still in
 * use — a live agent running, queued messages waiting, monitors
 * firing events, or live children recording — leaves the agent or
 * the operator in an inconsistent state: a queued message that
 * fires into an archived session can't surface anywhere, a
 * monitor's `monitor_event` lands on a session the agent no
 * longer sees, and a child session that's still recording writes
 * into a parent that has already been archived.
 *
 * `archiveBlockersFor` gathers every active concern for a session
 * into a structured `blockers` array. The archive route returns
 * 409 with that array when non-empty, so the UI can render a
 * specific tooltip ("queued messages: 3", "live agent",
 * "monitor: CI watcher", etc.) instead of a generic failure.
 *
 * Each blocker is `{ kind, ...detail }` so the UI can group /
 * summarize them without re-parsing free text. New kinds are
 * forward-compatible: the route only checks `blockers.length`,
 * the UI iterates `kind`.
 */

import { getSessionRuntime } from "./session-runtime.js";
import { listQueue } from "./session-queue.js";
import { listMonitors } from "./monitors.js";
import { listChildSessions } from "./sessions.js";
import { listPersistedAttentionSessionIds } from "./session-attention.js";

export type ArchiveBlocker =
  | {
      kind: "live-agent";
      message: string;
    }
  | {
      kind: "awaiting-input";
      message: string;
    }
  | {
      kind: "queued-messages";
      count: number;
    }
  | {
      kind: "active-monitors";
      count: number;
      monitorIds: string[];
      descriptions: string[];
    }
  | {
      kind: "live-children";
      count: number;
      childIds: string[];
    };

export interface ArchiveBlockerReport {
  blockers: ArchiveBlocker[];
}

/**
 * Gather every active concern that should prevent archiving
 * `sessionId`. Each blocker is independent — the route should
 * surface ALL blockers so the UI can disable the Archive button
 * with a complete tooltip, not a one-at-a-time failure loop.
 *
 * `getSessionRuntime` is a pure in-process map check, so this
 * call is cheap. `listQueue` reads a JSON file. `listMonitors`
 * is in-process. `listChildSessions` walks every project ×
 * worktree to find children with `parentId === sessionId` — the
 * cross-worktree case the issue calls out.
 */
export async function archiveBlockersFor(
  sessionId: string
): Promise<ArchiveBlocker[]> {
  return collectArchiveBlockers(sessionId, new Set());
}

async function collectArchiveBlockers(
  sessionId: string,
  ancestors: Set<string>
): Promise<ArchiveBlocker[]> {
  const blockers: ArchiveBlocker[] = [];
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(sessionId);

  // 1. Live agent: the in-process runtime map says this session
  // is currently driving an agent. The archive flow would orphan
  // the live process; the route layer calls `stopSessionRuntime`
  // after archive, but killing a live agent without warning is the
  // exact footgun this rule exists to prevent.
  const runtime = getSessionRuntime(sessionId);
  if (runtime.active) {
    blockers.push({
      kind: "live-agent",
      message:
        "Session has a live agent run in progress. Stop the agent before archiving.",
    });
  }

  const persistedAttention = await listPersistedAttentionSessionIds();
  if (
    runtime.awaitingUserInput === true ||
    (runtime.pendingApprovals?.size ?? 0) > 0 ||
    persistedAttention.has(sessionId)
  ) {
    blockers.push({
      kind: "awaiting-input",
      message: "Session is waiting for user input.",
    });
  }

  // 2. Queued messages: any pending enqueued message will fire
  // into the archived session if the queue isn't drained first.
  // `listQueue` returns `[]` when there's no queue file (the
  // normal case for a fresh session) so this is safe to call
  // unconditionally.
  try {
    const queued = await listQueue(sessionId);
    if (queued.length > 0) {
      blockers.push({
        kind: "queued-messages",
        count: queued.length,
      });
    }
  } catch {
    // `listQueue` is best-effort — a corrupt queue file must not
    // block archive from surfacing the other blockers. The route
    // layer's existing `clearQueue` cleanup will catch this on the
    // post-archive path anyway.
  }

  // 3. Active monitors: each monitor would keep firing events on
  // the archived session. The route stops monitors post-archive
  // (issue #339 review), but a SIGTERM race can outlive the
  // route handler, so we surface the count up-front and let the
  // UI warn the user. We expose both `monitorIds` and
  // `descriptions` so the UI can render either ("3 monitors" or
  // a list of names).
  try {
    const monitors = listMonitors(sessionId);
    if (monitors.length > 0) {
      blockers.push({
        kind: "active-monitors",
        count: monitors.length,
        monitorIds: monitors.map((m) => m.id),
        descriptions: monitors.map((m) => m.description),
      });
    }
  } catch {
    // Monitor registry is in-process; failures here are not
    // expected and would indicate a deeper issue. Swallow so
    // the other blockers still surface.
  }

  // 4. Live children: only children whose own subtree has unfinished
  // business block the parent. An idle child may intentionally survive
  // as an orphan when its parent is archived. The cross-worktree walk is
  // the same one `sessions list --parent self` uses (issue #353); keeping the
  // call here means strict-archive and the cross-session
  // primitives share a single canonical "find my children"
  // implementation.
  try {
    const children = await listChildSessions(sessionId);
    const blockingChildren: string[] = [];
    for (const child of children) {
      // Parent links should be acyclic. Fail closed if corrupt persisted
      // data creates a loop rather than recursing forever and allowing an
      // unsafe archive.
      if (nextAncestors.has(child.id)) {
        blockingChildren.push(child.id);
        continue;
      }
      const childBlockers = await collectArchiveBlockers(
        child.id,
        nextAncestors
      );
      if (childBlockers.length > 0) blockingChildren.push(child.id);
    }
    if (blockingChildren.length > 0) {
      blockers.push({
        kind: "live-children",
        count: blockingChildren.length,
        childIds: blockingChildren,
      });
    }
  } catch {
    // Walking every project × worktree can hit IO errors; swallow
    // so the archive route can still 409 on the other blockers.
  }

  return blockers;
}
