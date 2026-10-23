import type { BrowserDiagnostic } from "./preview-browser.js";

export const MAX_DIAGNOSTICS = 50;

/** Keep URLs useful for locating failures without exposing credentials or query tokens. */
export function diagnosticUrl(input: string): string {
  try {
    const url = new URL(input);
    if (!["http:", "https:", "file:"].includes(url.protocol)) return "(other URL)";
    return `${url.protocol === "file:" ? "file://" : url.origin}${url.pathname}`.slice(0, 1000);
  } catch {
    return "(unknown URL)";
  }
}

export function diagnosticMessage(input: string): string {
  return input
    .replace(/(?:https?|file):\/\/[^\s"'<>]+/gi, (url) => diagnosticUrl(url))
    .replace(/\b(authorization|proxy-authorization)\s*[:=]\s*(?:Bearer|Basic)\s+[^\s,;]+/gi, "$1: [redacted]")
    .replace(/\b(authorization|proxy-authorization)\s*[:=]\s*[^\s,;]+/gi, "$1: [redacted]")
    .replace(/\b(cookie|set-cookie)\s*[:=][^\r\n]*/gi, "$1: [redacted]")
    .replace(/\b(?:request|response)\s+body\s*[:=][^\r\n]*/gi, "body: [redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .slice(0, 500);
}

export class PreviewDiagnosticBuffer {
  private entries: BrowserDiagnostic[] = [];

  add(entry: BrowserDiagnostic): void {
    this.entries.push({ ...entry, url: diagnosticUrl(entry.url), message: diagnosticMessage(entry.message) });
    if (this.entries.length > MAX_DIAGNOSTICS) this.entries.shift();
  }

  clear(): void { this.entries = []; }

  recent(limit: number): BrowserDiagnostic[] {
    return this.entries.slice(-Math.min(Math.max(limit, 1), MAX_DIAGNOSTICS));
  }
}
