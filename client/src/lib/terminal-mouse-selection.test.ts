import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { handleTerminalMouseDown } from "./terminal-mouse-selection.ts";

test("secondary click reaches the native menu but not tmux mouse reporting", () => {
  const browserWindow = new Window();
  const container = browserWindow.document.createElement("div");
  const screen = browserWindow.document.createElement("div");
  container.appendChild(screen);
  // Happy DOM implements the browser API with separate type declarations.
  (container as unknown as HTMLElement).addEventListener("mousedown", handleTerminalMouseDown, true);
  let xtermMouseDowns = 0;
  let contextMenus = 0;
  screen.addEventListener("mousedown", () => { xtermMouseDowns += 1; });
  screen.addEventListener("contextmenu", () => { contextMenus += 1; });

  const press = new browserWindow.MouseEvent("mousedown", {
    button: 2, bubbles: true, cancelable: true,
  });
  screen.dispatchEvent(press);
  assert.equal(xtermMouseDowns, 0);
  assert.equal(press.defaultPrevented, false);

  const menu = new browserWindow.MouseEvent("contextmenu", {
    button: 2, bubbles: true, cancelable: true,
  });
  screen.dispatchEvent(menu);
  assert.equal(contextMenus, 1);
  assert.equal(menu.defaultPrevented, false);
});

test("primary selection, wheel scrolling, and copy still reach xterm", () => {
  const browserWindow = new Window();
  const container = browserWindow.document.createElement("div");
  const screen = browserWindow.document.createElement("div");
  container.appendChild(screen);
  (container as unknown as HTMLElement).addEventListener("mousedown", handleTerminalMouseDown, true);
  let leftDown: { altKey: boolean; shiftKey: boolean } | null = null;
  let wheels = 0;
  let copies = 0;
  (screen as unknown as HTMLElement).addEventListener("mousedown", (event) => {
    leftDown = { altKey: event.altKey, shiftKey: event.shiftKey };
  });
  screen.addEventListener("wheel", () => { wheels += 1; });
  screen.addEventListener("copy", () => { copies += 1; });

  screen.dispatchEvent(new browserWindow.MouseEvent("mousedown", { button: 0, bubbles: true }));
  screen.dispatchEvent(new browserWindow.WheelEvent("wheel", { bubbles: true }));
  screen.dispatchEvent(new browserWindow.ClipboardEvent("copy", { bubbles: true }));
  assert.deepEqual(leftDown, { altKey: true, shiftKey: true });
  assert.equal(wheels, 1);
  assert.equal(copies, 1);
});
