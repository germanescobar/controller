import type { BrowserViewport } from "../../../shared/preview-browser.js";
import type { PreviewCaptureResult } from "../../../shared/controller.js";
import { withPaintablePreview } from "./paintable-preview.js";

export interface CaptureWebview {
  style: Pick<CSSStyleDeclaration, "width" | "height" | "left" | "top" | "zIndex" | "clipPath" | "opacity" | "pointerEvents">;
  getURL: () => string;
  executeJavaScript: (code: string) => Promise<unknown>;
  capturePage: () => Promise<PreviewCaptureResult>;
}

export type CaptureResult =
  | { ok: true; url: string; screenshotData: string; fullPage: boolean }
  | { ok: false; error: string };

interface PageMetrics extends BrowserViewport {
  viewportWidth: number;
  viewportHeight: number;
  scrollY: number;
}

const MAX_DIMENSION = 8192;
const MAX_PIXELS = 16_000_000;
const MAX_PNG_BYTES = 12 * 1024 * 1024;

/** Capture a guest, scrolling and stitching when its document exceeds one viewport. */
export async function capturePreviewScreenshot(webview: CaptureWebview, fullPage: boolean): Promise<CaptureResult> {
  const style = webview.style;
  const previous = { width: style.width, height: style.height, left: style.left,
    top: style.top, zIndex: style.zIndex, clipPath: style.clipPath };
  let previousBackground: string | null = null;
  let originalScrollY: number | null = null;
  return withPaintablePreview(style, async () => {
    try {
      // Chromium does not capture a guest parked outside the paintable area.
      if (Number.parseFloat(previous.left) < -50_000) await paintDelay();
      const metrics = fullPage ? await pageMetrics(webview) : null;
      if (metrics) {
        if (!validMetrics(metrics)) return { ok: false, error: "Could not measure the preview page" };
        if (metrics.width > MAX_DIMENSION || metrics.height > MAX_DIMENSION ||
          metrics.width * metrics.height > MAX_PIXELS) {
          return { ok: false, error: "Full page exceeds the 8192-pixel / 16-megapixel capture limit" };
        }
        if (metrics.width > metrics.viewportWidth + 1) {
          return { ok: false, error: "Full-page capture cannot cover horizontal overflow; increase the viewport width" };
        }
        originalScrollY = metrics.scrollY;
      }

      previousBackground = await webview.executeJavaScript(`(() => {
        const root = document.documentElement;
        const color = getComputedStyle(root).backgroundColor;
        if (color !== 'transparent' && !/^rgba?\\([^)]*,\\s*0(?:\\.0+)?\\)$/.test(color)) return null;
        const previous = root.style.backgroundColor;
        root.style.backgroundColor = '#fff';
        return previous;
      })()`) as string | null;
      if (previousBackground !== null) await paintDelay();

      const image = metrics && metrics.height > metrics.viewportHeight + 1
        ? await captureFullPage(webview, metrics)
        : await webview.capturePage();
      if (!image.ok) return image;
      if (image.data.length > Math.ceil(MAX_PNG_BYTES * 4 / 3) + 8) {
        return { ok: false, error: "Screenshot exceeds the 12 MiB limit" };
      }
      return { ok: true, url: webview.getURL(), screenshotData: image.data, fullPage };
    } finally {
      try {
        if (originalScrollY !== null) await scrollTo(webview, originalScrollY);
      } finally {
        try {
          if (previousBackground !== null) {
            await webview.executeJavaScript(`document.documentElement.style.backgroundColor = ${JSON.stringify(previousBackground)}`);
          }
        } finally {
          Object.assign(style, previous);
        }
      }
    }
  });
}

async function captureFullPage(webview: CaptureWebview, metrics: PageMetrics): Promise<PreviewCaptureResult> {
  let actualY = await scrollTo(webview, 0);
  const first = await webview.capturePage();
  if (!first.ok) return first;
  const scale = first.width / metrics.viewportWidth;
  const tileHeight = first.height / scale;
  const width = first.width;
  const height = Math.ceil(metrics.height * scale);
  if (!Number.isFinite(scale) || scale <= 0 || tileHeight <= 0 ||
    width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    return { ok: false, error: "Full-page screenshot exceeds the 8192-pixel / 16-megapixel output limit" };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return { ok: false, error: "Canvas capture is unavailable" };

  let tile = first;
  for (let destinationY = 0; destinationY < metrics.height; destinationY += tileHeight) {
    if (destinationY > 0) {
      const requestedY = Math.min(destinationY, Math.max(0, metrics.height - metrics.viewportHeight));
      actualY = await scrollTo(webview, requestedY);
      tile = await webview.capturePage();
      if (!tile.ok) return tile;
      if (tile.width !== width || tile.height !== first.height) {
        return { ok: false, error: "Preview viewport changed during full-page capture" };
      }
    }
    const sourceY = Math.round((destinationY - actualY) * scale);
    const copyHeight = Math.min(Math.ceil((metrics.height - destinationY) * scale), tile.height - sourceY);
    if (sourceY < 0 || copyHeight <= 0) {
      return { ok: false, error: "Preview did not scroll to the requested capture position" };
    }
    const image = new Image();
    image.src = `data:image/png;base64,${tile.data}`;
    await image.decode();
    context.drawImage(image, 0, sourceY, width, copyHeight,
      0, Math.round(destinationY * scale), width, copyHeight);
  }
  return { ok: true, data: canvas.toDataURL("image/png").split(",", 2)[1], width, height };
}

async function pageMetrics(webview: CaptureWebview): Promise<PageMetrics> {
  return await webview.executeJavaScript(`({
    width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollY: window.scrollY
  })`) as PageMetrics;
}

function validMetrics(metrics: PageMetrics): boolean {
  return [metrics.width, metrics.height, metrics.viewportWidth, metrics.viewportHeight, metrics.scrollY]
    .every(Number.isFinite) && metrics.width >= 1 && metrics.height >= 1 &&
    metrics.viewportWidth >= 1 && metrics.viewportHeight >= 1;
}

async function scrollTo(webview: CaptureWebview, y: number): Promise<number> {
  const actual = await webview.executeJavaScript(`(() => {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    window.scrollTo(0, ${JSON.stringify(y)});
    root.style.scrollBehavior = previous;
    return window.scrollY;
  })()`) as number;
  await paintDelay();
  return actual;
}

function paintDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}
