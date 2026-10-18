import test from "node:test";
import assert from "node:assert/strict";
import {
  isRightPanelVisible,
  isRightPanelResizeHandleVisible,
  getRightPanelInlineWidthStyle,
  rightPanelContainerClass,
  doesRightPanelToggleClose,
  type MobilePanel,
  type RightPanelTab,
} from "../right-panel-visibility.ts";

const TABS: RightPanelTab[] = ["terminal", "changes", "files", "preview", "pr"];

function state(overrides: {
  terminalOpen?: boolean;
  mobilePanel?: MobilePanel;
  rightTab?: RightPanelTab;
  isDesktopViewport?: boolean;
}) {
  return {
    terminalOpen: overrides.terminalOpen ?? false,
    mobilePanel: overrides.mobilePanel ?? ("agent" as MobilePanel),
    rightTab: overrides.rightTab ?? ("terminal" as RightPanelTab),
    isDesktopViewport: overrides.isDesktopViewport ?? true,
  };
}

// --- Mounting --------------------------------------------------------------

test("right panel is mounted on desktop whenever terminalOpen is true", () => {
  for (const tab of TABS) {
    for (const mobilePanel of ["agent", "files", "preview", "pr"] as MobilePanel[]) {
      const mounted = isRightPanelVisible(state({
        terminalOpen: true,
        mobilePanel,
        rightTab: tab,
        isDesktopViewport: true,
      }));
      assert.equal(mounted, true, `terminalOpen=true on desktop with tab=${tab}, mobilePanel=${mobilePanel} should mount the panel`);
    }
  }
});

test("right panel is mounted on mobile when mobilePanel is non-agent", () => {
  for (const tab of TABS) {
    const mounted = isRightPanelVisible(state({
      terminalOpen: false,
      mobilePanel: tab,
      rightTab: tab,
      isDesktopViewport: false,
    }));
    assert.equal(mounted, true, `mobilePanel=${tab} on mobile should mount the panel`);
  }
});

test("right panel is hidden on mobile when mobilePanel is agent and terminalOpen is false", () => {
  assert.equal(
    isRightPanelVisible(state({ isDesktopViewport: false })),
    false,
  );
});

test("right panel is hidden on desktop when terminalOpen is false even if rightTab is files", () => {
  // Regression: the old render guard was
  // `terminalOpen || mobilePanel === "files" || ...`, which would
  // keep the panel mounted on desktop after a code path flipped
  // `mobilePanel` to "files". With the helper, the desktop branch
  // is owned by `terminalOpen` alone.
  for (const mobilePanel of ["agent", "files", "preview", "pr"] as MobilePanel[]) {
    const mounted = isRightPanelVisible(state({
      terminalOpen: false,
      mobilePanel,
      rightTab: "files",
      isDesktopViewport: true,
    }));
    assert.equal(mounted, false, `terminalOpen=false on desktop with mobilePanel=${mobilePanel} should hide the panel`);
  }
});

// --- Resize handle ---------------------------------------------------------

test("resize handle is visible on desktop across every right-panel tab when terminalOpen is true", () => {
  for (const tab of TABS) {
    for (const mobilePanel of ["agent", "files", "preview", "pr"] as MobilePanel[]) {
      const visible = isRightPanelResizeHandleVisible(state({
        terminalOpen: true,
        mobilePanel,
        rightTab: tab,
        isDesktopViewport: true,
      }));
      assert.equal(
        visible,
        true,
        `handle should be visible for tab=${tab}, mobilePanel=${mobilePanel} on desktop`,
      );
    }
  }
});

test("resize handle is hidden on mobile even when terminalOpen is true", () => {
  for (const tab of TABS) {
    const visible = isRightPanelResizeHandleVisible(state({
      terminalOpen: true,
      mobilePanel: "agent",
      rightTab: tab,
      isDesktopViewport: false,
    }));
    assert.equal(visible, false, `handle should be hidden for tab=${tab} on mobile`);
  }
});

test("resize handle regression: opening a file on desktop no longer hides it", () => {
  // The user-visible regression: open the right panel on the
  // Files tab, then click a file. The old code path set
  // `mobilePanel = "files"` on desktop, and the handle's gate
  // was `mobilePanel === "agent"`, so the handle silently
  // disappeared. The helper never reads `mobilePanel` for the
  // handle, so the handle stays visible.
  const before = isRightPanelResizeHandleVisible(state({
    terminalOpen: true,
    mobilePanel: "agent",
    rightTab: "files",
    isDesktopViewport: true,
  }));
  const after = isRightPanelResizeHandleVisible(state({
    terminalOpen: true,
    mobilePanel: "files",
    rightTab: "files",
    isDesktopViewport: true,
  }));
  assert.equal(before, true);
  assert.equal(after, true);
});

// --- Inline width ----------------------------------------------------------

test("inline width is set only on desktop when terminalOpen is true", () => {
  const desktop = getRightPanelInlineWidthStyle(
    state({ terminalOpen: true, isDesktopViewport: true }),
    480,
  );
  assert.deepEqual(desktop, { width: "480px", minWidth: "480px" });

  const mobile = getRightPanelInlineWidthStyle(
    state({ terminalOpen: true, isDesktopViewport: false }),
    480,
  );
  assert.equal(mobile, undefined);

  const closed = getRightPanelInlineWidthStyle(
    state({ terminalOpen: false, isDesktopViewport: true }),
    480,
  );
  assert.equal(closed, undefined);
});

test("inline width regression: non-agent mobilePanel on desktop still applies the width", () => {
  // After the fix, the inline width follows the viewport, not
  // `mobilePanel`. Even when some other code path has flipped
  // `mobilePanel` to "files" on desktop, the saved panel width
  // continues to apply.
  const width = getRightPanelInlineWidthStyle(
    state({
      terminalOpen: true,
      mobilePanel: "files",
      rightTab: "files",
      isDesktopViewport: true,
    }),
    600,
  );
  assert.deepEqual(width, { width: "600px", minWidth: "600px" });
});

// --- Container class -------------------------------------------------------

test("right panel uses the desktop hidden md:flex class on a desktop chat view", () => {
  // terminalOpen=true → `hidden md:flex` (desktop split layout).
  // The actual class string is built by JSX; we just verify the
  // helper returns one that keeps the panel mounted and sized
  // for the desktop split.
  const cls = rightPanelContainerClass(state({
    terminalOpen: true,
    isDesktopViewport: true,
  }));
  assert.equal(cls, "hidden md:flex");
});

test("right panel hides on mobile when mobilePanel is agent", () => {
  const cls = rightPanelContainerClass(state({
    isDesktopViewport: false,
    mobilePanel: "agent",
  }));
  assert.equal(cls, "hidden");
});

test("right panel fills the viewport on mobile when mobilePanel is non-agent", () => {
  const cls = rightPanelContainerClass(state({
    isDesktopViewport: false,
    mobilePanel: "files",
  }));
  assert.equal(cls, "flex-1");
});

// --- Close behavior --------------------------------------------------------

test("right-panel toggle button closes the panel on desktop for every tab", () => {
  // Regression: on desktop, the header's PanelRight toggle calls
  // `setTerminalOpen(!terminalOpen)`. The right panel must hide
  // in every tab, no matter what `mobilePanel` happens to be.
  // The previous code mounted the panel via
  // `mobilePanel === "files"` on desktop too, so toggling
  // `terminalOpen` was a no-op after a file had been opened.
  for (const tab of TABS) {
    for (const mobilePanel of ["agent", "files", "preview", "pr"] as MobilePanel[]) {
      const s = state({
        terminalOpen: true,
        mobilePanel,
        rightTab: tab,
        isDesktopViewport: true,
      });
      // Toggling terminalOpen=false hides the panel on desktop.
      const closed = isRightPanelVisible({ ...s, terminalOpen: false });
      assert.equal(
        closed,
        false,
        `desktop toggle should hide panel for tab=${tab}, mobilePanel=${mobilePanel}`,
      );
    }
  }
});

test("doesRightPanelToggleClose tracks the user-visible close behaviour", () => {
  assert.equal(
    doesRightPanelToggleClose(state({ terminalOpen: true, isDesktopViewport: true })),
    true,
    "desktop toggle closes the panel when terminalOpen is true",
  );
  assert.equal(
    doesRightPanelToggleClose(state({ terminalOpen: false, isDesktopViewport: true })),
    false,
    "toggle is a no-op when the panel is already closed",
  );
  assert.equal(
    doesRightPanelToggleClose(state({
      terminalOpen: true,
      isDesktopViewport: false,
      mobilePanel: "files",
    })),
    false,
    "mobile toggle only closes the right panel if mobilePanel is agent",
  );
  assert.equal(
    doesRightPanelToggleClose(state({
      terminalOpen: true,
      isDesktopViewport: false,
      mobilePanel: "agent",
    })),
    true,
    "mobile toggle with mobilePanel=agent still closes the right panel",
  );
});
