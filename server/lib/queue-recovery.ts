import fs from "node:fs/promises";
import { isSafeId, sessionQueuesDir } from "./paths.js";
import { listQueue } from "./session-queue.js";
import { hasLiveSessionRunLease } from "./session-runtime.js";
import { locateSessionPath } from "./session-locator.js";

export interface QueueRecoveryDeps {
  advanceSessionQueue: (
    projectId: string,
    worktreeId: string,
    sessionId: string
  ) => Promise<void>;
}

/** Register only on the shared-loop owner; the scheduler detaches each tick. */
export function makeQueueRecoveryConsumer(
  deps: QueueRecoveryDeps,
  fireAndForget: (work: Promise<unknown>) => void
): (now: Date) => void {
  return () => { fireAndForget(runQueueRecovery(deps)); };
}

/** Retry ready plain queues left behind when a server dies mid-run. */
export async function runQueueRecovery(deps: QueueRecoveryDeps): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionQueuesDir());
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }

  await Promise.all(entries.map(async (entry) => {
    if (!entry.endsWith(".json")) return;
    const sessionId = entry.slice(0, -".json".length);
    if (!isSafeId(sessionId)) return;
    try {
      const head = (await listQueue(sessionId))[0];
      if (!head || head.runAt) return;
      if (await hasLiveSessionRunLease(sessionId)) return;
      const located = await locateSessionPath(sessionId);
      if (!located) return;
      await deps.advanceSessionQueue(located.projectId, located.worktreeId, sessionId);
    } catch (error) {
      console.error(`[queue-recovery] failed for ${sessionId}:`, error);
    }
  }));
}
