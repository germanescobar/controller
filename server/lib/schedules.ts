import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  projectSchedulesDir,
  projectScheduleFile,
  projectSchedulesIndexFile,
  projectScheduleRunsFile,
} from "./paths.js";
import {
  computeNextRunAt,
  serverTimezone,
  validateCron,
  validateTimezone,
} from "./schedule-cron.js";

/*
 * Schedule store + tick consumer (issue #243).
 *
 * A schedule is a user-created request to start a *new* session on a worktree
 * later — either once at a specific time (one-shot `runAt`) or on a recurring
 * cron expression. The two triggers are mutually exclusive. Each schedule
 * is one JSON file under `<projectStore>/schedules/<id>.json`; a sibling
 * `index.json` carries `{ id, nextRunAt, enabled }` for every schedule so a
 * cold-start tick can find due items without reading every file.
 *
 * Firing is race-protected by a per-project in-memory lock (the
 * `session-queue.ts` pattern): the consumer does lock → re-read → advance
 * `nextRunAt`/`lastRunAt` under the lock → release, and only *then* starts the
 * session as a detached promise. A second tick that arrives mid-run sees the
 * advanced `nextRunAt` (or a disabled one-shot) and skips, so two ticks racing
 * the same due schedule produce exactly one session.
 *
 * This module is the schedules consumer's home; the generic wakeup loop in
 * `scheduler.ts` knows nothing about it.
 */

export type ScheduleSource = "user" | "agent";

export interface Schedule {
  id: string;
  projectId: string;
  worktreeId: string;
  prompt: string;
  provider?: string;
  model?: string;
  mode?: "default" | "plan";

  /** Cron expression driving repeat; `null` for a one-shot schedule. */
  cron: string | null;
  /** IANA timezone the cron is evaluated in. */
  timezone: string;
  /** ISO target for one-shot schedules; `null` for recurring. */
  runAt: string | null;

  /** ISO of the next fire; advanced under the lock after each fire. */
  nextRunAt: string;
  lastRunAt: string | null;
  lastRunSessionId: string | null;
  lastError: string | null;

  source: ScheduleSource;
  enabled: boolean;
  createdAt: string;
  createdBy: string | null;
}

/** Caller-supplied fields; the store assigns ids, timestamps, and `nextRunAt`. */
export interface ScheduleInput {
  worktreeId: string;
  prompt: string;
  provider?: string;
  model?: string;
  mode?: "default" | "plan";
  cron?: string | null;
  timezone?: string;
  runAt?: string | null;
  enabled?: boolean;
  source?: ScheduleSource;
  createdBy?: string | null;
}

/** A single materialized run of a schedule (for the `runs` surface). */
export interface ScheduleRun {
  firedAt: string;
  sessionId: string | null;
  error: string | null;
}

interface ScheduleIndexEntry {
  id: string;
  nextRunAt: string;
  enabled: boolean;
}

/** Options the schedules consumer needs from its host (injected at startup). */
export interface SchedulesConsumerDeps {
  /** Projects to scan each tick — `{ id, path }` is all this module needs. */
  listProjects: () => Promise<Array<{ id: string; path: string }>>;
  /** Start a new session for a fired schedule. Returns the new session id. */
  startSession: (params: StartScheduledSessionParams) => Promise<{ sessionId: string }>;
  /** Clock injection for tests; defaults to `Date.now`. */
  now?: () => Date;
}

export interface StartScheduledSessionParams {
  projectId: string;
  worktreeId: string;
  prompt: string;
  provider?: string;
  model?: string;
  mode?: "default" | "plan";
}

// --- CRUD ---

/**
 * Create a schedule, computing its first `nextRunAt` from the cron (recurring)
 * or `runAt` (one-shot). A one-shot whose `runAt` is already in the past fires
 * on the next tick (eager catch-up) rather than being refused.
 */
export async function createSchedule(
  projectPath: string,
  projectId: string,
  input: ScheduleInput
): Promise<Schedule> {
  const cron = input.cron ?? null;
  const timezone = input.timezone || serverTimezone();
  validateTimezone(timezone);

  let nextRunAt: string;
  let runAt: string | null;
  if (cron) {
    validateCron(cron);
    runAt = null;
    nextRunAt = computeNextRunAt(cron, timezone, new Date());
  } else {
    if (!input.runAt) {
      throw new Error("A schedule requires either --cron or --at");
    }
    const parsed = new Date(input.runAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid --at timestamp "${input.runAt}"`);
    }
    runAt = parsed.toISOString();
    nextRunAt = runAt;
  }

  const schedule: Schedule = {
    id: randomUUID(),
    projectId,
    worktreeId: input.worktreeId,
    prompt: input.prompt,
    provider: input.provider,
    model: input.model,
    mode: input.mode,
    cron,
    timezone,
    runAt,
    nextRunAt,
    lastRunAt: null,
    lastRunSessionId: null,
    lastError: null,
    source: input.source ?? "user",
    enabled: input.enabled ?? true,
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy ?? null,
  };

  await withLock(projectPath, async () => {
    await writeSchedule(projectPath, schedule);
    await upsertIndexEntry(projectPath, schedule);
  });
  return schedule;
}

/**
 * List a project's schedules, newest first. Disabled schedules are included
 * by default (a paused recurring job is common state); pass
 * `{ includeDisabled: false }` to drop them.
 */
export async function listSchedules(
  projectPath: string,
  options: { includeDisabled?: boolean } = {}
): Promise<Schedule[]> {
  const includeDisabled = options.includeDisabled ?? true;
  const ids = await readScheduleIds(projectPath);
  const schedules: Schedule[] = [];
  for (const id of ids) {
    const schedule = await readSchedule(projectPath, id);
    if (!schedule) continue;
    if (!includeDisabled && !schedule.enabled) continue;
    schedules.push(schedule);
  }
  schedules.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  return schedules;
}

export async function getSchedule(
  projectPath: string,
  scheduleId: string
): Promise<Schedule | null> {
  return readSchedule(projectPath, scheduleId);
}

/** Enable or disable a schedule. Returns the updated schedule, or null. */
export async function setScheduleEnabled(
  projectPath: string,
  scheduleId: string,
  enabled: boolean
): Promise<Schedule | null> {
  return withLock(projectPath, async () => {
    const schedule = await readSchedule(projectPath, scheduleId);
    if (!schedule) return null;
    // Re-enabling a recurring schedule whose `nextRunAt` is in the past would
    // fire immediately; recompute it from now so the user gets the next
    // natural occurrence instead of an instant catch-up burst.
    if (enabled && !schedule.enabled && schedule.cron) {
      schedule.nextRunAt = computeNextRunAt(
        schedule.cron,
        schedule.timezone,
        new Date()
      );
    }
    schedule.enabled = enabled;
    await writeSchedule(projectPath, schedule);
    await upsertIndexEntry(projectPath, schedule);
    return schedule;
  });
}

/** Delete a schedule and its run history. Returns true if it existed. */
export async function removeSchedule(
  projectPath: string,
  scheduleId: string
): Promise<boolean> {
  return withLock(projectPath, async () => {
    const schedule = await readSchedule(projectPath, scheduleId);
    if (!schedule) return false;
    await fs.rm(projectScheduleFile(projectPath, scheduleId), { force: true });
    await fs.rm(projectScheduleRunsFile(projectPath, scheduleId), { force: true });
    await removeIndexEntry(projectPath, scheduleId);
    return true;
  });
}

/** Read the materialized run history for a schedule (newest last). */
export async function listScheduleRuns(
  projectPath: string,
  scheduleId: string
): Promise<ScheduleRun[]> {
  try {
    const content = await fs.readFile(
      projectScheduleRunsFile(projectPath, scheduleId),
      "utf-8"
    );
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed) ? (parsed as ScheduleRun[]) : [];
  } catch {
    return [];
  }
}

// --- Tick consumer + firing ---

/**
 * Build the schedules tick consumer. The returned function is synchronous: it
 * detaches the project scan as a fire-and-forget promise so the wakeup loop's
 * next tick is never blocked by a session run. Register the result with
 * `scheduler.registerConsumer`.
 */
export function makeSchedulesConsumer(
  deps: SchedulesConsumerDeps,
  fireAndForget: (work: Promise<unknown>) => void
): (now: Date) => void {
  return (now: Date) => {
    fireAndForget(runDueSchedules(now, deps));
  };
}

/**
 * Scan every project for due schedules and fire them. Exported for tests so a
 * fake clock can drive it directly. Failures firing one schedule never abort
 * the scan of the others.
 */
export async function runDueSchedules(
  now: Date,
  deps: SchedulesConsumerDeps
): Promise<void> {
  const projects = await deps.listProjects();
  for (const project of projects) {
    const due = await listDueScheduleIds(project.path, now);
    await Promise.all(
      due.map((id) =>
        tryFireSchedule(project.path, project.id, id, deps).catch((error) => {
          console.error(
            `[schedules] failed firing ${id} in ${project.id}:`,
            error
          );
        })
      )
    );
  }
}

/**
 * Fire a single schedule if it is still due. Does lock → re-read → advance
 * (mark) under the lock, then starts the session outside the lock. Awaiting
 * the returned promise covers the session start, so a test can race two calls
 * and assert exactly one session is started.
 */
export async function tryFireSchedule(
  projectPath: string,
  projectId: string,
  scheduleId: string,
  deps: SchedulesConsumerDeps
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();

  // Lock → re-read → mark. The marked schedule is what we fire; returning null
  // means a racing tick already claimed it (or it's no longer due/enabled).
  const claimed = await withLock(projectPath, async () => {
    const schedule = await readSchedule(projectPath, scheduleId);
    if (!schedule || !schedule.enabled) return null;
    if (new Date(schedule.nextRunAt).getTime() > now.getTime()) return null;

    const marked = advanceAfterFire(schedule, now);
    await writeSchedule(projectPath, marked);
    await upsertIndexEntry(projectPath, marked);
    return marked;
  });
  if (!claimed) return;

  // Start the session outside the lock so a slow run doesn't hold up other
  // schedules or the next tick.
  try {
    const { sessionId } = await deps.startSession({
      projectId,
      worktreeId: claimed.worktreeId,
      prompt: claimed.prompt,
      provider: claimed.provider,
      model: claimed.model,
      mode: claimed.mode,
    });
    await withLock(projectPath, async () => {
      const fresh = await readSchedule(projectPath, scheduleId);
      if (fresh) {
        fresh.lastRunSessionId = sessionId;
        fresh.lastError = null;
        await writeSchedule(projectPath, fresh);
      }
    });
    await appendRun(projectPath, scheduleId, {
      firedAt: now.toISOString(),
      sessionId,
      error: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markScheduleFailed(projectPath, scheduleId, message);
    await appendRun(projectPath, scheduleId, {
      firedAt: now.toISOString(),
      sessionId: null,
      error: message,
    });
  }
}

/** Record a failure on the schedule so the UI/CLI can surface it. */
export async function markScheduleFailed(
  projectPath: string,
  scheduleId: string,
  message: string
): Promise<void> {
  await withLock(projectPath, async () => {
    const schedule = await readSchedule(projectPath, scheduleId);
    if (!schedule) return;
    schedule.lastError = message;
    await writeSchedule(projectPath, schedule);
  });
}

/**
 * Advance a schedule's bookkeeping for a fire at `now`. Recurring schedules
 * get a recomputed `nextRunAt`; one-shots are disabled (consumed). Pure — the
 * caller persists the result under the lock.
 */
function advanceAfterFire(schedule: Schedule, now: Date): Schedule {
  const next: Schedule = { ...schedule, lastRunAt: now.toISOString() };
  if (schedule.cron) {
    next.nextRunAt = computeNextRunAt(schedule.cron, schedule.timezone, now);
  } else {
    // One-shot: consumed. Keep `nextRunAt` in the past but disable so a later
    // tick can't re-fire it.
    next.enabled = false;
  }
  return next;
}

// --- Storage primitives ---

async function listDueScheduleIds(projectPath: string, now: Date): Promise<string[]> {
  const index = await readIndex(projectPath);
  return index
    .filter((entry) => entry.enabled && new Date(entry.nextRunAt).getTime() <= now.getTime())
    .map((entry) => entry.id);
}

export async function readSchedule(
  projectPath: string,
  scheduleId: string
): Promise<Schedule | null> {
  try {
    const content = await fs.readFile(
      projectScheduleFile(projectPath, scheduleId),
      "utf-8"
    );
    return JSON.parse(content) as Schedule;
  } catch {
    return null;
  }
}

async function writeSchedule(projectPath: string, schedule: Schedule): Promise<void> {
  await fs.mkdir(projectSchedulesDir(projectPath), { recursive: true });
  await fs.writeFile(
    projectScheduleFile(projectPath, schedule.id),
    JSON.stringify(schedule, null, 2)
  );
}

async function appendRun(
  projectPath: string,
  scheduleId: string,
  run: ScheduleRun
): Promise<void> {
  await withLock(projectPath, async () => {
    const runs = await listScheduleRuns(projectPath, scheduleId);
    runs.push(run);
    await fs.mkdir(projectSchedulesDir(projectPath), { recursive: true });
    await fs.writeFile(
      projectScheduleRunsFile(projectPath, scheduleId),
      JSON.stringify(runs, null, 2)
    );
  });
}

async function readScheduleIds(projectPath: string): Promise<string[]> {
  const index = await readIndex(projectPath);
  if (index.length > 0) return index.map((entry) => entry.id);
  // Cold path: no index yet (or it was deleted). Fall back to scanning the
  // directory so a missing index never hides schedules.
  try {
    const files = await fs.readdir(projectSchedulesDir(projectPath));
    return files
      .filter((file) => file.endsWith(".json") && file !== "index.json" && !file.endsWith(".runs.json"))
      .map((file) => file.slice(0, -".json".length));
  } catch {
    return [];
  }
}

async function readIndex(projectPath: string): Promise<ScheduleIndexEntry[]> {
  try {
    const content = await fs.readFile(projectSchedulesIndexFile(projectPath), "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed) ? (parsed as ScheduleIndexEntry[]) : [];
  } catch {
    return [];
  }
}

async function upsertIndexEntry(projectPath: string, schedule: Schedule): Promise<void> {
  const index = await readIndex(projectPath);
  const entry: ScheduleIndexEntry = {
    id: schedule.id,
    nextRunAt: schedule.nextRunAt,
    enabled: schedule.enabled,
  };
  const idx = index.findIndex((e) => e.id === schedule.id);
  if (idx === -1) index.push(entry);
  else index[idx] = entry;
  await writeIndex(projectPath, index);
}

async function removeIndexEntry(projectPath: string, scheduleId: string): Promise<void> {
  const index = await readIndex(projectPath);
  const next = index.filter((entry) => entry.id !== scheduleId);
  await writeIndex(projectPath, next);
}

async function writeIndex(projectPath: string, index: ScheduleIndexEntry[]): Promise<void> {
  await fs.mkdir(projectSchedulesDir(projectPath), { recursive: true });
  await fs.writeFile(
    projectSchedulesIndexFile(projectPath),
    JSON.stringify(index, null, 2)
  );
}

/*
 * Per-project lock. Mirrors `session-queue.ts`: the server is single-process,
 * so an in-memory promise chain keyed by the project store path serializes all
 * read-modify-write operations on a project's schedules.
 */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(projectPath: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(projectPath) ?? Promise.resolve();
  const next = previous.then(run, run);
  locks.set(
    projectPath,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}
