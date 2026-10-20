import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { installTerminalTouchScroll } from "./terminal-touch-scroll.ts";

test("one-finger drags scroll terminal history without reaching xterm or scrolling the page", () => {
  const browserWindow = new Window();
  const parent = browserWindow.document.createElement("div");
  const container = browserWindow.document.createElement("div");
  const screen = browserWindow.document.createElement("div");
  parent.appendChild(container);
  container.appendChild(screen);
  const scrolled: number[] = [];
  let screenMoves = 0;
  let parentMoves = 0;
  screen.addEventListener("touchmove", () => { screenMoves += 1; });
  parent.addEventListener("touchmove", () => { parentMoves += 1; });
  // Happy DOM implements the browser element API with separate type declarations.
  const remove = installTerminalTouchScroll(container as unknown as HTMLElement, {
    options: { fontSize: 10, lineHeight: 2 },
    scrollLines: (lines) => { scrolled.push(lines); },
  });
  const touch = (y: number) => new browserWindow.Touch({
    identifier: 1, target: screen, clientY: y,
  });
  const dispatch = (type: string, y: number) => {
    const event = new browserWindow.TouchEvent(type, {
      touches: [touch(y)], bubbles: true, cancelable: true,
    });
    screen.dispatchEvent(event);
    return event;
  };

  dispatch("touchstart", 100);
  assert.equal(dispatch("touchmove", 65).defaultPrevented, true);
  assert.equal(dispatch("touchmove", 50).defaultPrevented, true);
  assert.deepEqual(scrolled, [1, 1]);
  assert.equal(screenMoves, 0);
  assert.equal(parentMoves, 0);

  remove();
  assert.equal(dispatch("touchmove", 30).defaultPrevented, false);
});

test("a tap and multi-touch gesture do not scroll or block terminal input", () => {
  const browserWindow = new Window();
  const container = browserWindow.document.createElement("div");
  const scrolled: number[] = [];
  installTerminalTouchScroll(container as unknown as HTMLElement, {
    options: { fontSize: 13 },
    scrollLines: (lines) => { scrolled.push(lines); },
  });
  const touch = (identifier: number, y: number) => new browserWindow.Touch({
    identifier, target: container, clientY: y,
  });
  const tap = new browserWindow.TouchEvent("touchstart", {
    touches: [touch(1, 100)], bubbles: true, cancelable: true,
  });
  container.dispatchEvent(tap);
  assert.equal(tap.defaultPrevented, false);
  const pinch = new browserWindow.TouchEvent("touchmove", {
    touches: [touch(1, 80), touch(2, 120)], bubbles: true, cancelable: true,
  });
  container.dispatchEvent(pinch);
  assert.equal(pinch.defaultPrevented, false);
  assert.deepEqual(scrolled, []);
});
