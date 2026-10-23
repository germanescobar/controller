import type { BrowserViewport } from "../../../shared/preview-browser.js";

export interface CaptureWebview {
  style: Pick<CSSStyleDeclaration, "width" | "height">;
  getURL: () => string;
  executeJavaScript: (code: string) => Promise<unknown>;
  capturePage: () => Promise<{ toPNG: () => Uint8Array; getSize: () => BrowserViewport }>;
}

export type CaptureResult =
  | { ok: true; url: string; screenshotData: string; fullPage: boolean }
  | { ok: false; error: string };

/** Capture the guest viewport, temporarily expanding it for full-page evidence. */
export async function capturePreviewScreenshot(webview: CaptureWebview, fullPage: boolean): Promise<CaptureResult> {
  const oldWidth = webview.style.width;
  const oldHeight = webview.style.height;
  try {
    if (fullPage) {
      const size = await webview.executeJavaScript(`({ width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0), height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0) })`) as BrowserViewport;
      if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width < 1 || size.height < 1 || size.width > 8192 || size.height > 8192 || size.width * size.height > 16_000_000) {
        return { ok: false, error: "Full page exceeds the 8192-pixel / 16-megapixel capture limit" };
      }
      webview.style.width = `${Math.ceil(size.width)}px`;
      webview.style.height = `${Math.ceil(size.height)}px`;
      const deadline = Date.now() + 2_000;
      let ready = false;
      while (Date.now() < deadline) {
        const actual = await webview.executeJavaScript(`({ width: window.innerWidth, height: window.innerHeight })`) as BrowserViewport;
        if (actual.width >= Math.ceil(size.width) && actual.height >= Math.ceil(size.height)) {
          ready = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      if (!ready) return { ok: false, error: "Preview did not reach the full-page capture size within 2 seconds" };
    }
    const image = await webview.capturePage();
    const size = image.getSize();
    if (!size.width || !size.height) return { ok: false, error: "Screenshot capture returned an empty image" };
    const bytes = image.toPNG();
    if (bytes.byteLength > 12 * 1024 * 1024) return { ok: false, error: "Screenshot exceeds the 12 MiB limit" };
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { ok: true, url: webview.getURL(), screenshotData: btoa(binary), fullPage };
  } finally {
    webview.style.width = oldWidth;
    webview.style.height = oldHeight;
  }
}
