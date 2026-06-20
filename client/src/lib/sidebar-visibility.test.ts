import test from "node:test";
import assert from "node:assert/strict";
import {
  SIDEBAR_DESKTOP_MIN_WIDTH,
  isSidebarDataVisible,
} from "./sidebar-visibility.ts";

test("isSidebarDataVisible: desktop viewport is always visible", () => {
  // Even when the mobile drawer is closed, the desktop sidebar is
  // pinned to the left edge of the screen and the user can see it.
  assert.equal(isSidebarDataVisible(1024, false), true);
  assert.equal(isSidebarDataVisible(1280, false), true);
  assert.equal(isSidebarDataVisible(768, false), true);
});

test("isSidebarDataVisible: mobile drawer closed means hidden", () => {
  // Below the md breakpoint, the sidebar is off-canvas until the
  // user taps the hamburger. Until then we must skip the worktree +
  // session fetch waterfall (issue #126).
  assert.equal(isSidebarDataVisible(320, false), false);
  assert.equal(isSidebarDataVisible(767, false), false);
});

test("isSidebarDataVisible: mobile drawer open means visible", () => {
  // On mobile, opening the drawer flips visibility on and kicks off
  // the deferred load.
  assert.equal(isSidebarDataVisible(320, true), true);
  assert.equal(isSidebarDataVisible(767, true), true);
});

test("isSidebarDataVisible: exactly at md breakpoint is desktop", () => {
  // 768 is the md threshold — the sidebar is on-screen from this
  // point up. Touching this constant is fine; the test just pins
  // the behavior so a future tweak doesn't silently flip mobile
  // users into desktop mode (or vice versa).
  assert.equal(isSidebarDataVisible(SIDEBAR_DESKTOP_MIN_WIDTH, false), true);
  assert.equal(isSidebarDataVisible(SIDEBAR_DESKTOP_MIN_WIDTH - 1, true), true);
});
