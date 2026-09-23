/*
 * Session relationships store + hook (issue #384).
 *
 * The floating focus panel shows a `Parent` row (when the current
 * session has one) and a `Children` row (when it has any). The
 * underlying endpoint at `/api/sessions/:sessionId/children`
 * (`fetchSessionRelationships`) returns both sides in one round trip.
 *
 * A tiny in-memory store + `useSessionRelationships(sessionId)` hook
 * keeps multiple panels in sync (the panel mounts both for desktop
 * and mobile variants — issue #384 explicit out-of-scope: mobile is
 * unchanged, but the hook has to be safe to call from either). The
 * store is fed by:
 *
 *   - `useEffect` on `sessionId`: kick a fresh fetch whenever the
 *     user navigates between sessions.
 *   - `bumpRelationshipsRefresh()` from `App.tsx` whenever the
 *     project event stream (or a focus/title/archived mutation)
 *     bumps `eventsRefreshKey` / `focusRefreshKey`. This is the
 *     issue's "live without polling" guarantee: a child spawned or
 *     finished in another tab shows up here on the next event.
 *
 * The store is intentionally small and write-through: a successful
 * fetch replaces the entire `Record<sessionId, SessionRelationships | null>`
 * entry. Existing entries stay visible until the in-flight fetch
 * resolves, so a panel never flickers to "loading" mid-session.
 */

import { useCallback, useEffect, useState } from "react";
import {
  fetchSessionRelationships,
  type SessionRelationships,
} from "../api.ts";

type RelationshipsById = Record<string, SessionRelationships | null>;

const relationships: RelationshipsById = {};
const listeners = new Set<() => void>();

// Monotonic counter so the hook can detect a refresh-bump even when
// the same payload is fetched twice in a row (e.g. a child was
// spawned and finished in the same event burst).
let refreshCounter = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

function setEntry(sessionId: string, value: SessionRelationships | null): void {
  relationships[sessionId] = value;
  notify();
}

/**
 * Schedule a re-fetch for every cached session id. Called from
 * `App.tsx` whenever the project-event stream bumps `eventsRefreshKey`
 * or the focus-queue mutation handlers bump `focusRefreshKey`.
 */
export function bumpRelationshipsRefresh(): void {
  refreshCounter += 1;
  notify();
}

/**
 * In-flight fetches keyed by session id. Reusing the same promise
 * across `sessionId` + `refreshCounter` bumps coalesces duplicate
 * work (e.g. when a panel mounts and the parent bumps the refresh
 * counter on the same tick).
 */
const inflight = new Map<string, Promise<void>>();

function ensureFetched(sessionId: string): void {
  if (inflight.has(sessionId)) return;
  const promise = (async () => {
    try {
      const result = await fetchSessionRelationships(sessionId);
      setEntry(sessionId, result);
    } catch {
      // A failed fetch leaves the previous entry in place. The
      // hook renders `null` only on the very first failure for a
      // session id, which matches the existing fetch behavior on
      // /title: the UI falls back to a neutral state rather than
      // a hard error.
      if (!(sessionId in relationships)) {
        setEntry(sessionId, null);
      }
    } finally {
      inflight.delete(sessionId);
    }
  })();
  inflight.set(sessionId, promise);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Subscribe to the cached relationships for a session id. Returns
 * `null` until the first fetch resolves; once it resolves, returns
 * the most recent payload (which may itself be `null` if the
 * session has no parent and no children, or the server returns
 * `null`).
 */
export function useSessionRelationships(
  sessionId: string | null
): SessionRelationships | null {
  const subscribeListener = useCallback(
    (listener: () => void) => {
      const unsubscribe = subscribe(listener);
      return unsubscribe;
    },
    []
  );

  const [snapshot, setSnapshot] = useState<SessionRelationships | null>(() =>
    sessionId ? (relationships[sessionId] ?? null) : null
  );

  useEffect(() => {
    if (!sessionId) {
      setSnapshot(null);
      return;
    }
    // Seed from the cache (handles panel remounts inside the same
    // session without a network round trip), then kick the fetch.
    setSnapshot(relationships[sessionId] ?? null);
    ensureFetched(sessionId);
    const unsubscribe = subscribeListener(() => {
      setSnapshot(relationships[sessionId] ?? null);
    });
    return unsubscribe;
  }, [sessionId, subscribeListener]);

  useEffect(() => {
    // Re-fetch when the global refresh counter advances — a new
    // child may have been spawned or finished somewhere in the
    // app and `App.tsx` bumped the counter for us.
    if (!sessionId) return;
    if (refreshCounter === 0) return;
    ensureFetched(sessionId);
  }, [sessionId, refreshCounter]);

  return snapshot;
}

/**
 * Test-only: reset the in-memory cache between unit tests.
 */
export function __resetRelationshipsForTests(): void {
  for (const key of Object.keys(relationships)) delete relationships[key];
  inflight.clear();
  refreshCounter = 0;
  listeners.clear();
}
