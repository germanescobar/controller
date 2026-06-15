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
 * Env injection (CONTROLLER_SERVER_URL + PATH) is still applied as a
 * best-effort fast path for agents that do inherit the environment.
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
export function browserRuntimeFile(): string {
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
 * sanitizes these away, which is why the absolute install path is the real
 * contract.
 */
export function browserAgentEnv(): Record<string, string> {
  const binDir = path.dirname(browserCliInstalledPath());
  const currentPath = process.env.PATH ?? "";
  const PATH = currentPath ? `${binDir}${path.delimiter}${currentPath}` : binDir;
  return {
    CONTROLLER_SERVER_URL: serverUrl(),
    PATH,
  };
}
