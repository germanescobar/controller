import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserScreenshot } from "../../shared/preview-browser.js";
import { diagnosticUrl } from "../../shared/preview-diagnostics.js";

const MAX_PNG_BYTES = 12 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const artifacts = new Map<string, { png: Buffer; expires: number }>();
const TTL = 24 * 60 * 60 * 1000;

/*
 * URLs are bearer capabilities: the random command ID grants access to this
 * capture only. Pane/session segments cannot be substituted to read another
 * capture. No filesystem reads occur, and restarting clears the registry.
 */
export function readBrowserScreenshot(url: string): Buffer | undefined {
  const artifact = artifacts.get(url);
  if (!artifact) return undefined;
  if (artifact.expires <= Date.now()) {
    artifacts.delete(url);
    return undefined;
  }
  return artifact.png;
}

let evidenceRoot: Promise<string> | null = null;

export async function saveBrowserScreenshot(input: {
  data: string;
  paneKey: string;
  url: string;
  fullPage: boolean;
  sessionId?: string;
}): Promise<BrowserScreenshot> {
  if (input.data.length > Math.ceil(MAX_PNG_BYTES * 4 / 3) + 8) {
    throw new Error("Screenshot exceeds the 12 MiB limit");
  }
  const png = Buffer.from(input.data, "base64");
  if (png.length < 24 || png.length > MAX_PNG_BYTES || !png.subarray(0, 8).equals(PNG_SIGNATURE)
    || png.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Invalid or oversized PNG screenshot");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192) {
    throw new Error("Screenshot dimensions exceed the 8192 pixel limit");
  }
  const commandId = randomUUID();
  const paneHash = createHash("sha256").update(input.paneKey).digest("hex").slice(0, 16);
  evidenceRoot ??= mkdtemp(path.join(os.tmpdir(), "controller-browser-evidence-"));
  const dir = path.join(await evidenceRoot, paneHash);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `${commandId}.png`);
  await writeFile(filePath, png, { flag: "wx", mode: 0o600 });
  for (const [key, artifact] of artifacts) {
    if (artifact.expires <= Date.now()) artifacts.delete(key);
  }
  // Bound retained image memory even during a long-running server session.
  while (artifacts.size >= 32 || [...artifacts.values()].reduce((bytes, artifact) => bytes + artifact.png.length, 0) + png.length > 48 * 1024 * 1024) {
    const oldest = artifacts.keys().next().value;
    if (oldest) artifacts.delete(oldest);
  }
  const imageUrl = `/api/browser/artifacts/${paneHash}/${input.sessionId ?? "pane"}/${commandId}.png`;
  artifacts.set(imageUrl, { png, expires: Date.now() + TTL });
  return {
    imageUrl,
    path: filePath, width, height, url: diagnosticUrl(input.url),
    fullPage: input.fullPage, commandId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}
