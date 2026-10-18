import fs from "node:fs/promises";
import { sessionQueuesDir } from "./paths.js";
import { listQueue, enqueue, type QueuedMessage, type QueuedMessageInput } from "./session-queue.js";
import { locateSessionPath } from "./session-locator.js";

/*
 * Deferred wakeups for the session queue (issue #339).
 *
 * `controller sessions wake ... --delay 30s` enqueues a follow-up message
 * whose `runAt` is in the future. The wakes consumer scans the queue
 * directory on every scheduler tick and, for every session whose head is
 * now due, calls the existing `advanceSessionQueue` path. That function
 * already does the right thing: its internal `dequeueFirst` honors
 * `runAt` and skips heads whose delay hasn't elapsed yet, so by the time
 * the consumer fires it the queue is ready to drain.
 *
 * The consumer is intentionally thin: the queue file is the durable
 * source of truth (the same one `enqueueMessage` writes), and the
 * existing queue machinery does the pop-and-replay. Two ticks racing the
 * same due wake cannot both fire a turn because the second `dequeueFirst`
 * sees an empty queue and returns.
 */

const DELAY_PATTERN = /^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$/i;

interface DelayUnit {
  ms: number;
}

const DELAY_UNITS: Record<string, DelayUnit> = {
  s: { ms: 1_000 },
  sec: { ms: 1_000 },
  seconds: { ms: 1_000 },
  m: { ms: 60_000 },
  min: { ms: 60_000 },
  minutes: { ms: 60_000 },
  h: { ms: 60 * 60_000 },
  hr: { ms: 60 * 60_000 },
  hours: { ms: 60 * 60_000 },
  d: { ms: 24 * 60 * 60_000 },
  days: { ms: 24 * 60 * 60_000 },
};

/**
 * Parse a relative duration like `30s`, `5m`, `1h`, `2d` into milliseconds.
 * Returns `null` for empty, malformed, zero, negative, or unsupported input
 * (e.g. weeks — the issue spec lists only `s/m/h/d`).
 */
export function parseDuration(input: string | undefined | null): number | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = DELAY_PATTERN.exec(trimmed);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const spec = DELAY_UNITS[match[2].toLowerCase()];
  if (!spec) return null;
  return value * spec.ms;
}

/**
 * Resolve a delay string to an ISO `runAt` timestamp relative to `now`.
 * Returns `null` for malformed input.
 */
export function resolveRunAt(
  input: string | undefined | null,
  now: Date = new Date()
): string | null {
  const ms = parseDuration(input);
  if (ms == null) return null;
  return new Date(now.getTime() + ms).toISOString();
}

/**
 * Fields the wake surface accepts beyond the regular `QueuedMessageInput`.
 * Decoupled so the CLI/route can pass through the parsed delay string
 * without committing to a specific timestamp format.
 */
export interface EnqueueWakeInput
  extends Omit<QueuedMessageInput, "runAt"> {
  /** Relative delay (`30s`, `5m`, `1h`, `2d`); resolved server-side. */
  delay?: string | null;
  /** ISO timestamp alternative to `delay`. */
  runAtIso?: string | null;
}

/**
 * Add a wake to a session's queue. Returns the enqueued message with the
 * materialized `runAt`. Throws on a malformed `--delay` or `--run-at`.
 */
export async function enqueueWake(
  sessionId: string,
  input: EnqueueWakeInput
): Promise<QueuedMessage> {
  let runAt: string | undefined;
  if (input.runAtIso) {
    const parsed = new Date(input.runAtIso);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid --run-at timestamp "${input.runAtIso}"`);
    }
    runAt = parsed.toISOString();
  } else if (input.delay != null && input.delay !== "") {
    const resolved = resolveRunAt(input.delay);
    if (resolved == null) {
      throw new Error(
        `Invalid --delay "${input.delay}"; expected forms: 30s, 5m, 1h, 2d`
      );
    }
    runAt = resolved;
  }
  const { delay, runAtIso, ...rest } = input;
  return enqueue(sessionId, { ...rest, origin: "wake", ...(runAt ? { runAt } : {}) });
}

/**
 * Identify every session whose queue head is now due (issue #339). Used by
 * the wakes consumer; exposed for tests so a fake clock can drive it
 * deterministically.
 */
export async function listDueWakes(now: Date): Promise<string[]> {
  const dir = sessionQueuesDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const due: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const sessionId = entry.slice(0, -".json".length);
    let queue: QueuedMessage[];
    try {
      queue = await listQueue(sessionId);
    } catch {
      continue;
    }
    const head = queue[0];
    if (!head) continue;
    if (!head.runAt) continue;
    if (new Date(head.runAt).getTime() <= now.getTime()) {
      due.push(sessionId);
    }
  }
  return due;
}

/**
 * Locate the (projectId, worktreeId) that owns a session id (issue #339).
 *
 * Session ids are provider-generated, so the wakes consumer has to scan the
 * Controller-owned session store to map one back to its project + worktree.
 * Storage lives under
 * `<controllerHome>/projects/<basename>-<hash>/sessions/<id>.json`, keyed
 * by a SHA-256 hash of the project's absolute path. We recompute the hash
 * (the same way `projectStoreDir` does) so the consumer stays in sync.
 *
 * Returns `null` if the session cannot be resolved (e.g. it was archived
 * between the enqueue and the tick — the consumer drops the wake rather
 * than re-enqueuing it).
 */
async function locateSession(
  sessionId: string
): Promise<{ projectId: string; worktreeId: string } | null> {
  // Issue #339 review: the previous implementation only checked the
  // main worktree's path, so sessions in non-main worktrees were
  // silently dropped. The shared `locateSessionPath` walks every
  // project × worktree pair via the canonical `projectStoreDir`
  // resolution; delegate to it.
  return locateSessionPath(sessionId);
}

/**
 * Callback the wakes consumer hands each due session to. The shape
 * matches `scheduleSessionQueueAdvance` in `routes/sessions.ts`, so the
 * consumer can wire straight into the existing queue-drain pipeline.
 */
export interface WakeAdvanceDeps {
  advanceSessionQueue: (
    projectId: string,
    worktreeId: string,
    sessionId: string
  ) => Promise<void>;
}

/**
 * Build the wakes tick consumer (issue #339, item 5 of #219, unblocked by
 * the scheduler loop from #243). The returned function is synchronous and
 * detaches its work as a fire-and-forget promise so a slow drain of one
 * session cannot block the next tick.
 */
export function makeWakesConsumer(
  deps: WakeAdvanceDeps,
  fireAndForget: (work: Promise<unknown>) => void,
  now: () => Date = () => new Date()
): (tickNow: Date) => void {
  return (tickNow: Date) => {
    fireAndForget(runDueWakes(now(), deps));
  };
}

/**
 * Drain every due wake on each tick. Exported for tests so a fake clock
 * can drive the consumer without waiting on the timer. Failures draining
 * a single session do not abort the rest of the batch.
 */
export async function runDueWakes(
  now: Date,
  deps: WakeAdvanceDeps
): Promise<void> {
  const due = await listDueWakes(now);
  await Promise.all(
    due.map(async (sessionId) => {
      const located = await locateSession(sessionId).catch(() => null);
      if (!located) return;
      try {
        await deps.advanceSessionQueue(
          located.projectId,
          located.worktreeId,
          sessionId
        );
      } catch (error) {
        console.error(
          `[wakes] advance failed for ${sessionId}:`,
          error instanceof Error ? error.message : error
        );
      }
    })
  );
}

/**
 * Build a `WakeAdvanceDeps` that delegates to the in-process route layer
 * (issue #339). The import is dynamic so the consumer module stays
 * loadable from tests without dragging Express into the unit-test
 * environment, and avoids the routes→lib→routes cycle at module-init
 * time.
 */
export async function makeRouteAdvanceDeps(): Promise<WakeAdvanceDeps> {
  const { advanceSessionQueueFromConsumer } = await import(
    "../routes/sessions.js"
  );
  return {
    advanceSessionQueue: advanceSessionQueueFromConsumer,
  };
}