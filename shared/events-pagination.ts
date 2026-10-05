/*
 * Pure helpers for the client-side pagination stitch (issue #404).
 *
 * The paginated read returns the page that ends just before the
 * client's anchor (the oldest event in the currently-loaded page),
 * with a small overlap window so the seam can dedupe any
 * user_message + agent-echo pair that straddles the boundary. The
 * server returns raw events (no server-side dedupe for paginated
 * reads), so the client concatenates the new page with the first
 * `TAIL_DEDUPE_OVERLAP` events of the loaded page, runs the shared
 * dedupe, and identifies the events to prepend by membership in
 * the new page's id set — NOT by a fixed-count slice, which would
 * drop the merged event whenever a seam dedupe reduced the count
 * (chatgpt-codex-connector review P2 on PR #405).
 *
 * Kept in `shared/` so the rules are testable without spinning up
 * the React component, and so any other client that paginates
 * through the events endpoint can use the same seam-merge logic
 * (e.g. a future native-shell consumer).
 */

import { sharedDedupeUserMessageEvents, type SharedAgentEvent } from "./events-dedupe.ts";

/**
 * Width of the dedupe-overlap window. The route asks the server
 * for `limit + TAIL_DEDUPE_OVERLAP` events on every paginated read
 * (see `server/routes/sessions.ts`), so the client's seam context
 * is the first `TAIL_DEDUPE_OVERLAP` events of the currently-loaded
 * page (chronologically, the OLDEST events in the loaded page).
 * Keeping the constant small (2) is safe because user_message
 * + agent-echo pairs are always consecutive in the file.
 */
export const TAIL_DEDUPE_OVERLAP = 2;

export interface PaginatedStitchResult {
  /**
   * The events to prepend to the loaded page, in chronological
   * order. May be empty (no older events exist).
   */
  newPage: SharedAgentEvent[];
  /**
   * The ids from `loadedPageHead` that were collapsed into a
   * `newPage` event by dedupe. The caller must DROP these events
   * from the loaded page (or, equivalently, from `loadedPageTail`,
   * the part of the loaded page that comes after `loadedPageHead`)
   * when assembling the final list — the merged canonical event
   * is now in `newPage`, and the original echo / marker would
   * otherwise be duplicated.
   *
   * Empty when no dedupe happened — in that case the loaded page
   * head is preserved as-is and `newPage` simply prepends.
   *
   * PR review P2 round 2 from chatgpt-codex-connector on #405:
   * the round-1 fix preserved the merged event in `newPage` but
   * the caller still kept the original echo in `events`, so the
   * timeline rendered both events. This field tells the caller
   * which loaded-head events to drop so the deduped seam
   * collapses to a single event.
   */
  consumedHeadIds: Set<string>;
  /**
   * `true` if the entire new page was a no-op after dedupe (e.g.
   * the user scrolled past the head of the file and the server
   * returned events that all overlapped with the loaded page).
   * The caller should latch `reachedTranscriptStart` to suppress
   * further scroll-up fetches.
   */
  noMoreOlderEvents: boolean;
}

/**
 * Merge a freshly-fetched older page with the seam context from
 * the currently-loaded page and return the events to prepend.
 *
 * Inputs:
 * - `newPageRaw`: the events returned by `GET .../events?before=<anchor>`.
 *   These are the events *older* than the anchor in file order.
 *   May be empty if the server reached the head of the file.
 * - `loadedPageHead`: the first `TAIL_DEDUPE_OVERLAP` events of
 *   the currently-loaded page (chronologically the OLDEST events
 *   in the loaded page, i.e. those adjacent to the seam).
 *
 * The function:
 * 1. Concatenates `[...newPageRaw, ...loadedPageHead]`.
 * 2. Runs the shared `dedupeUserMessageEvents` to collapse any
 *    user_message + agent-echo pair that straddles the seam.
 * 3. Returns the events in `deduped` whose id was NOT in
 *    `loadedPageHead` — these are the new events to prepend. A
 *    deduped event whose id came from `loadedPageHead` is
 *    already part of the loaded page; a deduped event whose id
 *    came from the new page (or whose id is new because the
 *    merger produced it) belongs in the prepended set.
 * 4. Returns the subset of `loadedPageHead` ids that were
 *    consumed by dedupe — the loaded page must NOT keep them after
 *    the prepend, otherwise the deduped seam renders twice. The
 *    caller assembles the final list as
 *    `[...newPage, ...loadedPageTail]` where `loadedPageTail`
 *    is the loaded page with every `consumedHeadIds` event
 *    removed from the head.
 *
 * Edge cases:
 * - Empty `newPageRaw` → returns `{ newPage: [], consumedHeadIds: empty, noMoreOlderEvents: true }`.
 * - `loadedPageHead` shorter than `TAIL_DEDUPE_OVERLAP` (very
 *   short loaded page) → use whatever's available; the seam dedupe
 *   will still operate on the smaller context.
 * - The `noMoreOlderEvents` flag fires when the new page is empty
 *   OR when every event in the new page was collapsed into the
 *   loaded-page head by dedupe (defensive — the route should never
 *   return a fully-collapsed new page, but the check keeps the
 *   client from running a useless zero-length prepend).
 */
export function stitchPaginatedEvents(
  newPageRaw: SharedAgentEvent[],
  loadedPageHead: SharedAgentEvent[]
): PaginatedStitchResult {
  if (newPageRaw.length === 0) {
    return { newPage: [], consumedHeadIds: new Set(), noMoreOlderEvents: true };
  }
  const overlapIds = new Set(loadedPageHead.map((e) => e.id));
  const concatenated = [...newPageRaw, ...loadedPageHead];
  const deduped = sharedDedupeUserMessageEvents(concatenated);
  const newPage: SharedAgentEvent[] = [];
  for (const event of deduped) {
    if (overlapIds.has(event.id)) continue;
    newPage.push(event);
  }
  // An event from `loadedPageHead` is consumed iff it no longer
  // appears as a distinct event in `deduped` (it was collapsed
  // into a `newPage` event by dedupe). We compute the surviving
  // loaded-head ids and report the consumed ones — the caller
  // drops those from `loadedPageTail` when assembling the final
  // list so the seam dedupes to a single canonical event.
  const survivingHeadIds = new Set(
    deduped.filter((e) => overlapIds.has(e.id)).map((e) => e.id),
  );
  const consumedHeadIds = new Set<string>();
  for (const head of loadedPageHead) {
    if (!survivingHeadIds.has(head.id)) consumedHeadIds.add(head.id);
  }
  return {
    newPage,
    consumedHeadIds,
    noMoreOlderEvents: newPage.length === 0,
  };
}