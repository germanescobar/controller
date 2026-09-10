/**
 * Pure focus-queue navigation math, isolated from React so it can be
 * unit-tested with the existing `node --import tsx --test` runner.
 *
 * Rules (priority order):
 *
 *  - **Awaiting input** — sessions whose agent has paused on a
 *    `user.input_requested` prompt or has a pending tool approval.
 *    These are the most urgent items and always win, even over
 *    recently-finished sessions. The user owes a reply to these;
 *    `awaitingInput` is independent of the session's `active` flag
 *    (Claude's structured-input pause kills the child, so the
 *    session can be inactive and still awaiting). When multiple
 *    sessions are awaiting, the queue's array order picks the
 *    winner (sortFocusQueue puts oldest-arrival first within the
 *    awaiting bucket).
 *  - **Unvisited finished** — finished sessions the user has never
 *    opened (no `lastVisitedAt`). These are the "triage pile." When
 *    the user presses Next from *any* session (running, visited,
 *    or another unvisited), the algorithm re-surfaces the top of
 *    this pile so they walk the unfinished triage in arrival order.
 *    Without this priority, plain circular advance walks the
 *    *current* array order — unvisited → visited → running — and
 *    lands on the second-to-last item when the user is on a
 *    visited session in the middle of the visited block. The scan
 *    starts at `sentIndex + 1` and wraps around, so the user also
 *    walks *forward* through the unvisited pile after visiting one
 *    (on index 0 → next unvisited is index 1, not a re-visit of
 *    index 0). Issue #333 follow-up.
 *  - **Recently finished** — items that finished at or after the
 *    user's previous interaction timestamp. Fresh finishes the
 *    user hasn't answered yet; the algorithm walks the finished
 *    pile in arrival order (oldest first), so the first match in
 *    array order is the oldest such fresh item. Falls through here
 *    only when the unvisited triage pile is exhausted (so it
 *    doesn't matter whether the item is visited or not).
 *  - **Plain circular advance** — sending from index N advances to
 *    N+1, wrapping back to 0 after the last item. If the sent-from
 *    session isn't in the queue, treat it as "before index 0" and
 *    advance to the first item.
 *  - If the resulting `next` is the same session the user just
 *    sent from, return `null` so the caller can stay put. This
 *    covers both the queue-of-one case and the (rare) wrap-to-self
 *    edge case where a single-item queue happens to match the
 *    sent-from id.
 */
export interface FocusQueueItemLike {
  session: { id: string; lastActiveAt: string };
  projectId: string;
  worktreeId: string;
  projectName: string;
  worktreeName: string;
  /**
   * Highest-priority flag. When true, the algorithm returns this
   * session (or the oldest-arrival one of multiple awaiting
   * sessions) before checking the recently-finished bucket. The
   * sent-from session is skipped so the user doesn't get bounced
   * back to the prompt they're already looking at.
   */
  awaitingInput?: boolean;
  /**
   * Set when the session is currently running (the agent is
   * processing a turn). Used by `pickNextFocusItem` to skip
   * running sessions when looking for the next triage target
   * — the user pressing Next while on a running session means
   * "I'm done with this, move on," and we should re-surface the
   * unvisited triage pile rather than bouncing between running
   * sessions.
   */
  active?: boolean;
  /**
   * ISO timestamp of the last time the user landed on this
   * session via any navigation (Next, auto-advance, mark-done
   * follow-up, sidebar click, conversation link). Items with no
   * `lastVisitedAt` are the "triage pile" — finished sessions the
   * user has never opened. Items with a `lastVisitedAt` are
   * visited. The unvisited-finished bucket in
   * `pickNextFocusItem` always wins when there's any unvisited
   * finished item (so the user can resume the triage pile from
   * any session), and the recently-finished bucket falls through
   * to plain circular only when the triage pile is exhausted.
   */
  lastVisitedAt?: string;
}

export function pickFirstFocusItem<
  T extends FocusQueueItemLike,
>(focusQueue: T[], currentSessionId: string): T | null {
  return (
    focusQueue.find((item) => item.session.id !== currentSessionId) ?? null
  );
}

export function pickNextFocusItem<
  T extends FocusQueueItemLike,
>(
  focusQueue: T[],
  sentFromSessionId: string,
  lastInteractionAt: number,
): T | null {
  if (focusQueue.length === 0) return null;

  // 1. Awaiting-input bucket: items whose agent is blocked on the
  //    user (structured-input prompt or pending approval). Always
  //    wins, regardless of when the user last interacted. Skip the
  //    sent-from session — they're already looking at it.
  for (const item of focusQueue) {
    if (item.awaitingInput !== true) continue;
    if (item.session.id === sentFromSessionId) continue;
    return item;
  }

  // 2. Unvisited-finished bucket: the "triage pile." Finished
  //    sessions the user has never visited sit at the top of the
  //    queue in `sortFocusQueue`. When the user presses Next from
  //    *any* session (running, visited, or another unvisited), the
  //    queue should re-surface the top of this pile so they walk the
  //    unfinished triage in arrival order. Without this priority,
  //    plain circular advance walks the *current* array order —
  //    which is unvisited-finished → visited-finished → running —
  //    and lands on the second-to-last item when the user is on a
  //    visited-finished session in the middle of the visited block.
  //
  //    The scan starts at `sentIndex + 1` and wraps around so the
  //    user can also walk *forward* through the unvisited pile
  //    after visiting one (e.g. on index 0 -> next unvisited is
  //    index 1, not a re-visit of index 0). Issue #333 follow-up.
  //
  //    **Fresh-start exemption**: when `sentFromSessionId === ""`
  //    (the user is on the empty state — no active session, e.g.
  //    after a reload), the persisted `visitedAt` map makes every
  //    item look visited and the unvisited bucket comes back empty.
  //    That's not what the user wants: clicking Next from the empty
  //    state means "start triaging from the visual top." In that
  //    case we ignore the visited-state filter so the first click
  //    lands on the visually-first non-running item. Subsequent
  //    clicks (where `sentFromSessionId` is non-empty) respect the
  //    visited state and walk the triage pile in arrival order.
  const len = focusQueue.length;
  const sentIndex = focusQueue.findIndex(
    (item) => item.session.id === sentFromSessionId,
  );
  const scanStart = sentIndex >= 0 ? (sentIndex + 1) % len : 0;
  const startingFresh = sentFromSessionId === "";
  for (let offset = 0; offset < len; offset++) {
    const item = focusQueue[(scanStart + offset) % len];
    if (item.session.id === sentFromSessionId) continue;
    if (item.awaitingInput === true) continue; // handled in step 1
    if (item.active === true) continue; // skip running — user is here to triage
    // When starting fresh (empty active view), ignore the persisted
    // visited state so the first Next click lands on the
    // visually-first item, not on whatever the algorithm fell
    // through to after the empty unvisited bucket.
    if (!startingFresh && item.lastVisitedAt !== undefined) continue;
    return item;
  }

  // 3. Recently-finished bucket: items that finished at or after the
  //    user's previous interaction. The finished pile is sorted
  //    oldest-arrival first within each visited/unvisited sub-bucket,
  //    so the first match in array order is the oldest-arrival such
  //    item. Skip the sent-from session. Falls through to this only
  //    when there are no unvisited items (so it doesn't matter
  //    whether the item is visited or not).
  if (lastInteractionAt > 0) {
    for (let offset = 0; offset < len; offset++) {
      const item = focusQueue[(scanStart + offset) % len];
      if (item.session.id === sentFromSessionId) continue;
      if (item.active === true) continue;
      const finishedAt = new Date(item.session.lastActiveAt).getTime();
      if (finishedAt >= lastInteractionAt) {
        return item;
      }
    }
  }

  // 4. No awaiting-input and no unvisited/recently-finished items:
  //    plain circular advance. This kicks in when the user has
  //    visited every triage item and is now cycling through visited
  //    sessions and running sessions.
  const nextIndex = (scanStart) % len;
  const next = focusQueue[nextIndex];
  if (next.session.id === sentFromSessionId) return null;
  return next;
}
