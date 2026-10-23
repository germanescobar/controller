import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserScreenshot } from "../../shared/preview-browser.js";
import { diagnosticUrl } from "../../shared/preview-diagnostics.js";

const MAX_PNG_BYTES = 12 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
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
  return {
    path: filePath, width, height, url: diagnosticUrl(input.url),
    fullPage: input.fullPage, commandId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}
