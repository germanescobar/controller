import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import type { ProjectScriptCommand } from "./project-scripts.js";
import { childProcessEnv } from "./shell-env.js";

/*
 * Process helpers for the worktree routes: git invocations plus the
 * setup/archive script runner. A process terminated by a signal (OOM,
 * shutdown, the setup timeout) has a `null` exit code; every helper
 * reports that as a failure, never as success (issue #471).
 */

export const SETUP_TIMEOUT_MS = 5 * 60 * 1000;

export type OutputHandler = (chunk: string, stream: "stdout" | "stderr") => void;

export interface ScriptRunResult {
  exitCode: number;
  timedOut: boolean;
}

const isolateProcessGroup = process.platform !== "win32";

/** Grace period between the timeout's SIGTERM and the SIGKILL escalation. */
const KILL_GRACE_MS = 2_000;

export function runStreamed(
  command: string,
  args: string[],
  cwd: string,
  onData: OutputHandler
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd });
    child.stdout?.on("data", (d: Buffer) => onData(d.toString(), "stdout"));
    child.stderr?.on("data", (d: Buffer) => onData(d.toString(), "stderr"));
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

export function runGitCapture(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("close", (code) => {
      resolve(code === 0 ? out.trim() : undefined);
    });
    child.on("error", () => resolve(undefined));
  });
}

export function runGitExitCode(cwd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd });
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

/**
 * Run each script command in order, stopping at the first failure or
 * timeout. Output is mirrored to `logPath` and `onData`. A log write
 * failure doesn't abort the run: it's reported once through `onData` on
 * stderr and the remaining output still streams to the caller.
 */
export async function runScriptCommands(
  commands: ProjectScriptCommand[],
  cwd: string,
  env: Record<string, string>,
  logPath: string,
  onData: OutputHandler,
  timeoutMs: number = SETUP_TIMEOUT_MS
): Promise<ScriptRunResult> {
  const logStream = openScriptLog(logPath, onData);
  for (const command of commands) {
    const prompt = `$ ${command.command}\n`;
    logStream.write(prompt);
    onData(prompt, "stdout");

    const result = await runOneScriptCommand(command.command, cwd, env, timeoutMs, logStream, onData);
    if (result.timedOut || result.exitCode !== 0) {
      logStream.end();
      return result;
    }
  }

  logStream.end();
  return { exitCode: 0, timedOut: false };
}

function openScriptLog(logPath: string, onData: OutputHandler): WriteStream {
  const logStream = createWriteStream(logPath, { flags: "w" });
  // Without a listener a failed open/write is an unhandled 'error' event
  // that crashes the server. A destroyed stream ignores later writes.
  logStream.once("error", (err) => {
    onData(`failed to write log ${logPath}: ${err.message}\n`, "stderr");
  });
  return logStream;
}

/**
 * Run one command under `bash -lc`. On POSIX the shell leads its own
 * process group so the timeout kills everything it spawned (e.g. the
 * `npm install` under a setup script), not just the wrapper.
 *
 * The guard is whether the child's stdio has closed, not whether the
 * leader exited (unlike monitors, #459): a backgrounded descendant that
 * outlives the shell still holds the pipes and keeps the run pending, and
 * while it lives the group exists, so its pgid can't have been recycled.
 * Once 'close' fires nothing is signalled.
 */
function runOneScriptCommand(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  logStream: WriteStream,
  onData: OutputHandler
): Promise<ScriptRunResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: childProcessEnv(env),
      detached: isolateProcessGroup,
    });
    let closed = false;
    let timedOut = false;
    let escalationTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, "SIGTERM");
      escalationTimer = setTimeout(() => {
        if (closed) return;
        signalProcessTree(child, "SIGKILL");
        // A descendant outside the group (e.g. via setsid) can still hold
        // the pipes; drop our ends so the run always resolves.
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => writeScriptOutput(d, "stdout", logStream, onData));
    child.stderr?.on("data", (d: Buffer) => writeScriptOutput(d, "stderr", logStream, onData));
    child.on("close", (code) => {
      closed = true;
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      // The leader may have exited 0 before a descendant timed out; a
      // timed-out run is never reported as success.
      const exitCode = code ?? 1;
      resolve({ exitCode: timedOut && exitCode === 0 ? 1 : exitCode, timedOut });
    });
    child.on("error", (err) => {
      closed = true;
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      onData(`spawn error: ${err.message}\n`, "stderr");
      resolve({ exitCode: 1, timedOut });
    });
  });
}

/** Signal the child's process group, falling back to the child itself. */
function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (isolateProcessGroup && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        console.error(`[worktrees] ${signal} of process group ${child.pid} failed:`, error);
      }
    }
  }
  child.kill(signal);
}

function writeScriptOutput(
  data: Buffer,
  stream: "stdout" | "stderr",
  logStream: WriteStream,
  onData: OutputHandler
): void {
  const text = data.toString();
  logStream.write(text);
  onData(text, stream);
}
