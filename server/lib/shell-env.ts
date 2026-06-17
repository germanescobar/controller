import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Vars owned by Controller's own server runtime. The packaged Electron main
 * process mutates the global `process.env` with these so the in-process server
 * can read them (see `electron/main.ts`). They must never leak into processes
 * spawned on behalf of a user project, where e.g. `NODE_ENV=production` or a
 * colliding `PORT` silently breaks the project's tooling.
 */
export const CONTROLLER_INTERNAL_ENV = [
  "PORT",
  "NODE_ENV",
  "SERVE_CLIENT_DIST",
  "CLIENT_DIST_DIR",
] as const;

const CONTROLLER_INTERNAL_ENV_SET = new Set<string>(CONTROLLER_INTERNAL_ENV);

/**
 * Build an environment for a child process spawned on behalf of a user
 * project. Starts from the current `process.env`, drops Controller's own
 * runtime vars (see {@link CONTROLLER_INTERNAL_ENV}), then layers `extra` on
 * top. Use this instead of `{ ...process.env, ...extra }` for any project-
 * facing spawn so the project's own tooling defaults apply.
 */
export function childProcessEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || CONTROLLER_INTERNAL_ENV_SET.has(key)) continue;
    env[key] = value;
  }
  return extra ? { ...env, ...extra } : env;
}

/**
 * Merge a freshly-captured PATH into the current one, keeping existing
 * entries first and appending only new directories. The result never drops
 * a directory the process already had, so restoration is purely additive.
 */
export function mergePathEntries(current: string, restored: string): string {
  const separator = ":";
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const entry of [...current.split(separator), ...restored.split(separator)]) {
    const dir = entry.trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }

  return merged.join(separator);
}

let restored = false;

/**
 * Capture the user's login + interactive shell PATH and merge it into
 * `process.env.PATH`. A Finder/Dock-launched packaged macOS app inherits a
 * minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) that omits NVM, Homebrew,
 * and pnpm directories, so spawning `codex`/`claude`/`ada` — and even the
 * `node` their shebangs resolve — fails with ENOENT. Sourcing the login
 * shell restores the same PATH the user sees in their terminal.
 *
 * Best-effort and additive: failures (no shell, timeout, weird rc files)
 * leave the existing PATH untouched. Runs at most once per process.
 */
export async function restoreLoginShellPath(): Promise<void> {
  if (restored) return;
  restored = true;

  const shell = process.env.SHELL?.trim() || "/bin/sh";

  try {
    // `-l` sources login files (.zprofile/.bash_profile); `-i` sources
    // interactive files (.zshrc/.bashrc) where NVM is usually initialized.
    // A sentinel delimits our value so noisy rc-file output can't corrupt it.
    const { stdout } = await execFileAsync(
      shell,
      ["-lic", 'printf "__CO_PATH__%s__CO_PATH__" "$PATH"'],
      { timeout: 3000, encoding: "utf-8" }
    );
    const match = stdout.match(/__CO_PATH__(.*?)__CO_PATH__/s);
    const capturedPath = match?.[1]?.trim();
    if (capturedPath) {
      process.env.PATH = mergePathEntries(process.env.PATH ?? "", capturedPath);
    }
  } catch {
    // Leave PATH as-is; resolution falls back to whatever the process had.
  }
}
