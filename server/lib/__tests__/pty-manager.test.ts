import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { ptyManager, lastLines, tmuxSessionNames, buildTmuxShellCommand } from "../pty-manager.js";

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

const PTY_OUTPUT_TIMEOUT_MS = 8000;

test("buildTmuxShellCommand strips LINES and COLUMNS from the shell env (issue #317)", () => {
  // Direct, deterministic check that the `env -u …` chain issued to
  // `tmux new-session` scrubs LINES / COLUMNS. The string must contain
  // the flags and the scrub must come BEFORE any per-worktree env
  // assignments, so it actually takes effect for the user's shell.
  // Earlier test coverage only exercised this through a live tmux
  // session whose env didn't always contain LINES / COLUMNS, which let
  // regressions slip through (PR #318 review feedback).
  const command = buildTmuxShellCommand();
  assert.match(command, /-u LINES\b/, "expected `-u LINES` in buildTmuxShellCommand output");
  assert.match(command, /-u COLUMNS\b/, "expected `-u COLUMNS` in buildTmuxShellCommand output");

  // The scrub must be inside the `env -u …` argument list that comes
  // before the shell. A naive impl that puts `LINES=` *after* the scrub
  // would still strip the parent's value but re-introduce the var via
  // the assignment; the order in the resulting string is what
  // `tmux new-session … <command>` actually sees.
  const scrubIndex = command.indexOf("-u LINES");
  const shellIndex = command.lastIndexOf(" -i");
  assert.ok(scrubIndex >= 0 && shellIndex > scrubIndex, "expected `-u LINES` to appear before the shell is launched");

  // Run the command for real in a subshell with LINES=999 / COLUMNS=999
  // in the env, swapping the interactive `-i` for a one-shot `-c` that
  // prints any surviving LINES= / COLUMNS= entries. The scrub must
  // prevent them from reaching the inner shell.
  const probe = command.replace(
    / -i$/,
    ' -c "env -0 | tr \'\\\\0\' \'\\n\' | grep -E \'^(LINES|COLUMNS)=\' ; true"'
  );
  const result = spawnSync(probe, {
    env: { ...process.env, LINES: "999", COLUMNS: "999" },
    shell: true,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `expected probe to succeed; got status=${result.status}, stdout=${result.stdout}, stderr=${result.stderr}`
  );
  assert.equal(
    result.stdout.trim(),
    "",
    `expected LINES / COLUMNS to be stripped from the shell env; got: ${result.stdout}`
  );
});

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

    const timeout = new Promise((resolve) => setTimeout(resolve, PTY_OUTPUT_TIMEOUT_MS));
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

test("listLiveByPrefix and isLive reach tmux-only sessions", async (t) => {
  // The user can see a terminal in the Terminals tab even when no
  // WebSocket is attached — `detachIfIdle` kills the node-pty on WS close
  // but leaves the tmux session alive. The agent's `terminal list` and
  // the `run` / `snapshot` / `tail` gates had to agree with the renderer's
  // tmux-driven tab list, or the agent surface would report 0 terminals in
  // worktrees the user is actively using. `listLiveByPrefix` and `isLive`
  // are the methods that close that gap.
  if (!tmuxAvailable()) {
    t.skip("tmux is not available");
    return;
  }
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pty-manager-tmux-only-"));
  const suffix = Math.random().toString(36).slice(2, 8);
  const sessionId = `p1:w1:tmuxonly-${suffix}`;
  const tmuxName = tmuxSessionNames(sessionId)[0];
  try {
    // Spawn a tmux session directly (no node-pty, no `getOrCreate`).
    execFileSync(
      "tmux",
      ["new-session", "-d", "-s", tmuxName, "-c", cwd, "sh -c 'echo HELLO; sleep 30'"],
      { stdio: "ignore" }
    );

    // isLive returns true even with no in-memory PTY.
    assert.equal(ptyManager.has(sessionId), false);
    assert.equal(ptyManager.isLive(sessionId), true);

    // listLiveByPrefix surfaces the tmux-only session, marked as detached.
    const live = ptyManager.listLiveByPrefix("p1:w1:");
    const found = live.find((entry) => entry.id === `tmuxonly-${suffix}`);
    assert.ok(found, `expected listLiveByPrefix to include the tmux-only session, got: ${JSON.stringify(live)}`);
    assert.equal(found.attached, false);

    // listByPrefix (the PTY-only version) still excludes it.
    assert.equal(ptyManager.listByPrefix("p1:w1:").length, 0);

    // snapshot falls back to `tmux capture-pane` and reads the on-screen content.
    const snap = ptyManager.snapshot(sessionId, 200) ?? "";
    assert.match(snap, /HELLO/);
  } finally {
    for (const name of tmuxSessionNames(sessionId)) {
      try {
        execFileSync("tmux", ["kill-session", "-t", `=${name}`], { stdio: "ignore" });
      } catch {
        // ignore
      }
    }
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

    const timeout = new Promise((resolve) => setTimeout(resolve, PTY_OUTPUT_TIMEOUT_MS));
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

    const timeout = new Promise((resolve) => setTimeout(resolve, PTY_OUTPUT_TIMEOUT_MS));
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

test("detachIfIdle drops only the tmux client PTY", async (t) => {
  if (!tmuxAvailable()) {
    t.skip("tmux is not available");
    return;
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pty-manager-detach-"));
  const suffix = Math.random().toString(36).slice(2, 8);
  const sessionId = "p1:w1:detach-" + suffix;

  try {
    const created = ptyManager.getOrCreate(sessionId, cwd);
    if (created.error) {
      t.skip("could not spawn a PTY: " + created.error);
      return;
    }

    const unsubscribe = ptyManager.onData(sessionId, () => {});
    assert.equal(ptyManager.detachIfIdle(sessionId), false);
    assert.equal(ptyManager.has(sessionId), true);
    unsubscribe?.();

    assert.equal(ptyManager.detachIfIdle(sessionId), true);
    assert.equal(ptyManager.has(sessionId), false);
    execFileSync("tmux", ["has-session", "-t", `=${tmuxSessionNames(sessionId)[0]}`], {
      stdio: "ignore",
    });

    const reattached = ptyManager.getOrCreate(sessionId, cwd);
    assert.equal(reattached.error, undefined);
    assert.equal(ptyManager.has(sessionId), true);
  } finally {
    ptyManager.kill(sessionId);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("Controller tmux sessions use emacs copy-mode keys", async (t) => {
  if (!tmuxAvailable()) {
    t.skip("tmux is not available");
    return;
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pty-manager-mode-keys-"));
  const suffix = Math.random().toString(36).slice(2, 8);
  const sessionId = "p1:w1:mode-" + suffix;
  const sessionName = tmuxSessionNames(sessionId)[0];

  try {
    const created = ptyManager.getOrCreate(sessionId, cwd);
    if (created.error) {
      t.skip("could not spawn a PTY: " + created.error);
      return;
    }

    const modeKeys = execFileSync(
      "tmux",
      ["show-window-options", "-t", `=${sessionName}`, "-v", "mode-keys"],
      { encoding: "utf8" }
    ).trim();
    assert.equal(modeKeys, "emacs");

    execFileSync("tmux", ["copy-mode", "-t", `${sessionName}:0.0`], { stdio: "ignore" });
    execFileSync("tmux", ["send-keys", "-t", `${sessionName}:0.0`, "Escape"], {
      stdio: "ignore",
    });
    const paneMode = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", `${sessionName}:0.0`, "#{pane_in_mode}"],
      { encoding: "utf8" }
    ).trim();
    assert.equal(paneMode, "0");
  } finally {
    ptyManager.kill(sessionId);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

/*
 * Issue #317: pagers don't paginate inside the controller because tmux's
 * pane is sized from the attaching client (80x24 in our case) instead of
 * from a real measurement, and stale LINES / COLUMNS env vars let pagers
 * trust the env over the pty. The unit-level tests below pin the three
 * things that fix it: the tmux `window-size latest` option, an explicit
 * initial pane size, and the LINES / COLUMNS scrub. A separate end-to-end
 * test runs `git log` in a tall-enough git history to confirm the
 * pager actually engages.
 */

test("Controller tmux sessions set window-size latest (issue #317)", async (t) => {
  if (!tmuxAvailable()) {
    t.skip("tmux is not available");
    return;
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pty-manager-winsize-"));
  const suffix = Math.random().toString(36).slice(2, 8);
  const sessionId = "p1:w1:winsize-" + suffix;
  const sessionName = tmuxSessionNames(sessionId)[0];

  try {
    const created = ptyManager.getOrCreate(sessionId, cwd);
    if (created.error) {
      t.skip("could not spawn a PTY: " + created.error);
      return;
    }

    const windowSize = execFileSync(
      "tmux",
      ["show-window-options", "-t", `=${sessionName}`, "-v", "window-size"],
      { encoding: "utf8" }
    ).trim();
    assert.equal(
      windowSize,
      "latest",
      "expected window-size latest so the pane tracks the latest client-reported size"
    );
  } finally {
    ptyManager.kill(sessionId);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("Newly created tmux panes start at a reasonable size (issue #317)", async (t) => {
  if (!tmuxAvailable()) {
    t.skip("tmux is not available");
    return;
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pty-manager-panesize-"));
  const suffix = Math.random().toString(36).slice(2, 8);
  const sessionId = "p1:w1:panesize-" + suffix;
  const sessionName = tmuxSessionNames(sessionId)[0];

  try {
    const created = ptyManager.getOrCreate(sessionId, cwd);
    if (created.error) {
      t.skip("could not spawn a PTY: " + created.error);
      return;
    }

    // `#{pane_width}` / `#{pane_height}` reflect the pane's *server-side*
    // size, not the attaching client's. They should match the 200x50 we
    // pass to `new-session -x/-y` so the user's first command sees a
    // tall-enough pane.
    const size = execFileSync(
      "tmux",
      [
        "display-message",
        "-p",
        "-t",
        `${sessionName}:0.0`,
        "#{pane_width}x#{pane_height}",
      ],
      { encoding: "utf8" }
    ).trim();
    assert.equal(size, "200x50", "expected pane to be created at 200x50");
  } finally {
    ptyManager.kill(sessionId);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("Controller tmux sessions strip LINES and COLUMNS from the shell env (issue #317)", async (t) => {
  if (!tmuxAvailable()) {
    t.skip("tmux is not available");
    return;
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pty-manager-pagerenv-"));
  const suffix = Math.random().toString(36).slice(2, 8);
  const sessionId = "p1:w1:pagerenv-" + suffix;
  const sentinel = "PAGERENV_SENTINEL_" + suffix;

  try {
    const created = ptyManager.getOrCreate(sessionId, cwd);
    if (created.error) {
      t.skip("could not spawn a PTY: " + created.error);
      return;
    }

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

    await new Promise((resolve) => setTimeout(resolve, 200));
    // Probe for both vars in a single, well-formed line so the shell
    // actually executes it. The grep pattern closes on this line; the
    // sentinel is emitted by `printf` and does NOT appear in the command
    // text itself, so the test's `combined.includes(sentinel)` check below
    // is satisfied by the *output* of the command, not by the echo of the
    // input. Otherwise a syntactically broken command would let this test
    // pass even if LINES / COLUMNS were still exported (issue #317 PR
    // review feedback).
    ptyManager.runCommand(
      sessionId,
      cwd,
      `set +e; env -0 | tr '\\0' '\\n' | grep -E '^(LINES|COLUMNS)='; printf '${sentinel}\\n'`
    );

    const timeout = new Promise((resolve) => setTimeout(resolve, PTY_OUTPUT_TIMEOUT_MS));
    await Promise.race([reader, timeout]);
    controller.abort();

    const combined = collected.join("");
    assert.ok(
      combined.includes(sentinel),
      "expected the probe command to run to completion; got: " + combined
    );
    assert.ok(
      !/(^|\n)LINES=/.test(combined),
      "expected LINES to be stripped from the shell env; got: " + combined
    );
    assert.ok(
      !/(^|\n)COLUMNS=/.test(combined),
      "expected COLUMNS to be stripped from the shell env; got: " + combined
    );
  } finally {
    ptyManager.kill(sessionId);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("PtyManager.resize updates the tmux server-side window (issue #317)", async (t) => {
  if (!tmuxAvailable()) {
    t.skip("tmux is not available");
    return;
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pty-manager-resize-"));
  const suffix = Math.random().toString(36).slice(2, 8);
  const sessionId = "p1:w1:resize-" + suffix;
  const sessionName = tmuxSessionNames(sessionId)[0];

  try {
    const created = ptyManager.getOrCreate(sessionId, cwd);
    if (created.error) {
      t.skip("could not spawn a PTY: " + created.error);
      return;
    }

    ptyManager.resize(sessionId, 120, 40);

    const size = execFileSync(
      "tmux",
      [
        "display-message",
        "-p",
        "-t",
        `${sessionName}:0.0`,
        "#{pane_width}x#{pane_height}",
      ],
      { encoding: "utf8" }
    ).trim();
    assert.equal(
      size,
      "120x40",
      "expected resize() to propagate to the tmux pane in the same tick"
    );

    // A mobile viewer shares this PTY but must not change the shell's
    // formatting for the desktop viewer, even while both are attached.
    const unsubscribe = ptyManager.onData(sessionId, () => {});
    assert.ok(unsubscribe);
    ptyManager.resize(sessionId, 40, 20, false);
    assert.equal(
      execFileSync("tmux", ["display-message", "-p", "-t", `${sessionName}:0.0`, "#{pane_width}x#{pane_height}"], { encoding: "utf8" }).trim(),
      "120x40"
    );
    unsubscribe();
    assert.equal(ptyManager.detachIfIdle(sessionId), true);

    // A later mobile-only attachment must start at the pane's saved size;
    // spawning tmux attach at 80x24 would shrink it before any resize event.
    const reattached = ptyManager.getOrCreate(sessionId, cwd);
    assert.equal(reattached.error, undefined);
    assert.equal(
      execFileSync("tmux", ["display-message", "-p", "-t", `${sessionName}:0.0`, "#{pane_width}x#{pane_height}"], { encoding: "utf8" }).trim(),
      "120x40"
    );
  } finally {
    ptyManager.kill(sessionId);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("git log paginates in a controller terminal (issue #317)", async (t) => {
  if (!tmuxAvailable()) {
    t.skip("tmux is not available");
    return;
  }
  if (!gitAvailable()) {
    t.skip("git is not available");
    return;
  }

  // Build a temporary git repo with enough commits that `git log` is
  // taller than the pane. 200 commits produces ~600+ lines of output —
  // well beyond the 50-row pane we create.
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pty-manager-pager-"));
  const suffix = Math.random().toString(36).slice(2, 8);
  const sessionId = "p1:w1:pager-" + suffix;
  const sentinel = "PAGER_PROMPT_" + suffix;

  const run = (args: string[], opts: { cwd?: string; input?: string } = {}) =>
    execFileSync(args[0], args.slice(1), {
      cwd: opts.cwd ?? cwd,
      input: opts.input,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });

  try {
    run(["git", "init", "-q", "-b", "main"]);
    run(["git", "config", "user.email", "test@example.com"]);
    run(["git", "config", "user.name", "Test"]);
    run(["git", "config", "commit.gpgsign", "false"]);
    // Create an initial commit so we can chain from it.
    await fs.writeFile(path.join(cwd, "README.md"), "test\n");
    run(["git", "add", "README.md"]);
    run(["git", "commit", "-q", "-m", "init"]);
    for (let i = 0; i < 200; i += 1) {
      await fs.writeFile(path.join(cwd, "f.txt"), String(i) + "\n");
      run(["git", "add", "f.txt"]);
      run(["git", "commit", "-q", "-m", "commit " + i]);
    }

    const created = ptyManager.getOrCreate(sessionId, cwd);
    if (created.error) {
      t.skip("could not spawn a PTY: " + created.error);
      return;
    }

    // Force a small pane so paging is inevitable. With a 50-row pane and
    // ~600 lines of `git log`, `less` (git's default pager) must page.
    ptyManager.resize(sessionId, 80, 24);

    const controller = new AbortController();
    const iterable = ptyManager.tail(sessionId, controller.signal);
    assert.ok(iterable, "expected a tail iterable for the live session");

    const collected: string[] = [];
    let sawPagerPrompt = false;
    const reader = (async () => {
      for await (const chunk of iterable as AsyncIterable<string>) {
        collected.push(chunk);
        // `less` enters the alternate screen on launch (`\x1b[?1049h`) and
        // either shows `--More--`, `(END)`, or its `(PAGER PROMPT)` line
        // when the output is taller than the pane. The original bug was
        // that *none* of these appeared and the entire log dumped in one
        // go, so any of the above counts as the pager being engaged.
        if (/\x1b\[\?1049h/.test(collected.join(""))) {
          sawPagerPrompt = true;
          break;
        }
        if (/(?:--More--|MORE|PAUSE|\(END\))/.test(collected.join(""))) {
          sawPagerPrompt = true;
          break;
        }
        if (collected.join("").includes(sentinel)) break;
      }
    })();

    // Use the real pager: clear any inherited PAGER / GIT_PAGER and run
    // `git log` against the tall history.
    ptyManager.runCommand(sessionId, cwd, "unset PAGER GIT_PAGER; git log");

    const timeout = new Promise((resolve) => setTimeout(resolve, PTY_OUTPUT_TIMEOUT_MS));
    await Promise.race([reader, timeout]);
    controller.abort();

    // Cancel the pager so the tmux session can exit cleanly.
    ptyManager.runCommand(sessionId, cwd, "q");
    ptyManager.runCommand(sessionId, cwd, `printf '${sentinel}\\n'`);

    assert.ok(
      sawPagerPrompt,
      "expected `git log` to page; got: " + collected.slice(0, 3).join("").slice(0, 500)
    );
  } finally {
    ptyManager.kill(sessionId);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

/*
 * Issue #436: the sidebar's run-server state and its Stop button rely on
 * `isCommandRunning` and `interrupt`. A run.sh launches as `bash run.sh`,
 * so a running script must not look like an idle shell, and terminals from
 * pre-rename builds (legacy tmux names) must be reachable too.
 */
async function waitFor(predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + PTY_OUTPUT_TIMEOUT_MS;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

async function assertInterruptStops(sessionId: string, start: () => void): Promise<void> {
  start();
  assert.ok(await waitFor(() => ptyManager.isCommandRunning(sessionId)), "expected the command to be running");
  ptyManager.interrupt(sessionId);
  assert.ok(await waitFor(() => !ptyManager.isCommandRunning(sessionId)), "expected the command to stop");
  assert.equal(ptyManager.isLive(sessionId), true);
}

for (const command of ["sleep 30", "bash -c 'sleep 30; true'"]) {
  test(`interrupt stops \`${command}\` but keeps the terminal alive (issue #436)`, async (t) => {
    if (!tmuxAvailable()) {
      t.skip("tmux is not available");
      return;
    }
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pty-manager-interrupt-"));
    const sessionId = "p1:w1:run-" + Math.random().toString(36).slice(2, 8);
    try {
      await assertInterruptStops(sessionId, () => ptyManager.runCommand(sessionId, cwd, command));
    } finally {
      ptyManager.kill(sessionId);
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
}

test("isCommandRunning and interrupt reach legacy-named tmux sessions (issue #436)", async (t) => {
  if (!tmuxAvailable()) {
    t.skip("tmux is not available");
    return;
  }
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pty-manager-legacy-"));
  const sessionId = "p1:w1:run-" + Math.random().toString(36).slice(2, 8);
  const legacyName = tmuxSessionNames(sessionId)[1];
  try {
    execFileSync("tmux", ["new-session", "-d", "-s", legacyName, "-c", cwd, "bash --norc -i"], { stdio: "ignore" });
    assert.ok(await waitFor(() => ptyManager.isLive(sessionId)), "expected the legacy session to be live");
    assert.equal(ptyManager.isCommandRunning(sessionId), false);
    await assertInterruptStops(sessionId, () =>
      execFileSync("tmux", ["send-keys", "-t", `${legacyName}:0.0`, "sleep 30", "Enter"], { stdio: "ignore" })
    );
  } finally {
    ptyManager.kill(sessionId);
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
