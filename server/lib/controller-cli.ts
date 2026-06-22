/*
 * Wiring that lets agents reach the unified `controller` CLI (issues #109, #130, #187).
 *
 * On startup we copy the CLI to `<orchestratorHome>/bin/controller` and the
 * same dir for `controller-browser` (deprecated alias for the old issue-#109
 * path). The absolute install path is the **robust handle**: it survives any
 * provider that strips or sanitizes env, and it stays valid across rebuilds
 * because the install step is idempotent and always rewrites the binary.
 *
 * For providers that inherit the spawned environment (Codex app-server, Anita,
 * Claude) we also prepend the install dir to `PATH`, so a bare `controller
 * skills describe <name>` invocation resolves inside the agent's shell. This
 * makes the documented workflow work as written (see issue #187) without
 * requiring a manual symlink into `~/.local/bin`. The absolute path remains
 * the documented fallback for any provider that drops PATH.
 *
 * The server URL is published to a runtime file the CLI reads. We also inject
 * `CONTROLLER_SERVER_URL` as a fast path for agents that inherit env vars but
 * drop the runtime-file lookup (Claude, Anita); the CLI checks the env var
 * before falling back to the file.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergePathEntries } from "./shell-env.js";
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

/** Directory the CLI is installed to. Prepending it to PATH makes the bare
 *  `controller` command resolvable from agent and terminal shells (issue #187). */
export function controllerCliBinDir(): string {
  return path.dirname(controllerCliInstalledPath());
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

/** Best-effort environment for agents that inherit it (Claude, Anita, Codex).
 *
 *  Layers two things on top of the inherited env:
 *  - `CONTROLLER_SERVER_URL` so the CLI can skip the runtime-file lookup.
 *  - `PATH` with `<orchestratorHome>/bin` prepended so a bare `controller`
 *    invocation resolves inside the agent's shell (issue #187). Existing
 *    entries are kept first and the bin dir is appended only if missing,
 *    matching the dedup behavior of `mergePathEntries`.
 *
 *  Providers that sanitize env vars are still expected to invoke the CLI by
 *  its absolute install path; that path is what the agent preamble and the
 *  managed browser skill document.
 */
export function controllerAgentEnv(): Record<string, string> {
  const basePath = process.env.PATH ?? "";
  const mergedPath = mergePathEntries(basePath, controllerCliBinDir());
  return {
    CONTROLLER_SERVER_URL: serverUrl(),
    PATH: mergedPath,
  };
}
