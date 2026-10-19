import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { appendEvent, type AgentEvent } from "./sessions.js";
import { escapeFollowUpMarkerLabel } from "../../shared/follow-up-markers.js";

/*
 * Monitor primitive (issue #339).
 *
 * A Monitor is a long-lived child process per session whose stdout
 * lines are appended to the session event log as `monitor_event` events.
 * Mirrors Claude Code's `Monitor` tool: the agent invokes a CLI command
 * (e.g. `gh pr checks --watch`) and receives a line-by-line transcript
 * without blocking the turn.
 *
 * Implementation notes:
 *   - Line buffering is hand-rolled (no `readline`) so the lifecycle
 *     stays self-contained and easy to test.
 *   - Each monitor lives in an in-process `Map` keyed by a UUID. The
 *     server reaps monitors on graceful shutdown but does not persist
 *     across restarts (a transient watch; surviving a crash is not in
 *     scope for v1).
 *   - The route layer enforces the per-session cap and the per-monitor
 *     line buffer; this module only manages the process + event-log
 *     side.
 */

export const MAX_MONITORS_PER_SESSION = 8;
export const MAX_LINE_BUFFER = 1000;
/**
 * Longest partial line (in UTF-16 code units) buffered while waiting for
 * a newline. Longer runs are emitted in chunks of this size so output
 * like a progress bar without `\n` cannot grow server memory unbounded.
 */
export const MAX_PARTIAL_LINE_LENGTH = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_TIMEOUT_MS = 60 * 60 * 1000;

export interface MonitorLimits {
  maxPerSession: number;
  maxLines: number;
}

export interface Monitor {
  id: string;
  sessionId: string;
  worktreePath: string;
  description: string;
  command: string;
  persistent: boolean;
  /** Epoch ms; the monitor self-kills when `Date.now() > deadlineAt`. */
  deadlineAt: number | null;
  startedAt: string;
  /** Whether the child process is still alive. Exited entries remain listed until stopped. */
  status: "running" | "exited";
  /** Number of stdout lines captured so far. Capped at `limits.maxLines`. */
  lineCount: number;
  /**
   * Pattern (compiled server-side) used to filter stdout lines that
   * should be re-injected as user messages (issue #351). When a line
   * matches, the route's delivery hook enqueues a follow-up whose text is
   * the canonical
   * `[/monitor: <description>] <line>` marker — same shape as the
   * `[/from: …]` marker the cross-session send uses, so the same
   * client-side dedupe + linkifier logic handles both.
   *
   * `null` (the default) means "no filter" — every line is captured
   * as a `monitor_event`, but none are re-injected as a user turn.
   * The field is intentionally exposed on the wire (the route echoes
   * it back) so the UI can show whether a monitor has a filter.
   */
  onLinePattern: string | null;
}

interface ActiveMonitor {
  monitor: Monitor;
  /**
   * The live child process. `null` for test-only entries
   * seeded via `__seedMonitorForTests` — production code
   * always populates this with the spawned `ChildProcess`.
   * `stopMonitor` skips signalling when this is `null`.
   */
  child: ChildProcess | null;
  /**
   * Set once the shell (process-group leader) exits or fails to spawn.
   * After that the pgid may be recycled, so the monitor never signals it.
   */
  leaderExited: boolean;
  /** Deadline auto-kill timer; cleared on leader exit and on stop. */
  deadlineTimer: NodeJS.Timeout | null;
  /** Pending SIGKILL escalation after a stop; cleared on leader exit. */
  escalationTimer: NodeJS.Timeout | null;
  /** Pending event-log writes — chained so they serialize per monitor. */
  writeChain: Promise<unknown>;
}

const monitors = new Map<string, ActiveMonitor>();

const isolateProcessGroup = process.platform !== "win32";

/** Grace period between SIGTERM and the SIGKILL escalation on stop. */
const KILL_GRACE_MS = 2_000;

/**
 * Start a monitor. The route layer passes through the parsed request
 * (description, command, persistent, optional timeout) and a `limits`
 * bundle so tests can drive the cap / buffer with smaller values.
 *
 * Throws if the session already has the maximum number of monitors
 * running — the route handler converts the throw into a 400.
 */
export function startMonitor(params: {
  sessionId: string;
  worktreePath: string;
  description: string;
  command: string;
  persistent: boolean;
  timeoutMs?: number;
  limits?: Partial<MonitorLimits>;
  /**
   * Optional pre-compiled regex used to filter stdout lines that
   * should be re-injected as user messages (issue #351). When a line
   * matches, `onLineMatch` receives the canonical
   * `[/monitor: <description>] <line>` marker for durable delivery.
   * Compiled by the route layer (so a bad pattern returns 400
   * before the monitor is started). `null` / `undefined` means no
   * filter — every line is captured as a `monitor_event` but none
   * are re-injected.
   */
  onLine?: RegExp | null;
  /**
   * The original pattern string the route received (issue #351).
   * Stored on the `Monitor` so the wire response and the UI can
   * echo back what filter was actually applied.
   */
  onLinePattern?: string | null;
  /**
   * Delivery hook for an `onLine` match. The route layer supplies a hook
   * that enqueues a durable follow-up and advances the session when it is
   * idle. Keeping execution outside this process primitive avoids a
   * monitors -> routes import cycle and makes delivery directly testable.
   */
  onLineMatch?: (input: {
    monitor: Monitor;
    line: string;
    text: string;
  }) => Promise<void>;
}): Monitor {
  const limits = {
    maxPerSession: params.limits?.maxPerSession ?? MAX_MONITORS_PER_SESSION,
    maxLines: params.limits?.maxLines ?? MAX_LINE_BUFFER,
  };
  const existing = countMonitorsForSession(params.sessionId);
  if (existing >= limits.maxPerSession) {
    throw new Error(
      `Session ${params.sessionId} already has ${existing} monitors (max ${limits.maxPerSession})`
    );
  }
  const persistent = params.persistent;
  const timeoutMs = persistent
    ? null
    : Math.min(
        Math.max(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000),
        MAX_TIMEOUT_MS
      );
  const deadlineAt = timeoutMs == null ? null : Date.now() + timeoutMs;
  const id = randomUUID();
  const monitor: Monitor = {
    id,
    sessionId: params.sessionId,
    worktreePath: params.worktreePath,
    description: params.description,
    command: params.command,
    persistent,
    deadlineAt,
    startedAt: new Date().toISOString(),
    status: "running",
    lineCount: 0,
    onLinePattern: params.onLinePattern ?? null,
  };
  // We shell out via `spawn` with `shell: true` so the agent can use a
  // bare command string (matches the CLI surface) rather than having to
  // build an argv. The route already validates the command is non-empty;
  // we deliberately don't constrain the syntax further here.
  const child = spawn(params.command, {
    cwd: params.worktreePath,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    // POSIX: make the shell the leader of its own process group so a stop
    // can signal the whole pipeline (`tail -f log | grep ERROR`), not just
    // the `/bin/sh -c` wrapper. Windows keeps the direct-child lifecycle.
    detached: isolateProcessGroup,
  });
  const active: ActiveMonitor = {
    monitor,
    child,
    leaderExited: false,
    deadlineTimer: null,
    escalationTimer: null,
    writeChain: Promise.resolve(),
  };
  monitors.set(id, active);
  // The compiled regex is `null` for unfiltered monitors. Local
  // reference so the per-line closure avoids re-reading
  // `params.onLine` on every chunk.
  const onLine = params.onLine ?? null;

  const emitLine = (line: string, matchOnLine: boolean): void => {
    // Synchronously increment the line counter so listMonitors sees
    // the latest count even before the disk write resolves, then
    // chain the event-log append onto the monitor's write chain so
    // on-disk order matches emission order.
    if (monitor.lineCount >= limits.maxLines) return;
    monitor.lineCount += 1;
    const event: AgentEvent = {
      id: randomUUID(),
      sessionId: monitor.sessionId,
      timestamp: new Date().toISOString(),
      type: "monitor_event",
      data: { monitorId: monitor.id, line },
    };
    active.writeChain = active.writeChain.then(() =>
      appendEvent(monitor.worktreePath, monitor.sessionId, event).catch(
        () => {
          // Best-effort: an event-log write failure must not kill
          // the monitor's process. The line counter has already
          // advanced.
        }
      )
    );
    // Issue #351: when the monitor has an `--on-line` regex, also
    // deliver a queued follow-up for matching lines. The text
    // is the canonical `[/monitor: <description>] <line>` marker
    // — same shape as the `[/from: …]` marker from `sessions
    // send`, so the existing client-side dedupe + linkifier logic
    // handles both. We deliberately throttle the write onto the
    // same write chain as the monitor_event so on-disk order
    // matches emission order: an agent reading its event log will
    // see the monitor_event first, then enqueue the follow-up, for any
    // given line.
    if (matchOnLine && onLine && onLine.test(line) && params.onLineMatch) {
      const markerLine = `[/monitor: ${escapeFollowUpMarkerLabel(monitor.description)}] ${line}`;
      active.writeChain = active.writeChain.then(() =>
        params.onLineMatch!({
          monitor: { ...monitor },
          line,
          text: markerLine,
        }).catch(() => {
          // Best-effort: a failed enqueue must not interrupt the
          // monitor process. The monitor_event remains the audit trail.
        })
      );
    }
  };

  if (child.stdout) {
    pipeLines(child.stdout, (line) => emitLine(line, true));
  }
  if (child.stderr) {
    // Surface stderr as separate, prefixed lines so the agent can
    // distinguish command output from shell diagnostics. We don't roll
    // stderr into stdout because that would conflate data with errors,
    // and stderr lines never trigger `--on-line` delivery.
    pipeLines(child.stderr, (line) => emitLine(`[stderr] ${line}`, false));
  }
  child.on("exit", () => {
    monitor.status = "exited";
    markLeaderExited(active);
    // Mark the monitor as exited in-place rather than removing the
    // entry — a process that finishes naturally (e.g. `printf`) is
    // still a meaningful record: the agent can read its lineCount
    // from `listMonitors` and decide whether to call `stopMonitor` to
    // discard it. `stopMonitor` is the only way to remove an entry,
    // so the API matches the user-facing model (Claude Code's
    // `TaskStop` analogue — explicit stop, never implicit vanish).
  });
  child.on("error", (error) => {
    monitor.status = "exited";
    markLeaderExited(active);
    emitLine(`[error] ${error.message}`, false);
  });
  if (deadlineAt != null) {
    const remaining = deadlineAt - Date.now();
    active.deadlineTimer = setTimeout(() => {
      if (monitors.has(id)) terminateMonitorProcess(active);
    }, Math.max(0, remaining));
    active.deadlineTimer.unref?.();
  }
  return { ...monitor };
}

function countMonitorsForSession(sessionId: string): number {
  let count = 0;
  for (const { monitor } of monitors.values()) {
    if (monitor.sessionId === sessionId) count += 1;
  }
  return count;
}

/** List every monitor attached to a session. */
export function listMonitors(sessionId: string): Monitor[] {
  const out: Monitor[] = [];
  for (const { monitor } of monitors.values()) {
    if (monitor.sessionId === sessionId) out.push({ ...monitor });
  }
  return out;
}

/**
 * Stop a monitor by id. Returns the stopped monitor or `null` if no
 * monitor with that id was running. The caller (route layer) is
 * expected to surface `null` as a 404.
 */
export function stopMonitor(monitorIdId: string): Monitor | null {
  const active = monitors.get(monitorIdId);
  if (!active) return null;
  monitors.delete(monitorIdId);
  if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
  terminateMonitorProcess(active);
  return { ...active.monitor };
}

/**
 * Stop every monitor for a session. Used when the session is archived
 * (issue #339). Returns the count of monitors that were stopped so the
 * caller can log a summary.
 */
export function stopMonitorsForSession(sessionId: string): number {
  let stopped = 0;
  for (const [id, { monitor }] of monitors.entries()) {
    if (monitor.sessionId === sessionId) {
      const result = stopMonitor(id);
      if (result) stopped += 1;
    }
  }
  return stopped;
}

/**
 * Reap every running monitor. Used on graceful shutdown. Mirrors
 * `stopMonitorsForSession` but iterates the full map.
 */
export function stopAllMonitors(): number {
  let stopped = 0;
  for (const id of monitors.keys()) {
    if (stopMonitor(id)) stopped += 1;
  }
  return stopped;
}

/**
 * Split a stream into newline-delimited lines. A trailing partial line
 * is flushed when the stream ends so `printf done` still yields `done`,
 * and a partial line longer than `MAX_PARTIAL_LINE_LENGTH` is emitted in
 * chunks of that size.
 */
function pipeLines(stream: Readable, onLine: (line: string) => void): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      onLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
    while (buffer.length > MAX_PARTIAL_LINE_LENGTH) {
      // Keep a surrogate pair together: if the cut would land after a
      // high surrogate, move it back one code unit.
      const lastCode = buffer.charCodeAt(MAX_PARTIAL_LINE_LENGTH - 1);
      const splitAt =
        lastCode >= 0xd800 && lastCode <= 0xdbff
          ? MAX_PARTIAL_LINE_LENGTH - 1
          : MAX_PARTIAL_LINE_LENGTH;
      onLine(buffer.slice(0, splitAt));
      buffer = buffer.slice(splitAt);
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) onLine(buffer);
    buffer = "";
  });
}

function markLeaderExited(active: ActiveMonitor): void {
  active.leaderExited = true;
  if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
  active.deadlineTimer = null;
  if (active.escalationTimer) clearTimeout(active.escalationTimer);
  active.escalationTimer = null;
}

/**
 * SIGTERM the monitor's process tree, then SIGKILL whatever is left of
 * the group after `KILL_GRACE_MS`. The escalation timer is unref'd so it
 * never holds the server open during shutdown.
 *
 * Once the leader has exited the monitor sends no signals at all, and a
 * pending SIGKILL escalation is cancelled: the pgid may already belong
 * to an unrelated group. Trade-off: a descendant that ignores SIGTERM
 * can survive its leader; we accept that rather than risk signalling a
 * recycled pgid.
 */
function terminateMonitorProcess(active: ActiveMonitor): void {
  // Test-only seeded entries from `__seedMonitorForTests` have no child.
  const { child } = active;
  if (!child || active.leaderExited) return;
  // A deadline-triggered termination is already in its grace period.
  if (active.escalationTimer) return;
  // Only escalate when SIGTERM reached a live group.
  if (!signalMonitorProcess(child, "SIGTERM") || child.pid === undefined) return;
  const pid = child.pid;
  active.escalationTimer = setTimeout(() => {
    active.escalationTimer = null;
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      // ESRCH: the whole group already exited after SIGTERM.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        console.error(`[monitors] SIGKILL of process group ${pid} failed:`, error);
      }
    }
  }, KILL_GRACE_MS);
  active.escalationTimer.unref?.();
}

/**
 * Signal every process in the monitor's POSIX process group, falling
 * back to the direct child when the group is gone (ESRCH) or on Windows.
 * Returns whether the process group itself was signalled.
 */
function signalMonitorProcess(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (isolateProcessGroup && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        console.error(
          `[monitors] ${signal} of process group ${child.pid} failed:`,
          error
        );
      }
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
  return false;
}

/** Test-only helper to count the in-process monitor map. */
export function monitorCount(): number {
  return monitors.size;
}

/** Test-only helper to clear the in-process monitor map without
 *  signalling child processes. Use `stopAllMonitors` for the normal
 *  shutdown path; `__resetMonitorsForTests` is for unit tests that
 *  exercise the route layer without spawning. */
export function __resetMonitorsForTests(): void {
  monitors.clear();
}

/**
 * Test-only helper that inserts a synthetic monitor entry into the
 * in-process map WITHOUT spawning a child process.
 *
 * Used by the archive-route tests so the strict-archive rule can
 * be exercised without `sleep 30` subprocesses racing the test
 * runner's SIGTERM. The synthetic entry satisfies `listMonitors`,
 * `countMonitorsForSession`, and the archive-route blocker check;
 * `stopMonitor` removes it without trying to kill a non-existent
 * child because the process handle is optional.
 *
 * Production code MUST NOT call this. The `__` prefix + the
 * `_ForTests` suffix flag it as a test seam so any production
 * caller is obvious in code review.
 */
export function __seedMonitorForTests(monitor: Monitor): void {
  const active: ActiveMonitor = {
    monitor,
    // Keeping this null makes the test-only intent explicit.
    child: null,
    leaderExited: false,
    deadlineTimer: null,
    escalationTimer: null,
    writeChain: Promise.resolve(),
  };
  monitors.set(monitor.id, active);
}
