import { useState, useEffect, useCallback, useRef } from "react";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

interface UseResizablePanelOptions {
  /** Key used to persist the width in localStorage. */
  storageKey: string;
  /**
   * Default width in pixels when no saved value exists. Callers that
   * need a viewport-derived default should pass a static fallback
   * here: reading `window.innerWidth` during the first render forces a
   * synchronous layout, which is the problem this hook is designed to
   * help with (see issue #126 — mobile right-panel defaults).
   */
  defaultWidth: number;
  /** Minimum width in pixels. */
  minWidth: number;
  /** Maximum width in pixels. */
  maxWidth: number;
  /**
   * When true, a positive mouse movement (right/down) decreases the width.
   * Use this for panels whose handle is on their left edge (e.g. a right-side panel).
   */
  invert?: boolean;
}

export function useResizablePanel({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  invert = false,
}: UseResizablePanelOptions) {
  const [width, setWidth] = useState(() => {
    if (typeof window === "undefined") return defaultWidth;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved !== null) {
        const parsed = Number(saved);
        if (Number.isFinite(parsed)) return clamp(parsed, minWidth, maxWidth);
      }
    } catch {
      // localStorage unavailable
    }
    return defaultWidth;
  });

  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);

  // Persist width changes to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(width));
    } catch {
      // localStorage unavailable
    }
  }, [storageKey, width]);

  // Re-clamp when bounds change (e.g. on window resize)
  useEffect(() => {
    setWidth((prev) => clamp(prev, minWidth, maxWidth));
  }, [minWidth, maxWidth]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;

    const onMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = invert ? -e.movementX : e.movementX;
      setWidth((prev) => clamp(prev + delta, minWidth, maxWidth));
    };

    const onMouseUp = () => {
      draggingRef.current = false;
      setDragging(false);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragging, invert, minWidth, maxWidth]);

  return {
    /** Current panel width in pixels. */
    width,
    /** Whether the user is currently dragging the handle. */
    dragging,
    /** Value to set as a CSS custom property, e.g. `style={{ "--panel-width": `${width}px` }}`. */
    cssVarValue: `${width}px`,
    /** Props to spread onto the resize handle element. */
    handleProps: {
      onMouseDown,
      role: "separator" as const,
      "aria-orientation": "vertical" as const,
      "aria-valuenow": width,
      "aria-label": "Resize panel",
    },
  };
}