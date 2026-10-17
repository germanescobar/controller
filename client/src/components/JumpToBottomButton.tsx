import { useEffect, useState, type RefObject } from "react";
import { ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Distance-from-bottom (in pixels) below which the chat is considered
 * "stuck to the bottom" — matches the threshold used by the SessionView's
 * `stickToBottomRef` (see handleScroll in client/src/pages/SessionView.tsx)
 * so the button's visibility is exactly the inverse of the auto-scroll
 * behavior: while the existing `stickToBottomRef.current` keeps the
 * timeline pinned to the bottom for new events, the button stays hidden;
 * as soon as the user scrolls up past this band the existing
 * stick-to-bottom logic disengages and this button appears.
 */
export const JUMP_TO_BOTTOM_THRESHOLD_PX = 80;

interface JumpToBottomButtonProps {
  /**
   * The chat scroll container whose `scrollTop` / `scrollHeight` /
   * `clientHeight` we measure to decide whether to show the button.
   * The SessionView passes its `scrollContainerRef` here.
   */
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  /**
   * Called when the user clicks the button. The SessionView wires this
   * to set `stickToBottomRef.current = true` and smoothly scroll the
   * bottom sentinel into view, which re-engages the existing
   * auto-scroll behavior so subsequent new events keep the chat pinned
   * to the bottom (see the `[events, streamItems]` effect in
   * SessionView).
   */
  onScrollToBottom: () => void;
  /**
   * Pixel threshold below which the button is hidden. Defaults to
   * {@link JUMP_TO_BOTTOM_THRESHOLD_PX} (80px) — kept in sync with
   * SessionView's stick-to-bottom band so the two behaviors are exact
   * inverses.
   */
  threshold?: number;
}

/**
 * Floating "jump to bottom" button for the conversation scroll area.
 *
 * The button is absolutely positioned inside the chat scroll container
 * (the parent must add `relative` for the absolute positioning to
 * anchor against it instead of the page). When the user is more than
 * `threshold` pixels away from the bottom it fades in at
 * bottom-right; when the user is back within the band it fades out
 * and becomes inert (`pointer-events-none`) so it can't intercept
 * clicks meant for the message bubbles underneath.
 *
 * Intentionally chat-side only: the button is rendered inside the
 * chat scroll container itself, not in the outer panel layout, so the
 * terminal / files / PR / preview panes (which sit to the right of
 * the chat) are unaffected.
 */
export function JumpToBottomButton({
  scrollContainerRef,
  onScrollToBottom,
  threshold = JUMP_TO_BOTTOM_THRESHOLD_PX,
}: JumpToBottomButtonProps) {
  // `visible` flips true whenever the user scrolls past the threshold
  // away from the bottom. We start as `false` because the chat starts
  // pinned to the bottom (SessionView's `stickToBottomRef` initializes
  // to `true`), so a freshly-mounted session should *not* flash the
  // button during the first paint.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    /**
     * Recompute the distance from the bottom and toggle visibility.
     *
     * `scrollHeight - scrollTop - clientHeight` is the standard
     * formula for "how many pixels are hidden below the viewport".
     * Sub-pixel rounding can make the value wobble between 0 and 1
     * even when the chat is fully scrolled, so we treat `0` as
     * "pinned" too — the user is at the bottom whenever the value
     * drops below the threshold.
     *
     * The function is stable (no React state reads) so we can attach
     * the same instance to `scroll` and `resize` without re-binding.
     */
    const update = () => {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      setVisible(distanceFromBottom > threshold);
    };

    // Run once on mount so a container that opens already scrolled
    // up (e.g. the user navigates back to a long transcript) lights
    // the button up immediately, without waiting for the first
    // scroll event.
    update();

    container.addEventListener("scroll", update, { passive: true });
    // Resize can change `clientHeight` (e.g. the viewport-height
    // panel resize handle) without firing a scroll event, which
    // would leave the button stuck in the wrong state.
    window.addEventListener("resize", update);

    return () => {
      container.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [scrollContainerRef, threshold]);

  return (
    <div
      className={cn(
        "pointer-events-none absolute bottom-4 right-4 transition-all duration-200",
        visible
          ? "translate-y-0 opacity-100"
          : "translate-y-2 opacity-0",
      )}
      data-testid="jump-to-bottom-wrapper"
      data-visible={visible ? "true" : "false"}
    >
      <button
        type="button"
        aria-label="Jump to bottom"
        title="Jump to bottom"
        data-testid="jump-to-bottom"
        onClick={onScrollToBottom}
        // The wrapper already owns the pointer-events toggle; we keep
        // the button itself always interactive so a future host that
        // drops the wrapper (e.g. a toolbar variant) still works.
        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background/90 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ArrowDown className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}