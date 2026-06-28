import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { ptyManager, lastLines } from "../pty-manager.js";

/*
 * Issue #261: unit coverage for the terminal surface's `ptyManager` additions.
 *
 * `lastLines` is a pure helper and tested directly. `listByPrefix`, `snapshot`,
 * and `tail` need a live tmux-backed PTY, so those tests spin up a real session
 * and skip when tmux/node-pty isn't available in the environment (the same
 * dependency the persistent-terminal feature already requires).
 */

test("lastLines returns the trailing N lines and the whole text when shorter", () => {
  assert.equal(lastLines("a\nb\nc\nd", 2), "c\nd");
  assert.equal(lastLines("a\nb", 5), "a\nb");
  // A request of 0 or negative is clamped up to 1 line.
  assert.equal(lastLines("a\nb\nc", 0), "c");
  assert.equal(lastLines("only", 3), "only");
});

test("lastLines counts completed lines when the text ends in a newline", () => {
  // A trailing newline must not consume a line slot: `--lines 1` should still
  // return the last completed line, and `--lines N` the last N of them.
  assert.equal(lastLines("a\nb\nc\n", 1), "c\n");
  assert.equal(lastLines("a\nb\nc\n", 2), "b\nc\n");
  // When the whole text fits, it is returned verbatim (newline preserved).
  assert.equal(lastLines("a\nb\n", 5), "a\nb\n");
});

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("listByPrefix, snapshot and tail observe a live terminal", async (t) => {
  if (!tmuxAvailable()) {
    t.skip("tmux is not available");
    return;
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pty-manager-"));
  const suffix = Math.random().toString(36).slice(2, 8);
  const inScope = "p1:w1:term-" + suffix;
  const otherWorktree = "p1:w2:term-" + suffix;

  const created = ptyManager.getOrCreate(inScope, cwd);
  if (created.error) {
    t.skip("could not spawn a PTY: " + created.error);
    return;
  }
  const createdOther = ptyManager.getOrCreate(otherWorktree, cwd);

  try {
    // listByPrefix is scoped to a single worktree prefix and never leaks
    // another worktree's terminals (the cross-worktree negative case).
    const listed = ptyManager.listByPrefix("p1:w1:");
    assert.deepEqual(
      listed.map((entry) => entry.id),
      ["term-" + suffix]
    );
    assert.equal(ptyManager.listByPrefix("p1:w2:").length, createdOther.error ? 0 : 1);

    // snapshot/tail return null for an unknown session.
    assert.equal(ptyManager.snapshot("p1:w1:missing", 10), null);
    assert.equal(ptyManager.tail("p1:w1:missing"), null);

    // Drive a deterministic line through the terminal and confirm tail sees it.
    const controller = new AbortController();
    const iterable = ptyManager.tail(inScope, controller.signal);
    assert.ok(iterable, "expected a tail iterable for the live session");

    const sentinel = "SENTINEL_" + suffix;
    const collected: string[] = [];
    const reader = (async () => {
      for await (const chunk of iterable as AsyncIterable<string>) {
        collected.push(chunk);
        if (collected.join("").includes(sentinel)) break;
      }
    })();

    // Give the attach a moment, then echo the sentinel.
    await new Promise((resolve) => setTimeout(resolve, 200));
    ptyManager.runCommand(inScope, cwd, "echo " + sentinel);

    const timeout = new Promise((resolve) => setTimeout(resolve, 4000));
    await Promise.race([reader, timeout]);
    controller.abort();

    assert.ok(
      collected.join("").includes(sentinel),
      "expected tail to stream the echoed sentinel"
    );

    // snapshot reflects the same buffered output.
    const snap = ptyManager.snapshot(inScope, 200) ?? "";
    assert.ok(snap.includes(sentinel), "expected snapshot to include the sentinel");
  } finally {
    ptyManager.kill(inScope);
    ptyManager.kill(otherWorktree);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("runCommand sends the exact command string to the shell via send-keys", async (t) => {
  // The truncation bug this guards against: `runCommand` hands the
  // command string to `tmux send-keys`, so the user's interactive shell
  // sees it as one input line. If we inline a long `env KEY='v' ...`
  // prefix (or any long prefix), zsh's command-line buffer can silently
  // truncate it and the script never runs as written. The contract is:
  // what the caller passes in is what arrives at the shell, and the
  // caller is responsible for keeping it short.
  if (!tmuxAvailable()) {
    t.skip("tmux is not available");
    return;
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pty-manager-cmd-"));
  const suffix = Math.random().toString(36).slice(2, 8);
  const sessionId = "p1:w1:cmd-" + suffix;
  const sentinel = "SENTINEL_" + suffix;
  const probeCmd = "echo " + sentinel;

  try {
    const created = ptyManager.getOrCreate(sessionId, cwd);
    if (created.error) {
      t.skip("could not spawn a PTY: " + created.error);
      return;
    }

    ptyManager.runCommand(sessionId, cwd, probeCmd);

    const controller = new AbortController();
    const iterable = ptyManager.tail(sessionId, controller.signal);
    assert.ok(iterable, "expected a tail iterable for the live session");

    const collected: string[] = [];
    const reader = (async () => {
      for await (const chunk of iterable as AsyncIterable<string>) {
        collected.push(chunk);
        if (collected.join("").includes(sentinel)) break;
      }
    })();

    const timeout = new Promise((resolve) => setTimeout(resolve, 4000));
    await Promise.race([reader, timeout]);
    controller.abort();

    assert.ok(
      collected.join("").includes(sentinel),
      "expected the exact probe command to reach the shell; got: " + collected.join("")
    );
  } finally {
    ptyManager.kill(sessionId);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("getOrCreate applies extra env to the terminal session", async (t) => {
  if (!tmuxAvailable()) {
    t.skip("tmux is not available");
    return;
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pty-manager-env-"));
  const suffix = Math.random().toString(36).slice(2, 8);
  const sessionId = "p1:w1:env-" + suffix;
  const sentinel = "ENV_SENTINEL_" + suffix;

  try {
    const controller = new AbortController();
    const created = ptyManager.getOrCreate(sessionId, cwd, {
      CONTROLLER_TEST_SENTINEL: sentinel,
    });
    if (created.error) {
      t.skip("could not spawn a PTY: " + created.error);
      return;
    }

    const iterable = ptyManager.tail(sessionId, controller.signal);
    assert.ok(iterable, "expected a tail iterable for the live session");

    const collected: string[] = [];
    const reader = (async () => {
      for await (const chunk of iterable as AsyncIterable<string>) {
        collected.push(chunk);
        if (collected.join("").includes(sentinel)) break;
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 200));
    ptyManager.runCommand(sessionId, cwd, "printf '%s\\n' \"$CONTROLLER_TEST_SENTINEL\"");

    const timeout = new Promise((resolve) => setTimeout(resolve, 4000));
    await Promise.race([reader, timeout]);
    controller.abort();

    assert.ok(
      collected.join("").includes(sentinel),
      "expected runCommand env to reach the shell; got: " + collected.join("")
    );
  } finally {
    ptyManager.kill(sessionId);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
