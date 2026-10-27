import { useEffect, useState } from "react";
import {
  fetchSessionQueue,
  listSessionMonitors,
  type Monitor,
  type QueuedMessage,
  type SessionGoal,
  getSessionGoal,
} from "../api.ts";

/* Poll pending follow-ups, active goal, and monitors for the floating panel. */

export interface SessionRuntimeState {
  /** ISO timestamp from the first delayed follow-up, or `null`. */
  delayRunAt: string | null;
  /** Short text preview for the legacy delay row. */
  delayMessagePreview: string | null;
  /** Currently running monitors for the session. */
  monitors: Monitor[];
  followUps: QueuedMessage[];
  goal: SessionGoal | null;
}

const EMPTY_STATE: SessionRuntimeState = {
  delayRunAt: null,
  delayMessagePreview: null,
  monitors: [],
  followUps: [],
  goal: null,
};

/**
 * Truncate a wake message preview for the floating panel. Long
 * messages would wrap inside the narrow column and steal width
 * from the Next/Done action row. The ellipsis mirrors the same
 * relationship-row truncation so the panel keeps one truncation
 * style across all rows.
 */
const MAX_WAKE_PREVIEW_LENGTH = 40;
export function truncateWakePreview(value: string): string {
  if (value.length <= MAX_WAKE_PREVIEW_LENGTH) return value;
  return `${value.slice(0, MAX_WAKE_PREVIEW_LENGTH)}…`;
}

/** Legacy entries have no origin. A scheduled entry or system marker is a follow-up. */
export function isUserQueuedMessage(message: QueuedMessage): boolean {
  if (message.origin) return message.origin === "user";
  const marked = (text: string) => /^\[\/(?:monitor|from):/.test(text)
    || text.startsWith("Continue working toward the active goal.");
  return !message.runAt && !marked(message.visibleText) && !marked(message.text);
}

export function filterVisibleQueue(queue: readonly QueuedMessage[]): QueuedMessage[] {
  return queue.filter(isUserQueuedMessage);
}

/**
 * Poll delayed follow-ups and the monitor list for a session.
 * Pass `null` when no session is mounted (e.g. archived view) to
 * short-circuit the fetches.
 *
 * The hook re-fetches every `intervalMs` (default 2s — the floating
 * bar's countdown needs ~1s granularity but the cost of two
 * requests per tick is the same as one), and also once on mount.
 */
export function useSessionRuntimeState(
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
  worktreeId: string,
  intervalMs: number = 2000
): SessionRuntimeState {
  const [state, setState] = useState<SessionRuntimeState>(EMPTY_STATE);

  useEffect(() => {
    if (!projectId || !sessionId) {
      setState(EMPTY_STATE);
      return;
    }
    // Clear the snapshot synchronously when the bound session
    // changes, *before* the first fetch fires. The session view is
    // reused across session ids within the same project+worktree
    // (App.tsx keys it on `${projectId}:${worktreeId}`), so this
    // effect can re-run on a session switch without a remount —
    // without the synchronous reset, the new conversation would
    // briefly show the previous one until the new fetch resolves.
    // Setting EMPTY_STATE first also keeps the `cancelled` guard
    // below correct: the stale `tick` from the previous session is
    // already past by the time the new effect starts, and the
    // effect-local `cancelled` flag now matches the new mount.
    setState(EMPTY_STATE);
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      // These independent surfaces share the same polling interval.
      try {
        const [queue, monitors, goal] = await Promise.all([
          fetchSessionQueue(projectId, sessionId).catch(() => []),
          listSessionMonitors(sessionId).catch(() => []),
          getSessionGoal(projectId, sessionId, worktreeId).catch(() => null),
        ]);
        if (cancelled) return;
        const delayed = queue.find((message) => typeof message.runAt === "string" && message.runAt);
        // `runAt` is the wakes consumer's "hold until" timestamp; a
        // message without it can run as soon as the session is idle
        // and isn't really a wake, so we don't surface it in the
        // panel's delay row.
        const delayRunAt =
          delayed && typeof delayed.runAt === "string" && delayed.runAt
            ? delayed.runAt
            : null;
        // Prefer `visibleText` (the user-visible form, e.g. after
        // stripping skill preambles) and fall back to `text` for
        // older queue shapes. Empty / whitespace-only previews are
        // dropped so the row never renders an empty label.
        const rawPreview =
          delayed && typeof delayed.visibleText === "string" && delayed.visibleText.trim()
            ? delayed.visibleText.trim()
            : delayed && typeof delayed.text === "string" && delayed.text.trim()
              ? delayed.text.trim()
              : null;
        const delayMessagePreview = delayRunAt && rawPreview ? rawPreview : null;
        setState({
          delayRunAt,
          delayMessagePreview,
          monitors,
          goal,
          followUps: queue.filter((message) => !isUserQueuedMessage(message)),
        });
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const interval = window.setInterval(() => {
      void tick();
    }, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [projectId, sessionId, worktreeId, intervalMs]);

  return state;
}
