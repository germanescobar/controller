/*
 * Wiring that lets agents reach the `integrations` gateway CLI (issue #130).
 *
 * Mirrors browser-cli.ts: on startup we copy the CLI to a stable absolute path
 * (`<orchestratorHome>/bin/integrations`) and publish the server URL to a
 * runtime file the CLI reads, because sanitized/login shells drop injected env
 * vars and PATH entries. The preamble/skill invoke the CLI by that absolute
 * path. `CONTROLLER_SERVER_URL` is still injected as a best-effort fast path.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orchestratorHome } from "./paths.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function integrationCliSourcePath(): string {
  const dir = path
    .resolve(moduleDir, "../../cli")
    .replace(/app\.asar(?!\.unpacked)/, "app.asar.unpacked");
  return path.join(dir, "integrations");
}

/** Stable absolute path the CLI is installed to (outside any app bundle). */
export function integrationCliInstalledPath(): string {
  return path.join(orchestratorHome(), "bin", "integrations");
}

function integrationRuntimeFile(): string {
  return path.join(orchestratorHome(), "integrations-runtime.json");
}

function serverPort(): number {
  const parsed = Number(process.env.PORT);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 3100;
}

function serverUrl(): string {
  return `http://localhost:${serverPort()}`;
}

/** Copy the CLI to its stable install path and publish the server URL. Idempotent. */
export async function installIntegrationCli(): Promise<void> {
  const installed = integrationCliInstalledPath();
  await fs.mkdir(path.dirname(installed), { recursive: true });
  await fs.copyFile(integrationCliSourcePath(), installed);
  await fs.chmod(installed, 0o755);
  await fs.writeFile(
    integrationRuntimeFile(),
    `${JSON.stringify({ serverUrl: serverUrl() }, null, 2)}\n`,
    "utf-8"
  );
}
