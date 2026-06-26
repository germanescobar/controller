/*
 * The shared wakeup loop (issue #243).
 *
 * A single `setInterval` drives every deferred-work subsystem. Each
 * subsystem registers one synchronous consumer; on every tick the loop
 * hands each consumer the current time and the consumer kicks off its own
 * work as a detached promise (`fireAndForget`) and returns immediately, so
 * the next tick is never blocked by a long-running job.
 *
 * This module owns *only* the loop and the consumer registry — it has no
 * knowledge of schedules, sessions, or any consumer's domain. Consumers
 * (e.g. `schedules.ts`, and later #219's `sessions wake`) live elsewhere
 * and register themselves at startup.
 */

export type TickConsumer = (now: Date) => void;

const DEFAULT_TICK_INTERVAL_MS = 30_000;

const consumers: TickConsumer[] = [];
let timer: NodeJS.Timeout | null = null;

/** Register a consumer invoked on every tick. Returns an unregister fn. */
export function registerConsumer(consumer: TickConsumer): () => void {
  consumers.push(consumer);
  return () => {
    const index = consumers.indexOf(consumer);
    if (index !== -1) consumers.splice(index, 1);
  };
}

/** Remove every registered consumer. Test helper. */
export function clearConsumers(): void {
  consumers.length = 0;
}

/**
 * Run every registered consumer once with `now`. Exported so tests can drive
 * the loop deterministically with a fake clock instead of waiting on the
 * timer. A consumer that throws synchronously is logged and skipped so one
 * misbehaving subsystem can't take down the others.
 */
export function runTick(now: Date = new Date()): void {
  for (const consumer of consumers) {
    try {
      consumer(now);
    } catch (error) {
      console.error("[scheduler] consumer threw on tick:", error);
    }
  }
}

/** Resolve the tick interval, overridable via `SCHEDULER_TICK_INTERVAL_MS`. */
export function tickIntervalMs(): number {
  const raw = process.env.SCHEDULER_TICK_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_TICK_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TICK_INTERVAL_MS;
}

/** Start the wakeup loop. Idempotent — a second call is a no-op. */
export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => runTick(), tickIntervalMs());
  // Don't keep the process alive solely for the scheduler (matches the
  // server's other background timers and lets tests exit cleanly).
  timer.unref?.();
}

/** Stop the wakeup loop. Idempotent. */
export function stopScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Kick off a promise without awaiting it, logging any rejection. Consumers
 * use this to detach their work from the tick so a slow job never blocks the
 * next tick.
 */
export function fireAndForget(work: Promise<unknown>): void {
  work.catch((error) => {
    console.error("[scheduler] detached work rejected:", error);
  });
}
