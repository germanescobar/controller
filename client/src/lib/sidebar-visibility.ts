/**
 * Visibility rule for the sidebar's data fetch (issue #126).
 *
 * The sidebar's worktree + session waterfall is heavy: for every
 * project it issues a `fetchWorktrees` request, then per-worktree a
 * `fetchSessions` request, then a bulk `fetchActiveRuntimes` request,
 * and polls the active runtimes every two seconds. On mobile the
 * sidebar is hidden behind a drawer that's closed by default, so
 * firing all of that on first paint is wasted work that blocks
 * first interactivity on small screens.
 *
 * The rule below defines when the data layer should be considered
 * "active":
 *
 *   - Desktop (viewport ≥ md breakpoint): always active. The sidebar
 *     is pinned to the left edge via the `md:translate-x-0` CSS rule
 *     regardless of the drawer's open state, so the user can always
 *     see it.
 *   - Mobile: active only while the drawer is open. As soon as the
 *     user taps the hamburger the rule flips to true and the deferred
 *     load kicks off; when they close it again we stop polling.
 *
 * The constant MUST stay in sync with Tailwind's `md` breakpoint
 * (768px). If Tailwind changes, update both.
 *
 * Exported as a pure function so the rule is unit-testable without
 * a DOM, and so `App.tsx` (which owns viewport tracking) and any
 * future component that wants to gate on the same condition can
 * share the same definition.
 */

export const SIDEBAR_DESKTOP_MIN_WIDTH = 768;

export function isSidebarDataVisible(
  viewportWidth: number,
  sidebarOpen: boolean,
): boolean {
  return viewportWidth >= SIDEBAR_DESKTOP_MIN_WIDTH || sidebarOpen;
}
