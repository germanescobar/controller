import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGitExitCode, runScriptCommands } from "../worktree-processes.js";
import type { ProjectScriptCommand } from "../project-scripts.js";

/*
 * Issue #471: the worktree process helpers must report signal-terminated
 * processes as failures, reap a timed-out setup script's whole process
 * tree, and survive log write failures.
 */

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "worktree-processes-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function scriptCommand(command: string): ProjectScriptCommand {
  return { label: "setup", command, source: "native" };
}

test("runGitExitCode reports a git killed by SIGKILL as a failure", async () => {
  await withTempDir(async (dir) => {
    // A fake `git` first on PATH that kills itself, standing in for an OOM
    // or shutdown kill: the child closes with code null and signal SIGKILL.
    const fakeGit = path.join(dir, "git");
    await writeFile(fakeGit, "#!/bin/sh\nkill -KILL $$\n");
    await chmod(fakeGit, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;
    try {
      const exitCode = await runGitExitCode(dir, ["fetch"]);
      assert.notEqual(exitCode, 0);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

test(
  "a timed-out setup command leaves no surviving descendant",
  // An orphaned grandchild holds the stdout pipe open, so without the
  // group kill the run doesn't even resolve until `sleep 60` exits.
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    await withTempDir(async (dir) => {
      const output: string[] = [];
      const result = await runScriptCommands(
        [scriptCommand("sleep 60 & echo $!; wait")],
        dir,
        {},
        path.join(dir, "setup.log"),
        (chunk) => output.push(chunk),
        500
      );
      assert.equal(result.timedOut, true);
      assert.notEqual(result.exitCode, 0);
      const sleepPid = Number(output.join("").split("\n")[1]);
      assert.ok(Number.isInteger(sleepPid) && sleepPid > 0, `bad pid in ${output.join("")}`);
      await waitFor(() => !isAlive(sleepPid), 2_000);
    });
  }
);

test("a log stream error is surfaced without crashing the run", async () => {
  await withTempDir(async (dir) => {
    const stderr: string[] = [];
    const logPath = path.join(dir, "missing-dir", "setup.log");
    const result = await runScriptCommands(
      [scriptCommand("echo hello")],
      dir,
      {},
      logPath,
      (chunk, stream) => {
        if (stream === "stderr") stderr.push(chunk);
      }
    );
    assert.deepEqual(result, { exitCode: 0, timedOut: false });
    assert.match(stderr.join(""), /failed to write log .*setup\.log: ENOENT/);
  });
});

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
