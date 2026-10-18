/**
 * Pure helpers for the SessionView right-panel visibility logic.
 *
 * The right sidebar on the session page has two visual modes:
 *
 *   - Desktop (`md:` breakpoint and up): a side panel mounted next
 *     to the chat. Driven by `terminalOpen` (visible/hidden) and
 *     `rightTab` (which tab is selected). The chat ↔ side panel
 *     boundary has a drag handle so the user can resize the split.
 *
 *   - Mobile (`< md`): a full-screen panel that's mounted in place
 *     of the chat. Driven by `mobilePanel` ("agent" = chat,
 *     otherwise = which full-screen panel is showing).
 *
 * `terminalOpen`, `rightTab`, and `mobilePanel` all live in
 * SessionView; the desktop/mobile split is tracked by an
 * `isDesktopViewport` media-query state. These helpers encode the
 * rules so they can be unit-tested in isolation — historically
 * SessionView was using `mobilePanel === "agent"` as a proxy for
 * "we're on desktop", which leaked the mobile concept into the
 * desktop logic and produced the regressions where:
 *
 *   1. Opening a file in the Files tab flipped `mobilePanel` to
 *      "files" on desktop, which then hid the resize handle and
 *      made the toggle button a no-op (the right panel stayed
 *      mounted via the `mobilePanel === "files"` branch).
 *
 *   2. The same `mobilePanel` flip hid the resize handle on every
 *      sidebar tab that ended up in `mobilePanel !== "agent"`.
 *
 * The helpers below replace that proxy with the explicit
 * `isDesktopViewport` boolean, restoring the expected desktop
 * behavior and keeping the mobile full-screen mode intact.
 */

export type RightPanelTab = "terminal" | "changes" | "files" | "preview" | "pr";
export type MobilePanel = "agent" | RightPanelTab;

export interface RightPanelState {
  terminalOpen: boolean;
  mobilePanel: MobilePanel;
  rightTab: RightPanelTab;
}

export interface RightPanelVisibilityInput extends RightPanelState {
  isDesktopViewport: boolean;
}

/**
 * Whether the right panel is currently mounted.
 *
 *   - Desktop: mounted iff `terminalOpen` is true.
 *   - Mobile: mounted whenever `mobilePanel` is anything other
 *     than the chat view ("agent"). `terminalOpen` is also
 *     honored so a desktop-style toggle to "show panel" still
 *     opens the side panel if a phone user resizes up.
 */
export function isRightPanelVisible(input: RightPanelVisibilityInput): boolean {
  const { terminalOpen, mobilePanel, isDesktopViewport } = input;
  if (terminalOpen) return true;
  if (!isDesktopViewport && mobilePanel !== "agent") return true;
  return false;
}

/**
 * Whether the chat ↔ right panel drag handle should be rendered.
 *
 * Desktop-only by design: the handle is `hidden md:flex` in the
 * JSX, so it's never visible on phones. On desktop, the handle
 * must appear whenever the right panel is open — across every
 * sidebar tab (Terminal / Changes / Files / PR / Preview). The
 * previous gate `terminalOpen && mobilePanel === "agent"` broke
 * for the Files tab as soon as some other code path flipped
 * `mobilePanel` away from "agent" (the regression in this
 * branch's fix).
 */
export function isRightPanelResizeHandleVisible(
  input: RightPanelVisibilityInput,
): boolean {
  return input.terminalOpen && input.isDesktopViewport;
}

/**
 * Inline width style for the right panel — only meaningful in the
 * desktop split layout, so it's gated on `isDesktopViewport`
 * (not `mobilePanel === "agent"`) for the same reason as the
 * resize handle.
 */
export function getRightPanelInlineWidthStyle(
  input: RightPanelVisibilityInput,
  width: number,
): { width: string; minWidth: string } | undefined {
  if (!isRightPanelResizeHandleVisible(input)) return undefined;
  return { width: `${width}px`, minWidth: `${width}px` };
}

/**
 * The Tailwind class string for the right panel's outer
 * container, given the current viewport and panel state. Kept
 * here so the desktop/mobile split is testable independently
 * from the JSX that consumes it.
 */
export function rightPanelContainerClass(input: RightPanelVisibilityInput): string {
  if (input.isDesktopViewport) {
    // Desktop split: panel is part of the flex row, sized by
    // either the inline width or its default flex behaviour.
    return "hidden md:flex";
  }
  if (input.mobilePanel === "agent") {
    // Mobile chat-only: panel is hidden.
    return "hidden";
  }
  // Mobile full-screen: panel takes the available space and
  // desktop half-width is irrelevant.
  return "flex-1";
}

/**
 * Whether the right-panel toggle button (PanelRight icon in the
 * desktop header) will actually close the right panel when
 * clicked. Used to guard the user-visible regression: on desktop,
 * `setTerminalOpen(false)` should always hide the panel, no
 * matter what `rightTab` or `mobilePanel` is.
 *
 * Returns true when the only thing keeping the right panel
 * mounted is `terminalOpen` itself. False when the panel would
 * remain mounted via `mobilePanel` (mobile full-screen mode) —
 * in that case the toggle button's `setTerminalOpen(false)` is
 * correct, but the user has to clear `mobilePanel` separately
 * (via the mobile sidebar's "Agent" entry) to fully close.
 */
export function doesRightPanelToggleClose(input: RightPanelVisibilityInput): boolean {
  if (!input.terminalOpen) return false;
  if (input.isDesktopViewport) return true;
  // Mobile: toggling `terminalOpen=false` will hide the right
  // panel only if `mobilePanel` is already "agent". Otherwise
  // the full-screen panel stays mounted.
  return input.mobilePanel === "agent";
}
