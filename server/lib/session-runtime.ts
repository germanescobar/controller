import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { ClaudeApprovalRequest } from "./agents.js";

export interface SessionRuntimeMetadata {
  projectId: string;
  worktreeId: string;
}

export interface SessionRuntimeState {
  active: boolean;
  provider?: string;
  child?: ChildProcess;
  metadata?: SessionRuntimeMetadata;
  /**
   * Tool approvals awaiting the user's decision on the live process, keyed by
   * control-request id. Tracked in memory so the decision route can answer
   * immediately without racing the async persistence of the request event.
   */
  pendingApprovals?: Map<string, ClaudeApprovalRequest>;
}

const runtimes = new Map<string, SessionRuntimeState>();

/**
 * App-wide notifications about runtime transitions that the user may want to
 * know about while looking at a different session (or with the app in the
 * background). Distinct from the per-turn SSE in the sessions route, which
 * only reaches the client currently watching that specific session.
 */
export interface RuntimeNotification {
  kind: "needs_input";
  sessionId: string;
  projectId?: string;
  worktreeId?: string;
  provider?: string;
  toolName: string;
  requestId: string;
}

const runtimeEvents = new EventEmitter();

/** Subscribe to runtime notifications. Returns an unsubscribe function. */
export function onRuntimeNotification(
  listener: (event: RuntimeNotification) => void
): () => void {
  runtimeEvents.on("notification", listener);
  return () => {
    runtimeEvents.off("notification", listener);
  };
}

export function markSessionActive(
  sessionId: string,
  runtime: Omit<SessionRuntimeState, "active"> = {}
) {
  runtimes.set(sessionId, { active: true, ...runtime });
}

export function markSessionInactive(sessionId: string) {
  const runtime = runtimes.get(sessionId);
  if (runtime) {
    // The process is gone, so any approvals it was blocked on can no longer be
    // answered — drop them so a stale decision can't target a dead child.
    runtimes.set(sessionId, {
      ...runtime,
      active: false,
      child: undefined,
      pendingApprovals: undefined,
    });
    return;
  }
  runtimes.set(sessionId, { active: false });
}

export function getSessionRuntime(sessionId: string): SessionRuntimeState {
  return runtimes.get(sessionId) ?? { active: false };
}

/** Record an approval the live process is blocked on, awaiting a decision. */
export function recordPendingApproval(
  sessionId: string,
  request: ClaudeApprovalRequest
) {
  const runtime = runtimes.get(sessionId);
  if (!runtime) return;
  if (!runtime.pendingApprovals) {
    runtime.pendingApprovals = new Map();
  }
  runtime.pendingApprovals.set(request.requestId, request);
  runtimeEvents.emit("notification", {
    kind: "needs_input",
    sessionId,
    projectId: runtime.metadata?.projectId,
    worktreeId: runtime.metadata?.worktreeId,
    provider: runtime.provider,
    toolName: request.toolName,
    requestId: request.requestId,
  } satisfies RuntimeNotification);
}

/** Remove and return a pending approval once the user has decided. */
export function consumePendingApproval(
  sessionId: string,
  requestId: string
): ClaudeApprovalRequest | undefined {
  const runtime = runtimes.get(sessionId);
  const request = runtime?.pendingApprovals?.get(requestId);
  if (request) {
    runtime?.pendingApprovals?.delete(requestId);
  }
  return request;
}

export interface SessionRuntimeSummary {
  sessionId: string;
  active: boolean;
  provider?: string;
  projectId?: string;
  worktreeId?: string;
}

/**
 * Snapshot the runtime map so callers can answer "is session X active?" in a
 * single request. Sessions without metadata (e.g. populated by an older
 * server build) are returned without `projectId`/`worktreeId`.
 */
export function listSessionRuntimes(): SessionRuntimeSummary[] {
  const summaries: SessionRuntimeSummary[] = [];
  for (const [sessionId, state] of runtimes) {
    summaries.push({
      sessionId,
      active: state.active,
      provider: state.provider,
      projectId: state.metadata?.projectId,
      worktreeId: state.metadata?.worktreeId,
    });
  }
  return summaries;
}

export async function stopSessionRuntime(sessionId: string): Promise<void> {
  const runtime = runtimes.get(sessionId);
  if (!runtime?.active) {
    throw new Error("No active session runtime");
  }
  if (!runtime.child) {
    throw new Error("No stoppable process for this session");
  }

  const child = runtime.child;
  if (child.exitCode !== null || child.killed) {
    markSessionInactive(sessionId);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      child.off("exit", onExit);
      child.off("error", onError);
      markSessionInactive(sessionId);
      resolve();
    };

    const onExit = () => finish();
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      child.off("exit", onExit);
      child.off("error", onError);
      reject(error);
    };

    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 2000);

    child.once("exit", onExit);
    child.once("error", onError);

    const signalled = child.kill("SIGINT");
    if (!signalled) {
      finish();
    }
  });
}
