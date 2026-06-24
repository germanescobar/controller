import { EventEmitter } from "node:events";
import type { Project } from "./projects.js";
import type { Worktree } from "./worktrees.js";

/*
 * In-process pub/sub for project, worktree, and session lifecycle events
 * (issue #210).
 *
 * The single-server orchestrator doesn't need Redis or an external bus;
 * a per-process EventEmitter is enough for the app shell to learn about
 * out-of-band changes (CLI `controller worktrees create …` from another
 * terminal, a second app window, an agent session finishing, etc.) and
 * refresh the sidebar without polling.
 *
 * Every emitted event includes a `projectId` so the SSE route can filter
 * to the single active project the renderer cares about. The session
 * events also include `worktreeId` so the sidebar can locate the session
 * without scanning the full tree.
 *
 * Emission is fire-and-forget. Subscribers that throw are dropped from
 * the bus so a misbehaving client can't take the server down — the
 * orchestrator's data on disk is the source of truth, and the next
 * refetch will reconcile.
 */

export type ProjectEvent =
  | { type: "worktree_added"; projectId: string; worktree: Worktree }
  | { type: "worktree_removed"; projectId: string; worktreeId: string }
  | { type: "worktree_updated"; projectId: string; worktree: Worktree }
  | { type: "session_added"; projectId: string; worktreeId: string; sessionId: string }
  | { type: "session_removed"; projectId: string; worktreeId: string; sessionId: string }
  | { type: "session_updated"; projectId: string; worktreeId: string; sessionId: string }
  | { type: "project_added"; project: Project }
  | { type: "project_updated"; project: Project }
  | { type: "project_removed"; projectId: string };

/**
 * Process-wide bus. Use a dedicated emitter (not a `Server` or `app` field)
 * so importing this module from a route doesn't pull in `http`/`express`.
 */
const bus = new EventEmitter();
// Plenty of headroom: a long-running orchestrator can easily see dozens of
// concurrent SSE clients in a busy multi-project setup, and the bus only
// fans out typed lifecycle events, not streaming agent output.
bus.setMaxListeners(100);

export function emitProjectEvent(event: ProjectEvent): void {
  bus.emit("event", event);
}

export function subscribeProjectEvents(
  handler: (event: ProjectEvent) => void
): () => void {
  const wrapped = (event: ProjectEvent) => {
    try {
      handler(event);
    } catch (err) {
      console.error("projectEvents subscriber threw:", err);
    }
  };
  bus.on("event", wrapped);
  return () => {
    bus.off("event", wrapped);
  };
}

// --- Convenience emitters. Kept small so route handlers don't have to
// remember the exact shape of the union for every site. ---

export function emitWorktreeAdded(projectId: string, worktree: Worktree): void {
  emitProjectEvent({ type: "worktree_added", projectId, worktree });
}

export function emitWorktreeRemoved(projectId: string, worktreeId: string): void {
  emitProjectEvent({ type: "worktree_removed", projectId, worktreeId });
}

export function emitWorktreeUpdated(projectId: string, worktree: Worktree): void {
  emitProjectEvent({ type: "worktree_updated", projectId, worktree });
}

export function emitSessionAdded(
  projectId: string,
  worktreeId: string,
  sessionId: string
): void {
  emitProjectEvent({ type: "session_added", projectId, worktreeId, sessionId });
}

export function emitSessionRemoved(
  projectId: string,
  worktreeId: string,
  sessionId: string
): void {
  emitProjectEvent({ type: "session_removed", projectId, worktreeId, sessionId });
}

export function emitSessionUpdated(
  projectId: string,
  worktreeId: string,
  sessionId: string
): void {
  emitProjectEvent({ type: "session_updated", projectId, worktreeId, sessionId });
}
