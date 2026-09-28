import { useEffect, useState } from "react";
import {
  fetchSessionQueue,
  listSessionMonitors,
  type Monitor,
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
  /** Currently running monitors for the session. */
  monitors: Monitor[];
}

const EMPTY_STATE: SessionRuntimeState = {
  delayRunAt: null,
  monitors: [],
};

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
      const delayRunAt =
        head && typeof head.runAt === "string" && head.runAt
          ? head.runAt
          : null;
      setState({ delayRunAt, monitors });
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
