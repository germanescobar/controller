import test from "node:test";
import assert from "node:assert/strict";
import { capturePreviewScreenshot, type CaptureWebview } from "./preview-screenshot.js";

test("viewport capture returns PNG data without resizing the guest", async () => {
  const style = { width: "390px", height: "844px" };
  const webview: CaptureWebview = {
    style,
    getURL: () => "http://localhost:3000/",
    executeJavaScript: async () => { throw new Error("unexpected guest script"); },
    capturePage: async () => ({ getSize: () => ({ width: 390, height: 844 }), toPNG: () => Uint8Array.from([1, 2, 3]) }),
  };
  const result = await capturePreviewScreenshot(webview, false);
  assert.deepEqual(result, { ok: true, url: "http://localhost:3000/", screenshotData: "AQID", fullPage: false });
  assert.deepEqual(style, { width: "390px", height: "844px" });
});

test("full-page capture waits for resize and restores viewport after capture", async () => {
  const style = { width: "390px", height: "844px" };
  let captures = 0;
  const webview: CaptureWebview = {
    style,
    getURL: () => "http://localhost:3000/",
    executeJavaScript: async (code) => code.includes("scrollWidth")
      ? { width: 600, height: 1200 } : { width: Number.parseInt(style.width), height: Number.parseInt(style.height) },
    capturePage: async () => {
      captures++;
      assert.deepEqual(style, { width: "600px", height: "1200px" });
      return { getSize: () => ({ width: 600, height: 1200 }), toPNG: () => Uint8Array.from([1]) };
    },
  };
  const result = await capturePreviewScreenshot(webview, true);
  assert.equal(result.ok, true);
  assert.equal(captures, 1);
  assert.deepEqual(style, { width: "390px", height: "844px" });
});

test("full-page capture rejects oversized pages without resizing", async () => {
  const style = { width: "390px", height: "844px" };
  const webview: CaptureWebview = {
    style,
    getURL: () => "http://localhost:3000/",
    executeJavaScript: async () => ({ width: 9000, height: 1200 }),
    capturePage: async () => { throw new Error("unexpected capture"); },
  };
  const result = await capturePreviewScreenshot(webview, true);
  assert.equal(result.ok, false);
  assert.deepEqual(style, { width: "390px", height: "844px" });
});
