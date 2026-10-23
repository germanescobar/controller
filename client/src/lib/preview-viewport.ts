import type { BrowserViewport } from "../../../shared/preview-browser.js";

export type ViewportPreset = "default" | "desktop" | "mobile";

export class PreviewViewportStore {
  private viewports = new Map<string, BrowserViewport>();

  get(key: string): BrowserViewport | null {
    return this.viewports.get(key) ?? null;
  }

  set(key: string, preset: ViewportPreset): BrowserViewport | null {
    const viewport = preset === "desktop" ? { width: 1280, height: 800 }
      : preset === "mobile" ? { width: 390, height: 844 } : null;
    if (viewport) this.viewports.set(key, viewport);
    else this.viewports.delete(key);
    return viewport;
  }
}
