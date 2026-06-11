/**
 * Pure focus-queue navigation math, isolated from React so it can be
 * unit-tested with the existing `node --import tsx --test` runner.
 *
 * Rules (preserved from the original in-line handler in `App.tsx`):
 *
 *  - The queue is circular. Sending from index N advances to the next
 *    index, wrapping back to 0 after the last item.
 *  - If the sent-from session isn't in the queue at all, treat it as
 *    "before the queue" and advance to the first item.
 *  - If the resulting `next` is the same session the user just sent
 *    to, return `null` so the caller can stay put. This covers both
 *    the queue-of-one case and the (rare) wrap-to-self edge case
 *    where a single-item queue happens to match the sent-from id.
 */
export interface FocusQueueItemLike {
  session: { id: string };
  projectId: string;
  worktreeId: string;
  projectName: string;
  worktreeName: string;
}

export function pickNextFocusItem<
  T extends FocusQueueItemLike,
>(focusQueue: T[], sentFromSessionId: string): T | null {
  if (focusQueue.length === 0) return null;
  const sentIndex = focusQueue.findIndex(
    (item) => item.session.id === sentFromSessionId,
  );
  const startIndex = sentIndex >= 0 ? sentIndex : -1;
  const nextIndex = (startIndex + 1 + focusQueue.length) % focusQueue.length;
  const next = focusQueue[nextIndex];
  if (next.session.id === sentFromSessionId) return null;
  return next;
}
