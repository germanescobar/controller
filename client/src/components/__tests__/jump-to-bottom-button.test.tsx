import test from "node:test";
import assert from "node:assert/strict";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JumpToBottomButton } from "../JumpToBottomButton.tsx";

function render(props: {
  onScrollToBottom?: () => void;
  threshold?: number;
} = {}) {
  // A real ref object — `renderToStaticMarkup` never calls the effect,
  // so the ref can stay empty; the component just reads `.current` in
  // `useEffect` on the client. On the server we don't render past
  // the initial markup so an empty ref is fine.
  const scrollContainerRef = createRef<HTMLDivElement | null>();
  return renderToStaticMarkup(
    <JumpToBottomButton
      scrollContainerRef={scrollContainerRef}
      onScrollToBottom={props.onScrollToBottom ?? (() => {})}
      threshold={props.threshold}
    />,
  );
}

test("jump-to-bottom button exposes accessible name and title", () => {
  // The button must be discoverable by assistive tech and by
  // mouse hover. The `aria-label` covers screen readers; `title=`
  // covers the browser's native tooltip.
  const html = render();
  assert.match(html, /aria-label="Jump to bottom"/);
  assert.match(html, /title="Jump to bottom"/);
  // Stable test hook for the SessionView's test pass.
  assert.match(html, /data-testid="jump-to-bottom"/);
});

test("the wrapper is absolutely positioned at bottom-right of the chat scroll area", () => {
  // The button is meant to anchor against the chat scroll container
  // (which the SessionView renders with `position: relative`), not
  // the page or the outer panel layout. The wrapper must carry
  // `absolute bottom-4 right-4` so it sits at the bottom-right
  // corner of the chat — and the lucide-react ArrowDown icon must
  // be the visual marker inside the button.
  const html = render();
  assert.match(html, /absolute bottom-4 right-4/);
  assert.match(html, /lucide-arrow-down/);
  assert.match(html, /rounded-full/);
});

test("the initial markup starts in the hidden state", () => {
  // The component initializes `visible` to `false` (a freshly
  // mounted session is always pinned to the bottom — see the
  // SessionView's `stickToBottomRef` initial value), so the first
  // server-rendered markup must carry the "hidden" classes. We
  // check the negative-state classes directly instead of testing
  // the state machine, which would need a real DOM and jsdom-style
  // ref plumbing. The runtime effect that toggles visibility lives
  // in the existing SessionView integration.
  const html = render();
  // Wrapper must disable pointer events so the user can still
  // click the message bubble underneath.
  assert.match(html, /pointer-events-none/);
  // Hidden = translated down + transparent.
  assert.match(html, /translate-y-2/);
  assert.match(html, /opacity-0/);
  // ...and the opposite end of the toggle must NOT be present yet.
  assert.doesNotMatch(html, /translate-y-0/);
  assert.doesNotMatch(html, /opacity-100/);
});