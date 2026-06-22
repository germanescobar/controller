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
 * Before installing, we also remove the legacy `~/.local/bin/controller`
 * workaround the issue originally documented — but only when the symlink
 * resolves into our own bundle. A user-authored binary named `controller`
 * somewhere on PATH is left strictly alone; the cleanup targets the documented
 * workaround, not the name.
 *
 * The server URL is published to a runtime file the CLI reads. We also inject
 * `CONTROLLER_SERVER_URL` as a fast path for agents that inherit env vars but
 * drop the runtime-file lookup (Claude, Anita); the CLI checks the env var
 * before falling back to the file.
 */

import fs from "node:fs/promises";
import os from "node:os";
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

  // Best-effort: remove the `~/.local/bin/controller` workaround the issue
  // originally documented. Only targets symlinks/files whose `realpath` lands
  // inside our own bundle, so a user-authored binary named `controller` is
  // left strictly alone.
  await removeLegacyControllerSymlinks().catch(() => {});

  await fs.writeFile(
    controllerRuntimeFile(),
    `${JSON.stringify({ serverUrl: serverUrl() }, null, 2)}\n`,
    "utf-8"
  );
}

/**
 * Directories to scan for the legacy `controller` workaround. Kept narrow on
 * purpose — only the directories the issue itself suggested. We deliberately
 * do not walk the whole `PATH` because the cleanup is "remove the
 * documented workaround", not "police the user's PATH".
 */
function legacySymlinkDirs(): string[] {
  return [path.join(os.homedir(), ".local", "bin")];
}

function legacySymlinkNames(): string[] {
  return ["controller", "controller-browser"];
}

/**
 * Remove the `controller` / `controller-browser` workaround files the issue
 * originally pointed users at, but only when they actually resolve into our
 * own CLI bundle. A user-authored `controller` binary the user wrote
 * themselves is left alone — we compare the candidate's `realpath` against
 * the bundled source dir, not just the name.
 *
 * Best-effort by design: any failure is swallowed. Never blocks startup.
 * Exposed for testing.
 */
export async function removeLegacyControllerSymlinks(): Promise<void> {
  const sourceDir = cliSourceDir();
  for (const dir of legacySymlinkDirs()) {
    for (const name of legacySymlinkNames()) {
      const candidate = path.join(dir, name);
      let resolved: string;
      try {
        resolved = await fs.realpath(candidate);
      } catch {
        // Missing or unreadable — nothing to clean up here.
        continue;
      }
      // Only remove candidates that ultimately point at our bundled CLI. A
      // user-authored `controller` somewhere on `PATH` is left strictly
      // alone; the cleanup targets the documented workaround, not the name.
      if (resolved !== sourceDir && !resolved.startsWith(sourceDir + path.sep)) {
        continue;
      }
      try {
        await fs.unlink(candidate);
      } catch {
        // Best-effort: permission issues, races, etc. are not fatal.
      }
    }
  }
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
