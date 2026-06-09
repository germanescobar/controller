import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
