import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { JumpToBottomButton } from "../JumpToBottomButton.tsx";

test("jump button follows scroll distance, stays keyboard inert when hidden, and handles clicks", async () => {
  const browserWindow = new Window({ url: "http://localhost" });
  Object.assign(globalThis, {
    window: browserWindow,
    document: browserWindow.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const scroller = browserWindow.document.createElement("div");
  Object.defineProperties(scroller, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 200 },
  });
  scroller.scrollTop = 800;
  const host = browserWindow.document.createElement("div");
  browserWindow.document.body.append(scroller, host);
  // Happy DOM uses its own DOM type declarations; these elements implement
  // the browser DOM interfaces expected by React at runtime.
  const root = createRoot(host as unknown as HTMLDivElement);
  let clicks = 0;

  try {
    await act(async () => {
      root.render(
        <JumpToBottomButton
          scrollContainerRef={{ current: scroller as unknown as HTMLDivElement }}
          onScrollToBottom={() => {
            clicks += 1;
            scroller.scrollTop = 800;
            scroller.dispatchEvent(new browserWindow.Event("scroll"));
          }}
        />,
      );
    });

    const wrapper = host.querySelector('[data-testid="jump-to-bottom-wrapper"]');
    const button = host.querySelector('button[data-testid="jump-to-bottom"]');
    assert.ok(wrapper);
    assert.ok(button);
    assert.equal(button.getAttribute("aria-label"), "Jump to bottom");
    assert.equal(wrapper.getAttribute("data-visible"), "false");
    assert.equal(wrapper.getAttribute("aria-hidden"), "true");
    assert.equal(button.getAttribute("tabindex"), "-1");
    assert.ok(wrapper.classList.contains("pointer-events-none"));

    await act(async () => {
      scroller.scrollTop = 719; // 81 px from the bottom
      scroller.dispatchEvent(new browserWindow.Event("scroll"));
    });
    assert.equal(wrapper.getAttribute("data-visible"), "true");
    assert.equal(wrapper.getAttribute("aria-hidden"), "false");
    assert.equal(button.getAttribute("tabindex"), "0");
    assert.ok(wrapper.classList.contains("pointer-events-auto"));

    await act(async () => {
      button.dispatchEvent(new browserWindow.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(clicks, 1);
    assert.equal(wrapper.getAttribute("data-visible"), "false");
    assert.equal(button.getAttribute("tabindex"), "-1");

    await act(async () => {
      scroller.scrollTop = 720; // exactly 80 px from the bottom
      scroller.dispatchEvent(new browserWindow.Event("scroll"));
    });
    assert.equal(wrapper.getAttribute("data-visible"), "false");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    scroller.remove();
    await browserWindow.happyDOM.close();
  }
});
