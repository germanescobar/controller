import type { QueuedMessage, QueuedMessageInput } from "./session-queue.js";

export type CodexSteerResult =
  | { disposition: "steered" }
  | { disposition: "queued"; message?: QueuedMessage };

interface AcceptCodexSteerOptions {
  queuedMessageId?: string;
  steer: () => Promise<"steered" | "turn-ended">;
  getQueuedMessage: (id: string) => Promise<QueuedMessage | undefined>;
  removeQueuedMessage: (id: string) => Promise<void>;
  buildFollowUp: () => Promise<QueuedMessageInput>;
  enqueueFollowUp: (input: QueuedMessageInput) => Promise<QueuedMessage>;
}

/*
 * Transfer ownership of a Codex composer submission exactly once. A terminal
 * event can win while turn/steer is in flight; in that case a typed message is
 * made durable, while a promoted queue item simply remains owned by the queue.
 */
export async function acceptCodexSteer(
  options: AcceptCodexSteerOptions
): Promise<CodexSteerResult> {
  const outcome = await options.steer();
  if (outcome === "steered") {
    if (options.queuedMessageId) {
      await options.removeQueuedMessage(options.queuedMessageId);
    }
    return { disposition: "steered" };
  }

  if (options.queuedMessageId) {
    return {
      disposition: "queued",
      message: await options.getQueuedMessage(options.queuedMessageId),
    };
  }

  const queued = await options.enqueueFollowUp(await options.buildFollowUp());
  return { disposition: "queued", message: queued };
}
