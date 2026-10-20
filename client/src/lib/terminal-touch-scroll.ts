interface ScrollableTerminal {
  options: { fontSize?: number; lineHeight?: number };
  scrollLines(lines: number): void;
}

export function installTerminalTouchScroll(container: HTMLElement, term: ScrollableTerminal): () => void {
  let lastY: number | null = null;
  let remainder = 0;

  const onStart = (event: TouchEvent) => {
    lastY = event.touches.length === 1 ? event.touches[0].clientY : null;
    remainder = 0;
  };
  const onMove = (event: TouchEvent) => {
    if (lastY === null || event.touches.length !== 1) return;
    const y = event.touches[0].clientY;
    remainder += lastY - y;
    lastY = y;
    const lineHeight = (term.options.fontSize ?? 13) * (term.options.lineHeight ?? 1);
    const lines = Math.trunc(remainder / lineHeight);
    if (lines) {
      term.scrollLines(lines);
      remainder -= lines * lineHeight;
    }
    // Stop xterm's mouse tracking and the browser's synthetic click/scroll.
    event.preventDefault();
    event.stopPropagation();
  };
  const onEnd = () => { lastY = null; };

  container.addEventListener("touchstart", onStart, { capture: true, passive: true });
  container.addEventListener("touchmove", onMove, { capture: true, passive: false });
  container.addEventListener("touchend", onEnd, { capture: true });
  container.addEventListener("touchcancel", onEnd, { capture: true });

  return () => {
    container.removeEventListener("touchstart", onStart, { capture: true });
    container.removeEventListener("touchmove", onMove, { capture: true });
    container.removeEventListener("touchend", onEnd, { capture: true });
    container.removeEventListener("touchcancel", onEnd, { capture: true });
  };
}
