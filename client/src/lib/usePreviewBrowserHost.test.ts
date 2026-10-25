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

test("background click keeps the guest hidden while sending native input", async () => {
  const style = { left: "-100000px", top: "0px", zIndex: "-1", clipPath: "", opacity: "0", pointerEvents: "none" };
  const webview = {
    style,
    executeJavaScript: async () => ({ ok: true, engine: "css", x: 24, y: 42 }),
    sendInputEvent: async () => {
      assert.equal(style.left, "0px");
      assert.equal(style.clipPath, "inset(100%)");
      assert.equal(style.opacity, "0");
      assert.equal(style.pointerEvents, "none");
    },
  } as unknown as PreviewWebview;

  assert.equal((await handleClick(webview, "#target", {}, 500)).ok, true);
  assert.deepEqual(style, { left: "-100000px", top: "0px", zIndex: "-1", clipPath: "", opacity: "0", pointerEvents: "none" });
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
  } as unknown as PreviewWebview;
  await waitForViewport(webview, { width: 390, height: 844 });
  assert.equal(reads, 3);
});

test("viewport command repaints a parked guest without exposing it over chrome", async () => {
  const style = { left: "-100000px", top: "0px", zIndex: "-1", clipPath: "", opacity: "0", pointerEvents: "none" };
  const webview = {
    style,
    executeJavaScript: async () => {
      if (style.left === "0px") {
        assert.equal(style.clipPath, "inset(100%)");
        assert.equal(style.opacity, "0");
        assert.equal(style.pointerEvents, "none");
        return { width: 390, height: 844 };
      }
      return { width: 1280, height: 828 };
    },
  } as unknown as PreviewWebview;
  await waitForViewport(webview, { width: 390, height: 844 });
  assert.deepEqual(style, { left: "-100000px", top: "0px", zIndex: "-1", clipPath: "", opacity: "0", pointerEvents: "none" });
});
