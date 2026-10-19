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
 * `npm install` under a setup script), not just the wrapper. Once the
 * leader has exited we never signal the group: its pgid may have been
 * recycled by an unrelated process group (same rule as monitors, #459).
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
    let leaderExited = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!leaderExited) killProcessTree(child);
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => writeScriptOutput(d, "stdout", logStream, onData));
    child.stderr?.on("data", (d: Buffer) => writeScriptOutput(d, "stderr", logStream, onData));
    child.on("exit", () => {
      leaderExited = true;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      onData(`spawn error: ${err.message}\n`, "stderr");
      resolve({ exitCode: 1, timedOut });
    });
  });
}

/** SIGKILL the child's process group, falling back to the child itself. */
function killProcessTree(child: ChildProcess): void {
  if (isolateProcessGroup && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        console.error(`[worktrees] SIGKILL of process group ${child.pid} failed:`, error);
      }
    }
  }
  child.kill("SIGKILL");
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
