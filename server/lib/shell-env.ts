import { execFile } from "node:child_process";
import fs from "node:fs/promises";
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
 * Shell-single-quote a value so it's safe as a single shell token. Matches
 * the quoting the existing `bash -lc '...'` and `tmux` invocations already
 * rely on — used by every caller that interpolates an untrusted string into
 * a shell command line.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render `env` as a space-separated sequence of `KEY='value'` assignments,
 * each one shell-safe via {@link shellQuote}. Used to build the per-
 * session tmux launch command via `buildTmuxShellCommand` — the user's
 * interactive shell never sees these as input, so argv / input-line size
 * isn't a concern there.
 *
 * For handing env to a *script* the shell runs (e.g. a project `run.sh`),
 * use {@link writeEnvFile} instead: a long inline assignment list would
 * land in the `tmux send-keys` input line and trip the zsh command-line
 * buffer / argv truncation the env-out-of-band plumbing exists to avoid.
 */
export function formatEnvAssignments(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
}

/**
 * Write `env` to `filePath` as a shell-sourceable file of `export KEY=val`
 * assignments, one per line. Each value is single-quoted with embedded
 * quotes escaped via {@link shellQuote}, so values containing newlines,
 * spaces, single quotes, or shell metacharacters are safe to `source`.
 *
 * Used to hand env to a script that the user's interactive shell runs
 * via `tmux send-keys`. The `bash -lc 'set -a; . <file>; …'` command
 * itself stays short regardless of how large the env values are, which
 * is what avoids zsh's command-line buffer / argv truncation.
 */
export async function writeEnvFile(
  filePath: string,
  env: Record<string, string>
): Promise<void> {
  const lines = Object.entries(env).map(
    ([key, value]) => `export ${key}=${shellQuote(value)}`
  );
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
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
 * and pnpm directories, so spawning `codex`/`claude`/`anita` — and even the
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
