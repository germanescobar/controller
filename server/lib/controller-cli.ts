/*
 * Wiring that lets agents reach the unified `controller` CLI (issues #109, #130).
 *
 * Agents run commands in sanitized/login shells (Codex strips non-core env
 * vars; zsh `-l` rebuilds PATH), so neither an injected PATH entry nor custom
 * env vars reliably reach the agent's shell. The robust handle is a stable
 * **absolute path**: on startup we copy the CLI to
 * `<orchestratorHome>/bin/controller` and the preamble/skills invoke it by that
 * path. We also install `controller-browser` as a deprecated alias so the old
 * issue-#109 path keeps working. The server URL is published to a runtime file
 * the CLI reads.
 *
 * `CONTROLLER_SERVER_URL` is still injected as a best-effort fast path for
 * agents that inherit the environment (Claude, Anita); the CLI checks it before
 * falling back to the runtime file.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orchestratorHome } from "./paths.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Source `cli` dir, remapped out of `app.asar` to the unpacked copy when packaged. */
function cliSourceDir(): string {
  return path
    .resolve(moduleDir, "../../cli")
    .replace(/app\.asar(?!\.unpacked)/, "app.asar.unpacked");
}

/** Stable absolute path the unified CLI is installed to. */
export function controllerCliInstalledPath(): string {
  return path.join(orchestratorHome(), "bin", "controller");
}

function controllerRuntimeFile(): string {
  return path.join(orchestratorHome(), "controller-runtime.json");
}

function serverPort(): number {
  const parsed = Number(process.env.PORT);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 3100;
}

function serverUrl(): string {
  return `http://localhost:${serverPort()}`;
}

/**
 * Copy the unified CLI (and the `controller-browser` alias) to their stable
 * install paths and publish the server URL. Idempotent; safe on every startup.
 */
export async function installControllerCli(): Promise<void> {
  const binDir = path.join(orchestratorHome(), "bin");
  await fs.mkdir(binDir, { recursive: true });

  for (const name of ["controller", "controller-browser"]) {
    const dest = path.join(binDir, name);
    await fs.copyFile(path.join(cliSourceDir(), name), dest);
    await fs.chmod(dest, 0o755);
  }

  await fs.writeFile(
    controllerRuntimeFile(),
    `${JSON.stringify({ serverUrl: serverUrl() }, null, 2)}\n`,
    "utf-8"
  );
}

/** Best-effort environment for agents that inherit it (Claude, Anita). */
export function controllerAgentEnv(): Record<string, string> {
  return { CONTROLLER_SERVER_URL: serverUrl() };
}
