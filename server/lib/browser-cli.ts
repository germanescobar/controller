/*
 * Wiring that lets agents reach the preview browser CLI (issue #109).
 *
 * Agents run commands in sanitized/login shells (Codex strips non-core env
 * vars; zsh `-l` rebuilds PATH), so neither an injected PATH entry nor custom
 * env vars reliably reach the agent's shell. The robust handle is therefore a
 * stable **absolute path**: on startup we copy the CLI to
 * `<orchestratorHome>/bin/controller-browser` and the preamble/skill invoke it
 * by that path. The server URL is published to a runtime file the CLI reads,
 * since `CONTROLLER_SERVER_URL` wouldn't survive either.
 *
 * `CONTROLLER_SERVER_URL` is still injected as a best-effort fast path for
 * agents that do inherit the environment (Claude, Ada); the CLI checks it
 * before falling back to the runtime file.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orchestratorHome } from "./paths.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Source location of the `controller-browser` script that ships with the app.
 * Resolves to `<repo>/cli` in dev and `dist/cli` in a build; in a packaged
 * Electron app the server runs from inside `app.asar`, but the CLI is
 * `asarUnpack`'d, so remap to the real `app.asar.unpacked` copy.
 */
function browserCliSourcePath(): string {
  const dir = path
    .resolve(moduleDir, "../../cli")
    .replace(/app\.asar(?!\.unpacked)/, "app.asar.unpacked");
  return path.join(dir, "controller-browser");
}

/** Stable absolute path the CLI is installed to (outside any app bundle). */
export function browserCliInstalledPath(): string {
  return path.join(orchestratorHome(), "bin", "controller-browser");
}

/** Runtime file the CLI reads to find this server. */
function browserRuntimeFile(): string {
  return path.join(orchestratorHome(), "browser-runtime.json");
}

function serverPort(): number {
  const parsed = Number(process.env.PORT);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 3100;
}

function serverUrl(): string {
  return `http://localhost:${serverPort()}`;
}

/**
 * Copy the CLI to its stable install path and publish the server URL to the
 * runtime file. Idempotent; safe to call on every startup.
 */
export async function installBrowserCli(): Promise<void> {
  const installed = browserCliInstalledPath();
  await fs.mkdir(path.dirname(installed), { recursive: true });
  await fs.copyFile(browserCliSourcePath(), installed);
  await fs.chmod(installed, 0o755);
  await fs.writeFile(
    browserRuntimeFile(),
    `${JSON.stringify({ serverUrl: serverUrl() }, null, 2)}\n`,
    "utf-8"
  );
}

/**
 * Best-effort environment for agents that inherit it (Claude, Ada). Codex
 * sanitizes this away, which is why the absolute install path + runtime file
 * are the real contract; this only saves the CLI a file read when it survives.
 */
export function browserAgentEnv(): Record<string, string> {
  return {
    CONTROLLER_SERVER_URL: serverUrl(),
  };
}
