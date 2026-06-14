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
  createdAt: string;
}

/** Fields the caller supplies; `id` and `createdAt` are assigned on enqueue. */
export type QueuedMessageInput = Omit<QueuedMessage, "id" | "createdAt">;

/** Append a message to the end of a session's queue and return the stored item. */
export async function enqueue(
  sessionId: string,
  input: QueuedMessageInput
): Promise<QueuedMessage> {
  return withLock(sessionId, async () => {
    const queue = await readQueue(sessionId);
    const message: QueuedMessage = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    queue.push(message);
    await writeQueue(sessionId, queue);
    return message;
  });
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

/** Remove and return the first queued message, or null if the queue is empty. */
export async function dequeueFirst(
  sessionId: string
): Promise<QueuedMessage | null> {
  return withLock(sessionId, async () => {
    const queue = await readQueue(sessionId);
    const first = queue.shift();
    if (!first) return null;
    await writeQueue(sessionId, queue);
    return first;
  });
}

/** Delete a session's queue file entirely (e.g. when the session is archived). */
export async function clearQueue(sessionId: string): Promise<void> {
  await withLock(sessionId, async () => {
    await fs.rm(sessionQueueFile(sessionId), { force: true });
  });
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
