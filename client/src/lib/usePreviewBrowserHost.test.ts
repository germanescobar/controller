import test from "node:test";
import assert from "node:assert/strict";
import { handleClick, retryAction, waitForViewport, type PreviewWebview } from "./usePreviewBrowserHost.ts";

test("click retries until a delayed target becomes actionable", async () => {
  Object.defineProperty(globalThis, "window", { value: { setTimeout }, configurable: true });
  let attempts = 0;
  const events: string[] = [];
  const webview = {
    executeJavaScript: async () => {
      attempts += 1;
      return attempts < 3
        ? { ok: false, engine: "css", error: "no element matches" }
        : { ok: true, engine: "css", x: 24, y: 42 };
    },
    sendInputEvent: async (event: { type: string }) => { events.push(event.type); },
  } as unknown as PreviewWebview;
  const result = await handleClick(webview, "#late", {}, 500);
  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
  assert.deepEqual(events, ["mouseMove", "mouseDown", "mouseUp"]);
});

test("action timeout includes the last actionable failure", async () => {
  Object.defineProperty(globalThis, "window", { value: { setTimeout }, configurable: true });
  const webview = {
    executeJavaScript: async () => ({ ok: false, engine: "css", error: "obscured" }),
  } as unknown as PreviewWebview;
  const result = await retryAction(webview, () => "", 100);
  assert.equal(result?.ok, false);
  assert.match(result?.error ?? "", /timed out after 100ms.*obscured/);
});

test("viewport command waits for the guest resize", async () => {
  let reads = 0;
  const webview = {
    executeJavaScript: async () => ++reads < 3
      ? { width: 1280, height: 800 } : { width: 390, height: 844 },
  } as PreviewWebview;
  await waitForViewport(webview, { width: 390, height: 844 });
  assert.equal(reads, 3);
});

test("viewport command repaints a parked guest and restores its position", async () => {
  const style = { left: "-100000px", top: "0px", zIndex: "-1" };
  const webview = {
    style,
    executeJavaScript: async () => style.left === "0px"
      ? { width: 390, height: 844 } : { width: 1280, height: 828 },
  } as PreviewWebview;
  await waitForViewport(webview, { width: 390, height: 844 });
  assert.deepEqual(style, { left: "-100000px", top: "0px", zIndex: "-1" });
});
