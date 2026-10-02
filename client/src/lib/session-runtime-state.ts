import { useEffect, useState } from "react";
import {
  fetchSessionQueue,
  listSessionMonitors,
  type Monitor,
  type QueuedMessage,
} from "../api.ts";

/*
 * Session runtime state for the floating bar.
 *
 * Two pieces of information are useful there and neither has a live
 * stream today (issue #339 review):
 *
 *   1. The queue's head's `runAt`. When set, the wakes consumer
 *      is holding the next message until that wall clock — the
 *      bar can render a "next run in Xs" countdown, matching the
 *      existing auto-advance one.
 *
 *   2. The list of running monitors for the session. A user
 *      watching `gh pr checks --watch` should see that watch is
 *      still alive without opening a separate surface.
 *
 * Both are polled on an interval. The delay row needs a 1s tick
 * (it shows a countdown); the monitor list changes far less often
 * and a coarser 5s tick is fine. The hook returns the latest
 * snapshot so the bar can re-render without owning the timer.
 *
 * Errors are swallowed — a missed poll must not blank the panel.
 * 404s on the monitor endpoint also resolve to empty (handled in
 * `listSessionMonitors`).
 */

export interface SessionRuntimeState {
  /** ISO timestamp from the head queued message's `runAt`, or `null`. */
  delayRunAt: string | null;
  /**
   * Short preview of the head queued message's text, or `null`
   * when no delayed follow-up is queued. The floating panel
   * surfaces this so the user can tell *what* is going to fire,
   * not only *when* — otherwise a wake like `wake self "Hello"`
   * looks identical to any other delayed follow-up, and the
   * queued-messages strip at the bottom of the chat is the only
   * place where the actual payload shows up. Truncated here to
   * keep the floating panel compact (see
   * `truncateWakePreview`); the full text is still available in
   * the queued-messages strip below the chat input.
   */
  delayMessagePreview: string | null;
  /** Currently running monitors for the session. */
  monitors: Monitor[];
}

const EMPTY_STATE: SessionRuntimeState = {
  delayRunAt: null,
  delayMessagePreview: null,
  monitors: [],
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

/**
 * Filter the queued-messages list for the composer queue strip.
 * Drops wake messages (`runAt` in the future) so the strip
 * doesn't double-list what the floating panel already shows
 * (issue #339 + wake-preview follow-up). Messages without
 * `runAt` (user-typed queue entries, `sessions send`, goal
 * follow-ups that were advanced directly, etc.) and wakes whose
 * delay has already elapsed but haven't been drained yet pass
 * through unchanged.
 *
 * `now` is parameterized so the helper is unit-testable; the
 * caller passes `Date.now()`. The function is intentionally
 * pure — no React, no side effects.
 */
export function filterVisibleQueue(
  queue: readonly QueuedMessage[],
  now: number = Date.now(),
): QueuedMessage[] {
  return queue.filter(
    (item) => !item.runAt || new Date(item.runAt).getTime() <= now,
  );
}

/**
 * Poll the queue head's `runAt` and the monitor list for a session.
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
    const tick = async () => {
      // Run the two fetches in parallel — they hit different routes
      // and the floating bar shows them as separate rows, so neither
      // should gate the other.
      const [queue, monitors] = await Promise.all([
        fetchSessionQueue(projectId, sessionId).catch(() => []),
        listSessionMonitors(sessionId).catch(() => []),
      ]);
      if (cancelled) return;
      const head = queue[0];
      // `runAt` is the wakes consumer's "hold until" timestamp; a
      // message without it goes straight to the head of the queue
      // and isn't really a wake, so we don't surface it in the
      // panel's delay row.
      const delayRunAt =
        head && typeof head.runAt === "string" && head.runAt
          ? head.runAt
          : null;
      // Prefer `visibleText` (the user-visible form, e.g. after
      // stripping skill preambles) and fall back to `text` for
      // older queue shapes. Empty / whitespace-only previews are
      // dropped so the row never renders an empty label.
      const rawPreview =
        head && typeof head.visibleText === "string" && head.visibleText.trim()
          ? head.visibleText.trim()
          : head && typeof head.text === "string" && head.text.trim()
            ? head.text.trim()
            : null;
      const delayMessagePreview = delayRunAt && rawPreview ? rawPreview : null;
      setState({ delayRunAt, delayMessagePreview, monitors });
    };
    void tick();
    const interval = window.setInterval(() => {
      void tick();
    }, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [projectId, sessionId, intervalMs]);

  return state;
}
