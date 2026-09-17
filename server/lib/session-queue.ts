import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  ensureOrchestratorHome,
  sessionQueueFile,
  sessionQueuesDir,
} from "./paths.js";

/*
 * Per-session message queue. Messages typed while an agent is streaming are
 * enqueued here and replayed one-at-a-time once the active run completes
 * cleanly. The queue is the durable source of truth (it survives reloads and
 * server restarts); the client drives advancement because runs are
 * client-initiated SSE connections (see issue #113).
 */

export interface QueuedMessage {
  id: string;
  /** Message handed to the agent (skill block already prepended server-side). */
  text: string;
  /** Transcript echo, e.g. `[/skill: name] <text>`. */
  visibleText: string;
  provider: string;
  model: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  serviceTier?: "fast";
  mode: "default" | "plan";
  attachmentIds: string[];
  skillName?: string;
  /**
   * File/directory mentions from the composer's `@` picker (issue #312).
   * The orchestrator snapshots the chip stack at enqueue time and the
   * queue-replay effect re-sends it on the next turn so the resolved
   * mention block in the prompt matches what the user typed.
   */
  mentions?: { path: string; type: "file" | "directory" }[];
  /**
   * Optional ISO timestamp for deferred wakeups (issue #339). When set, the
   * message is not dequeued for the agent until the wall clock passes it —
   * the wakes consumer (registered on the shared wakeup loop in
   * `scheduler.ts`) calls `advanceSessionQueue` once the delay has elapsed,
   * so the queue stays drained without a client or a follow-up turn. Items
   * without `runAt` keep their existing "process as soon as a turn finishes"
   * behavior.
   */
  runAt?: string;
  createdAt: string;
}

/** Fields the caller supplies; `id` and `createdAt` are assigned on enqueue. */
export type QueuedMessageInput = Omit<QueuedMessage, "id" | "createdAt">;

export interface SessionQueueTransaction {
  list(): Promise<QueuedMessage[]>;
  enqueue(input: QueuedMessageInput): Promise<QueuedMessage>;
  clear(): Promise<void>;
}

/** Run a lifecycle operation under the lock used by every queue mutation. */
export function withSessionQueueTransaction<T>(
  sessionId: string,
  run: (queue: SessionQueueTransaction) => Promise<T>
): Promise<T> {
  return withLock(sessionId, () =>
    run({
      list: () => readQueue(sessionId),
      enqueue: (input) => enqueueUnlocked(sessionId, input),
      clear: () => clearQueueUnlocked(sessionId),
    })
  );
}

/** Append a message to the end of a session's queue and return the stored item. */
export async function enqueue(
  sessionId: string,
  input: QueuedMessageInput
): Promise<QueuedMessage> {
  return withLock(sessionId, () => enqueueUnlocked(sessionId, input));
}

async function enqueueUnlocked(
  sessionId: string,
  input: QueuedMessageInput
): Promise<QueuedMessage> {
  const queue = await readQueue(sessionId);
  const message: QueuedMessage = {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  queue.push(message);
  await writeQueue(sessionId, queue);
  return message;
}

/** Return the session's queued messages in order (empty if none). */
export async function listQueue(sessionId: string): Promise<QueuedMessage[]> {
  return readQueue(sessionId);
}

/** Remove a queued message by id. Returns true if an item was removed. */
export async function removeFromQueue(
  sessionId: string,
  messageId: string
): Promise<boolean> {
  return withLock(sessionId, async () => {
    const queue = await readQueue(sessionId);
    const next = queue.filter((message) => message.id !== messageId);
    if (next.length === queue.length) return false;
    await writeQueue(sessionId, next);
    return true;
  });
}

export interface QueuedMessageResolution<T> {
  message: QueuedMessage | null;
  result?: T;
  removed: boolean;
}

/*
 * Resolve ownership of one queued message while holding the same per-session
 * lock used by dequeueFirst. The async resolver may perform the native steer;
 * queue advancement cannot dequeue the item until the resolver decides
 * whether ownership transferred successfully.
 */
export async function resolveQueuedMessage<T>(
  sessionId: string,
  messageId: string,
  resolve: (message: QueuedMessage) => Promise<{ result: T; remove: boolean }>
): Promise<QueuedMessageResolution<T>> {
  return withLock(sessionId, async () => {
    const queue = await readQueue(sessionId);
    const index = queue.findIndex((message) => message.id === messageId);
    if (index === -1) {
      return { message: null, removed: false };
    }

    const message = queue[index];
    const resolution = await resolve(message);
    if (resolution.remove) {
      queue.splice(index, 1);
      await writeQueue(sessionId, queue);
    }
    return {
      message,
      result: resolution.result,
      removed: resolution.remove,
    };
  });
}

/** Remove and return the first queued message, or null if the queue is empty.
 *
 * Honors deferred-wakeup `runAt` (issue #339): a head whose `runAt` is still
 * in the future is *not* popped, since firing the agent before the delay
 * would defeat the purpose. The wakes consumer (registered on the shared
 * wakeup loop from #243) calls `advanceSessionQueue` once the delay has
 * elapsed, which re-invokes this function and gets the now-ready head. The
 * peek-then-pop happens under the same per-session lock so a concurrent
 * enqueue can't race the check.
 */
export async function dequeueFirst(
  sessionId: string
): Promise<QueuedMessage | null> {
  return withLock(sessionId, async () => {
    const queue = await readQueue(sessionId);
    const first = queue[0];
    if (!first) return null;
    if (first.runAt && new Date(first.runAt).getTime() > Date.now()) {
      // Not yet. The wakes consumer will fire `advanceSessionQueue` on the
      // session once the delay has elapsed.
      return null;
    }
    queue.shift();
    await writeQueue(sessionId, queue);
    return first;
  });
}

/** Delete a session's queue file entirely (e.g. when the session is archived). */
export async function clearQueue(sessionId: string): Promise<void> {
  await withLock(sessionId, () => clearQueueUnlocked(sessionId));
}

async function clearQueueUnlocked(sessionId: string): Promise<void> {
  await fs.rm(sessionQueueFile(sessionId), { force: true });
}

async function readQueue(sessionId: string): Promise<QueuedMessage[]> {
  try {
    const content = await fs.readFile(sessionQueueFile(sessionId), "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed) ? (parsed as QueuedMessage[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(
  sessionId: string,
  queue: QueuedMessage[]
): Promise<void> {
  await ensureOrchestratorHome();
  await fs.mkdir(sessionQueuesDir(), { recursive: true });
  await fs.writeFile(sessionQueueFile(sessionId), JSON.stringify(queue, null, 2));
}

/*
 * Serialize read-modify-write operations per session so concurrent requests
 * (e.g. an enqueue racing a dequeue) can't clobber each other's writes. The
 * server is single-process, so an in-memory promise chain per session id is
 * sufficient.
 */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(sessionId) ?? Promise.resolve();
  const next = previous.then(run, run);
  locks.set(
    sessionId,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}
