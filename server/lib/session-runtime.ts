import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { lock } from "proper-lockfile";
import { assertSafeId, ensureOrchestratorHome, sessionQueuesDir } from "./paths.js";
import {
  signalAgentProcess,
  type AgentStreamEvent,
  type ClaudeApprovalRequest,
} from "./agents.js";

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
  /**
   * True when the agent has paused on a `user.input_requested` event
   * and is waiting for the user to answer. Some providers end the
   * process at that point, so the session can be inactive while it
   * still needs the user's attention.
   *
   * Cleared whenever a new stream starts (`markSessionActive`) so a
   * resumed run doesn't carry the flag forward.
   */
  awaitingUserInput?: boolean;
}

const runtimes = new Map<string, SessionRuntimeState>();
const runStarts = new Map<string, Promise<void>>();
const releaseRunStarts = new Map<string, () => void>();
const runLeases = new Map<string, () => Promise<void>>();
const instanceId = randomUUID();

/** Reserve a resumed session before asynchronous preflight or provider startup. */
export async function claimSessionRunStart(sessionId: string): Promise<boolean> {
  assertSafeId(sessionId, "session");
  if (runStarts.has(sessionId) || getSessionRuntime(sessionId).active) return false;
  let release!: () => void;
  runStarts.set(sessionId, new Promise<void>((resolve) => { release = resolve; }));
  releaseRunStarts.set(sessionId, release);
  try {
    await ensureOrchestratorHome();
    await fs.mkdir(sessionQueuesDir(), { recursive: true });
    const lockfilePath = path.join(await fs.realpath(sessionQueuesDir()), `${sessionId}.run.lock`);
    const releaseLease = await lock(lockfilePath, {
      lockfilePath,
      realpath: false,
      stale: 30_000,
      update: 5_000,
      onCompromised: (error) => {
        console.error(`Run lease lost for ${sessionId}:`, error);
        process.exit(1);
      },
    });
    // The lock directory's mtime is the heartbeat. This sidecar identifies
    // the owner for diagnosis and is overwritten when a stale lease recovers.
    try {
      await fs.writeFile(`${lockfilePath}.json`, JSON.stringify({ pid: process.pid, instanceId }));
    } catch (error) {
      await releaseLease();
      throw error;
    }
    runLeases.set(sessionId, async () => {
      try {
        await fs.rm(`${lockfilePath}.json`, { force: true });
      } finally {
        await releaseLease();
      }
    });
    return true;
  } catch (error) {
    releaseSessionRunStart(sessionId);
    if (error instanceof Error && "code" in error && error.code === "ELOCKED") return false;
    throw error;
  }
}

export function releaseSessionRunStart(sessionId: string): void {
  const release = releaseRunStarts.get(sessionId);
  if (!release) return;
  releaseRunStarts.delete(sessionId);
  runStarts.delete(sessionId);
  release();
}

/** Release the disk lease once the agent has exited or startup failed. */
export async function releaseSessionRunLease(sessionId: string): Promise<void> {
  const release = runLeases.get(sessionId);
  if (!release) return;
  runLeases.delete(sessionId);
  await release();
}

/** Queue consumers wait for an in-progress start before checking active state. */
export async function waitForSessionRunStart(sessionId: string): Promise<boolean> {
  const pending = runStarts.get(sessionId);
  if (!pending) return false;
  await pending;
  return true;
}

export function markSessionActive(
  sessionId: string,
  runtime: Omit<SessionRuntimeState, "active"> = {}
) {
  runtimes.set(sessionId, {
    active: true,
    ...runtime,
    // A new stream is a fresh run; the previous turn's "waiting on the
    // user" pause can't carry over.
    awaitingUserInput: undefined,
  });
}

export function markSessionInactive(sessionId: string) {
  const runtime = runtimes.get(sessionId);
  if (runtime) {
    // The process is gone, so any approvals it was blocked on can no longer be
    // answered — drop them so a stale decision can't target a dead child.
    // `awaitingUserInput` is preserved: the user still owes the answer
    // even though the child is dead (e.g. Claude's structured-input
    // pause kills the child but the prompt is still on screen).
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

/**
 * Drop the in-memory runtime record for a session whose on-disk
 * artifacts just got purged. Used by the worktree purge flow so a
 * later `getSessionRuntime` call doesn't surface a phantom "active"
 * state for a session id that no longer has a JSON file behind it.
 *
 * No-op when the session was never registered — the typical case
 * for archived worktrees whose sessions ended long ago.
 */
export function clearSessionRuntime(sessionId: string): void {
  runtimes.delete(sessionId);
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
}

export function recordSessionAttentionEvent(
  sessionId: string,
  event: AgentStreamEvent
) {
  if (event.type === "user.input_requested") {
    setSessionAwaitingUserInput(sessionId, true);
    return;
  }
  if (event.type === "tool.approval_requested") {
    recordPendingApproval(sessionId, {
      requestId: event.id,
      toolName: event.toolName,
      input: event.input,
      suggestions: event.suggestions,
    });
  }
}

/**
 * Mark the session as paused on a user-input request. The flag survives
 * an inactive transition for providers that end the process at the
 * request boundary.
 */
export function setSessionAwaitingUserInput(
  sessionId: string,
  awaiting: boolean
) {
  const runtime = runtimes.get(sessionId);
  if (!runtime) return;
  runtime.awaitingUserInput = awaiting;
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
  /**
   * True when the agent is paused on a user-input request OR has at
   * least one pending tool approval.
   * The focus-queue sidebar uses this as the highest-priority
   * "needs your attention" signal regardless of `active` state.
   */
  awaitingInput?: boolean;
}

/**
 * Snapshot the runtime map so callers can answer "is session X active?" in a
 * single request. Sessions without metadata (e.g. populated by an older
 * server build) are returned without `projectId`/`worktreeId`.
 */
export function listSessionRuntimes(
  persistedAwaitingInput: ReadonlySet<string> = new Set(),
): SessionRuntimeSummary[] {
  const summaries: SessionRuntimeSummary[] = [];
  for (const [sessionId, state] of runtimes) {
    const awaitingInput =
      state.awaitingUserInput === true ||
      (state.pendingApprovals?.size ?? 0) > 0 ||
      persistedAwaitingInput.has(sessionId);
    summaries.push({
      sessionId,
      active: state.active,
      awaitingInput: awaitingInput || undefined,
      provider: state.provider,
      projectId: state.metadata?.projectId,
      worktreeId: state.metadata?.worktreeId,
    });
  }
  for (const sessionId of persistedAwaitingInput) {
    if (runtimes.has(sessionId)) continue;
    summaries.push({ sessionId, active: false, awaitingInput: true });
  }
  return summaries;
}

/**
 * Best-effort synchronous shutdown hook for the Electron/server host. Agent
 * processes live in isolated groups, so they no longer receive Controller's
 * own termination signal implicitly and must be reaped explicitly.
 */
export function stopAllSessionRuntimes(): number {
  let stopped = 0;
  for (const [sessionId, runtime] of runtimes) {
    const child = runtime.child;
    if (!runtime.active || !child || child.exitCode !== null) continue;
    try {
      if (signalAgentProcess(child, "SIGTERM")) stopped += 1;
    } catch {
      // Process exit cleanup cannot recover or await; continue reaping the
      // remaining agent groups.
    }
    markSessionInactive(sessionId);
  }
  return stopped;
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
        signalAgentProcess(child, "SIGKILL");
      }
    }, 2000);

    child.once("exit", onExit);
    child.once("error", onError);

    const signalled = signalAgentProcess(child, "SIGINT");
    if (!signalled) {
      finish();
    }
  });
}
