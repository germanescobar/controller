import test from "node:test";
import assert from "node:assert/strict";
import { capturePreviewScreenshot, type CaptureWebview } from "./preview-screenshot.js";

test("viewport capture returns PNG data without resizing the guest", async () => {
  const style = { width: "390px", height: "844px", left: "0px", top: "0px", zIndex: "20", clipPath: "", opacity: "1", pointerEvents: "auto" };
  const webview: CaptureWebview = {
    style,
    getURL: () => "http://localhost:3000/",
    executeJavaScript: async (code) => {
      assert.match(code, /getComputedStyle/);
      return null;
    },
    capturePage: async () => ({ ok: true, width: 390, height: 844, data: "AQID" }),
  };
  const result = await capturePreviewScreenshot(webview, false);
  assert.deepEqual(result, { ok: true, url: "http://localhost:3000/", screenshotData: "AQID", fullPage: false });
  assert.equal(style.width, "390px");
  assert.equal(style.height, "844px");
});

test("full-page capture stitches viewport tiles and restores scroll position", async () => {
  const style = { width: "390px", height: "844px", left: "0px", top: "0px", zIndex: "20", clipPath: "", opacity: "1", pointerEvents: "auto" };
  let scrollY = 200;
  let captures = 0;
  const draws: number[][] = [];
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ drawImage: (_image: object, ...args: number[]) => draws.push(args) }),
    toDataURL: () => "data:image/png;base64,AQ==",
  };
  Object.defineProperty(globalThis, "document", {
    value: { createElement: () => canvas }, configurable: true,
  });
  Object.defineProperty(globalThis, "Image", {
    value: class { src = ""; async decode() {} }, configurable: true,
  });
  const webview: CaptureWebview = {
    style,
    getURL: () => "http://localhost:3000/",
    executeJavaScript: async (code) => {
      if (code.includes("scrollWidth")) return { width: 390, height: 1700,
        viewportWidth: 390, viewportHeight: 844, scrollY };
      if (code.includes("getComputedStyle")) return null;
      const target = Number(/window\.scrollTo\(0, (\d+)\)/.exec(code)?.[1]);
      scrollY = Math.min(target, 856);
      return scrollY;
    },
    capturePage: async () => {
      captures++;
      return { ok: true, width: 780, height: 1688, data: "AQ==" };
    },
  };
  const result = await capturePreviewScreenshot(webview, true);
  assert.equal(result.ok, true);
  assert.equal(captures, 3);
  assert.equal(draws.length, 3);
  assert.equal(canvas.width, 780);
  assert.equal(canvas.height, 3400);
  assert.equal(scrollY, 200);
  assert.equal(style.width, "390px");
  assert.equal(style.height, "844px");
});

test("full-page capture rejects oversized pages without resizing", async () => {
  const style = { width: "390px", height: "844px", left: "0px", top: "0px", zIndex: "20", clipPath: "", opacity: "1", pointerEvents: "auto" };
  const webview: CaptureWebview = {
    style,
    getURL: () => "http://localhost:3000/",
    executeJavaScript: async () => ({ width: 9000, height: 1200,
      viewportWidth: 390, viewportHeight: 844, scrollY: 0 }),
    capturePage: async () => { throw new Error("unexpected capture"); },
  };
  const result = await capturePreviewScreenshot(webview, true);
  assert.equal(result.ok, false);
  assert.equal(style.width, "390px");
  assert.equal(style.height, "844px");
});

test("parked guest is moved into the paintable area only for capture", async () => {
  const style = { width: "390px", height: "844px", left: "-100000px", top: "0px", zIndex: "-1", clipPath: "", opacity: "1", pointerEvents: "auto" };
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: (callback: FrameRequestCallback) => { callback(0); return 1; }, configurable: true,
  });
  const webview: CaptureWebview = {
    style,
    getURL: () => "http://localhost:3000/",
    executeJavaScript: async (code) => {
      assert.match(code, /getComputedStyle/);
      return null;
    },
    capturePage: async () => {
      assert.equal(style.left, "0px");
      assert.equal(style.zIndex, "20");
      assert.equal(style.clipPath, "inset(100%)");
      assert.equal(style.opacity, "0");
      assert.equal(style.pointerEvents, "none");
      return { ok: true, width: 390, height: 844, data: "AQ==" };
    },
  };
  assert.equal((await capturePreviewScreenshot(webview, false)).ok, true);
  assert.equal(style.left, "-100000px");
  assert.equal(style.zIndex, "-1");
});

test("transparent page background is restored after capture", async () => {
  const style = { width: "390px", height: "844px", left: "0px", top: "0px", zIndex: "20", clipPath: "", opacity: "1", pointerEvents: "auto" };
  let restored = false;
  const webview: CaptureWebview = {
    style,
    getURL: () => "http://localhost:3000/",
    executeJavaScript: async (code) => {
      if (code.includes("getComputedStyle")) return "";
      assert.match(code, /style\.backgroundColor = ""/);
      restored = true;
      return null;
    },
    capturePage: async () => {
      assert.equal(restored, false);
      return { ok: true, width: 390, height: 844, data: "AQ==" };
    },
  };
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: (callback: FrameRequestCallback) => { callback(0); return 1; }, configurable: true,
  });
  assert.equal((await capturePreviewScreenshot(webview, false)).ok, true);
  assert.equal(restored, true);
});
