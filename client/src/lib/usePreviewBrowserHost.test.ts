import test from "node:test";
import assert from "node:assert/strict";
import { handleClick, retryAction, type PreviewWebview } from "./usePreviewBrowserHost.ts";

test("click retries until a delayed target becomes actionable", async () => {
  Object.defineProperty(globalThis, "window", { value: { setTimeout }, configurable: true });
  let attempts = 0;
  const webview = {
    executeJavaScript: async () => {
      attempts += 1;
      return attempts < 3
        ? { ok: false, engine: "css", error: "no element matches" }
        : { ok: true, engine: "css" };
    },
  } as unknown as PreviewWebview;
  const result = await handleClick(webview, "#late", {}, 500);
  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
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
