import * as pty from "node-pty";
import crypto from "node:crypto";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import {
  CONTROLLER_INTERNAL_ENV,
  childProcessEnv,
  formatEnvAssignments,
  shellQuote,
} from "./shell-env.js";

interface PtySession {
  pty: pty.IPty;
  buffer: string;
  cwd: string;
  /* Number of live `onData` subscribers (renderer panes, agent tails). Used by
   * the terminal surface (issue #261) to report whether a terminal is being
   * watched, without changing the persistent-session lifecycle. */
  listeners: number;
  sizeSource: "unsized" | "mobile" | "desktop";
}

/** Return the last `lines` lines of `text`, or all of it when it has fewer. */
export function lastLines(text: string, lines: number): string {
  const limit = Math.max(1, Math.floor(lines));
  // Terminal output usually ends in a trailing newline. Splitting that raw
  // would yield an empty final element that consumes a line slot, so
  // `--lines N` would return only N-1 completed lines. Peel the trailing
  // newline off before counting and re-append it to preserve the output shape.
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  const parts = body.split("\n");
  if (parts.length <= limit) return text;
  return parts.slice(-limit).join("\n") + (trailingNewline ? "\n" : "");
}

const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB per session buffer
const TMUX_COMMAND_TIMEOUT_MS = 2000;
const TMUX_SESSION_PREFIX = "controller-";
/* Sessions created by builds before the coding-orchestrator → Controller
 * rename used this prefix. New sessions use TMUX_SESSION_PREFIX; cleanup still
 * matches the legacy prefix so in-flight sessions from an older build aren't
 * orphaned. */
const LEGACY_TMUX_SESSION_PREFIX = "coding-orchestrator-";

function sanitizeTmuxName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function tmuxSessionName(sessionId: string): string {
  const safeId = sanitizeTmuxName(sessionId).slice(0, 160);
  const hash = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  return `${TMUX_SESSION_PREFIX}${safeId}-${hash}`;
}

/* All tmux session names a logical `sessionId` could map to — the current
 * `controller-...` name plus the `coding-orchestrator-...` name used by builds
 * before the rename. Single-id kills (issue #296) must cover both, otherwise
 * a legacy session survives the close and the next `getTerminalTabs` poll
 * re-discovers it via `listTmuxTerminalIds` and re-adds the tab. Exported for
 * tests that need to reference the legacy name shape directly. */
export function tmuxSessionNames(sessionId: string): string[] {
  const safeId = sanitizeTmuxName(sessionId).slice(0, 160);
  const hash = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  return [
    `${TMUX_SESSION_PREFIX}${safeId}-${hash}`,
    `${LEGACY_TMUX_SESSION_PREFIX}${safeId}-${hash}`,
  ];
}

/* The tmux session currently backing `sessionId` (current or legacy name). */
function liveTmuxSessionName(sessionId: string): string | null {
  for (const name of tmuxSessionNames(sessionId)) {
    try {
      execTmuxSync(["has-session", "-t", `=${name}`], { stdio: "ignore" });
      return name;
    } catch {
      // Not this name; try the next candidate.
    }
  }
  return null;
}

function tmuxActivePaneTarget(sessionName: string): string {
  // The trailing colon selects the active window/pane regardless of base-index.
  return `=${sessionName}:`;
}

/* Both the current and legacy session-name prefixes for a logical prefix, so
 * cleanup matches sessions created by older builds too. */
function tmuxPrefixes(prefix: string): string[] {
  const safe = sanitizeTmuxName(prefix);
  return [`${TMUX_SESSION_PREFIX}${safe}`, `${LEGACY_TMUX_SESSION_PREFIX}${safe}`];
}

function listTmuxSessions(): string[] {
  try {
    const output = execTmuxSync(["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }) as string;
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function killTmuxSession(sessionName: string): void {
  try {
    execTmuxSync(["kill-session", "-t", `=${sessionName}`], {
      stdio: "ignore",
    });
  } catch {
    // The tmux session may already be gone.
  }
}

/**
 * Extract the terminal id from a tmux session name. The tmux name embeds the
 * sanitized logical sessionId plus a 12-char SHA-256 hash, e.g.
 * `controller-<projectId>_<worktreeId>_<terminalId>-<hash>`. We strip the
 * tmux prefix and the trailing hash to recover the terminal id. Returns
 * `null` when the name doesn't match the expected shape (e.g. a session
 * owned by another app) so the caller can skip it.
 */
function terminalIdFromTmuxSessionName(
  sessionName: string,
  targetPrefixes: string[]
): string | null {
  const matchedPrefix = targetPrefixes.find((target) => sessionName.startsWith(target));
  if (!matchedPrefix) return null;
  const stripped = sessionName
    .slice(matchedPrefix.length)
    .replace(/-[0-9a-f]{12}$/, "");
  return stripped && /^[a-zA-Z0-9._-]+$/.test(stripped) ? stripped : null;
}

/** True when a tmux session with the given logical id is alive. */
function tmuxSessionExists(sessionId: string): boolean {
  for (const name of tmuxSessionNames(sessionId)) {
    try {
      execTmuxSync(["has-session", "-t", `=${name}`], { stdio: "ignore" });
      return true;
    } catch {
      // Try the next candidate (legacy prefix) before giving up.
    }
  }
  return false;
}

/**
 * Capture the last `lines` lines of the visible pane of a tmux session via
 * `tmux capture-pane -p`. Used by `snapshot` for tmux-only sessions (no
 * in-memory PTY buffer to read from). Returns `null` when the session has
 * been killed or the target has no visible pane.
 */
function captureTmuxPane(sessionId: string, lines: number): string | null {
  for (const name of tmuxSessionNames(sessionId)) {
    try {
      return execTmuxSync(
        ["capture-pane", "-p", "-t", tmuxActivePaneTarget(name), "-S", `-${Math.max(1, lines)}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ) as string;
    } catch {
      // Try the next candidate (legacy prefix) before giving up.
    }
  }
  return null;
}

/* Env vars we always strip from the user's interactive shell inside a tmux
 * session. The user's shell and anything it launches — pagers (`less`,
 * `git log`), `tput`, `stty`, `vim` — read the terminal size from
 * `ioctl(TIOCGWINSZ)` on the controlling pty. If a stale `LINES` / `COLUMNS`
 * is inherited from the parent (Electron's main process sets them in
 * packaged builds, and tmux's own env may carry them through), tools trust
 * the env value and skip the pager entirely on a tall pane. Removing them
 * from the launch `env -u ...` chain forces every child to read the actual
 * pty size, which the controller's tmux pane reports correctly once
 * `window-size latest` is set (issue #317). */
const PAGER_ENV_TO_UNSET = ["LINES", "COLUMNS"] as const;

/**
 * Build the command that `tmux new-session` runs in the pane. The
 * `env -u …` chain strips Controller's own runtime vars *and* `LINES` /
 * `COLUMNS` so pagers fall back to `ioctl(TIOCGWINSZ)` on the actual tmux
 * pane size instead of trusting a stale value (issue #317). Exported so
 * tests can assert the `env -u …` chain directly without spinning up a
 * live tmux session.
 */
export function buildTmuxShellCommand(env?: Record<string, string>): string {
  const shell = process.env.SHELL || "/bin/sh";
  // Strip Controller's own runtime vars (e.g. NODE_ENV=production, our PORT) so
  // the user's interactive shell — and anything launched from it — never
  // inherits them. `-u` removes them even if the tmux server's environment
  // passed them in, and runs before any per-worktree assignments in `env`.
  // Also strip `LINES` / `COLUMNS` so pagers fall back to `ioctl` and read
  // the actual tmux pane size instead of a stale value from the parent env
  // (issue #317).
  const parts = [
    "exec",
    "env",
    ...CONTROLLER_INTERNAL_ENV.map((key) => `-u ${key}`),
    ...PAGER_ENV_TO_UNSET.map((key) => `-u ${key}`),
  ];
  if (env) parts.push(formatEnvAssignments(env));
  parts.push(shellQuote(shell), "-i");
  return parts.join(" ");
}

function runTmux(args: string[], options?: ExecFileSyncOptions): void {
  try {
    execTmuxSync(args, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output = typeof err === "object" && err !== null && "stderr" in err
      ? (err as { stderr?: Buffer | string }).stderr
      : undefined;
    const stderr = Buffer.isBuffer(output) ? output.toString().trim() : output?.trim();
    throw new Error(stderr ? `${message}: ${stderr}` : message);
  }
}

function execTmuxSync(args: string[], options?: ExecFileSyncOptions): Buffer | string {
  return execFileSync("tmux", args, {
    ...options,
    timeout: options?.timeout ?? TMUX_COMMAND_TIMEOUT_MS,
  });
}

function setTmuxEnvironment(sessionName: string, env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    try {
      execTmuxSync(["set-environment", "-t", `=${sessionName}`, key, value], {
        stdio: "ignore",
      });
    } catch {
      // Ignore env set failures on older tmux versions.
    }
  }
}

/* Initial size for newly created tmux panes. Without an explicit -x/-y, tmux
 * uses the *attaching* client's size at attach time, which for the controller
 * is 80x24 (hard-coded in `pty.spawn` until the first client resize arrives)
 * — that means the pane is 24 rows tall and pagers like `less` / `git log`
 * page immediately even when the user has a 50-row terminal visible
 * (issue #317). We give the pane a reasonable starting size so the user's
 * first `git log` after opening the terminal sees a tall-enough pane and
 * doesn't page. Once the client fit → WS resize pipeline reports the real
 * size, `window-size latest` (set in `configureTmuxSession`) takes over.
 *
 * The values are not advertised to the user; they're a "best guess until
 * the real size arrives" that matches the typical controller terminal
 * (≈200 cols × 50 rows) and the default 80x24 fallback when no
 * client-reported size is available. */
const DEFAULT_TMUX_PANE_COLS = 200;
const DEFAULT_TMUX_PANE_ROWS = 50;

function ensureTmuxSession(sessionName: string, cwd: string, env?: Record<string, string>): void {
  const exists = (() => {
    try {
      execTmuxSync(["has-session", "-t", `=${sessionName}`], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  })();

  if (!exists) {
    // Always launch through the shell wrapper, even without per-worktree env,
    // so Controller's internal vars are stripped from every tmux session.
    // `-x` / `-y` set the *pane* size at creation; without them tmux uses
    // the attaching client's size (issue #317), which for us is 80x24 and
    // makes pagers trigger on every first command.
    const args = [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-c",
      cwd,
      "-x",
      String(DEFAULT_TMUX_PANE_COLS),
      "-y",
      String(DEFAULT_TMUX_PANE_ROWS),
      buildTmuxShellCommand(env),
    ];
    execTmuxSync(args, { stdio: "ignore" });
    // Persist sizing ownership in tmux so mobile-only reconnects can continue
    // resizing, while a later desktop size stays protected across restarts.
    execTmuxSync(["set-option", "-t", sessionName, "@controller-size-source", "unsized"], {
      stdio: "ignore",
    });
  }

  if (env) {
    setTmuxEnvironment(sessionName, env);
  }

  configureTmuxSession(sessionName);
}

function configureTmuxSession(sessionName: string): void {
  execTmuxSync(["set-option", "-t", sessionName, "status", "off"], {
    stdio: "ignore",
  });

  execTmuxSync(["set-option", "-t", sessionName, "mouse", "on"], {
    stdio: "ignore",
  });

  execTmuxSync(["set-option", "-t", sessionName, "history-limit", "50000"], {
    stdio: "ignore",
  });

  execTmuxSync(["set-window-option", "-t", sessionName, "mode-keys", "emacs"], {
    stdio: "ignore",
  });

  // Issue #317: tmux's default `window-size smallest` pins the pane to the
  // smallest size any attaching client has ever reported. Our attaching
  // client initially spawns at 80x24 (see `pty.spawn` in getOrCreate), so
  // the pane would stay tiny forever and the only way for the user to grow
  // it would be to first attach a *smaller* client. `latest` makes the
  // pane track the most recent client-reported size, which is what users
  // expect when they resize the controller UI — and what the resize
  // pipeline (client fit → WS resize → PtyManager.resize → pty.resize →
  // SIGWINCH) is trying to deliver.
  execTmuxSync(["set-window-option", "-t", sessionName, "window-size", "latest"], {
    stdio: "ignore",
  });
}

function tmuxPaneSize(sessionName: string): { cols: number; rows: number } {
  const size = execTmuxSync(
    ["display-message", "-p", "-t", tmuxActivePaneTarget(sessionName), "#{pane_width} #{pane_height}"],
    { encoding: "utf8" }
  ) as string;
  const [cols, rows] = size.trim().split(" ").map(Number);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new Error(`Invalid tmux pane size: ${size.trim()}`);
  }
  return { cols, rows };
}

function tmuxSizeSource(sessionName: string): PtySession["sizeSource"] {
  try {
    const source = (execTmuxSync(
      ["show-option", "-qv", "-t", sessionName, "@controller-size-source"],
      { encoding: "utf8" }
    ) as string).trim();
    if (source === "unsized" || source === "mobile") return source;
  } catch {
    // Sessions from older builds have no size source; preserve their pane size.
  }
  return "desktop";
}

class PtyManager {
  private sessions = new Map<string, PtySession>();

  /** Get or create a PTY for a session. Returns the existing buffer if reconnecting. */
  getOrCreate(sessionId: string, cwd: string, extraEnv?: Record<string, string>): { isNew: boolean; buffer: string; error?: string } {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      // Re-apply env vars on reconnection in case they weren't set before.
      if (extraEnv) {
        setTmuxEnvironment(tmuxSessionName(sessionId), extraEnv);
      }
      configureTmuxSession(tmuxSessionName(sessionId));
      return { isNew: false, buffer: existing.buffer };
    }

    // Clean env for the attaching tmux client: drop Controller's internal vars,
    // then layer on worktree vars. The session shell's own env is stripped
    // separately via buildTmuxShellCommand.
    const env = childProcessEnv(extraEnv);

    let ptyProcess: pty.IPty;
    let sizeSource: PtySession["sizeSource"];
    const sessionName = tmuxSessionName(sessionId);
    try {
      ensureTmuxSession(sessionName, cwd, extraEnv);
      sizeSource = tmuxSizeSource(sessionName);
      // An 80x24 attaching client can shrink a previously wide tmux pane
      // before the browser has reported its size, including on mobile-only
      // reconnects. Attach at the pane's current dimensions instead.
      const size = tmuxPaneSize(sessionName);
      ptyProcess = pty.spawn("tmux", ["attach-session", "-t", `=${sessionName}`], {
        name: "xterm-256color",
        cols: size.cols,
        rows: size.rows,
        cwd,
        env,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to spawn PTY for session ${sessionId}: ${msg}`);
      return { isNew: true, buffer: "", error: `tmux is required for persistent terminals: ${msg}` };
    }

    const session: PtySession = {
      pty: ptyProcess,
      buffer: "",
      cwd,
      listeners: 0,
      sizeSource,
    };

    // Accumulate output into the buffer
    ptyProcess.onData((data: string) => {
      session.buffer += data;
      // Cap buffer size — keep the most recent data
      if (session.buffer.length > MAX_BUFFER_SIZE) {
        session.buffer = session.buffer.slice(-MAX_BUFFER_SIZE);
      }
    });

    ptyProcess.onExit(() => {
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, session);
    return { isNew: true, buffer: "" };
  }

  /** Write data (keystrokes) to the PTY. */
  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.pty.write(data);
  }

  /** Ensure a tmux session exists and run a shell command in it. */
  runCommand(
    sessionId: string,
    cwd: string,
    command: string,
    extraEnv?: Record<string, string>
  ): void {
    const sessionName = tmuxSessionName(sessionId);
    ensureTmuxSession(sessionName, cwd, extraEnv);
    const target = tmuxActivePaneTarget(sessionName);
    runTmux(["send-keys", "-t", target, "-l", command], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    runTmux(["send-keys", "-t", target, "Enter"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  }

  /**
   * Send Ctrl-C to a terminal's foreground command. The tab and its output
   * stay, which is what stopping a run server needs (closing would lose logs).
   */
  interrupt(sessionId: string): void {
    const name = liveTmuxSessionName(sessionId);
    if (!name) return;
    runTmux(["send-keys", "-t", tmuxActivePaneTarget(name), "C-c"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  }

  /** Resize the PTY. */
  resize(sessionId: string, cols: number, rows: number, canResize = true): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (!canResize && session.sizeSource === "desktop") return;
    const c = Math.max(1, Math.min(cols, 500));
    const r = Math.max(1, Math.min(rows, 200));
    session.pty.resize(c, r);
    session.sizeSource = canResize ? "desktop" : "mobile";

    // Issue #317: belt-and-suspenders resize of the tmux *server's* window.
    // `pty.resize` on the attaching `tmux attach-session` child sends SIGWINCH
    // to tmux, which usually updates the pane, but tmux's window/pane-size
    // bookkeeping is asynchronous and can race the user's next `git log`. A
    // direct `tmux resize-window` makes the pane match the client size in
    // the same tick, so pagers see the real size immediately. Silently
    // ignored when the session is gone (e.g. just killed) or tmux fails;
    // the primary path through `pty.resize` still works.
    for (const name of tmuxSessionNames(sessionId)) {
      try {
        execTmuxSync(
          ["set-option", "-t", name, "@controller-size-source", session.sizeSource],
          { stdio: "ignore" }
        );
        execTmuxSync(
          ["resize-window", "-t", `=${name}`, "-x", String(c), "-y", String(r)],
          { stdio: "ignore" }
        );
      } catch {
        // Try the next candidate (legacy prefix) before giving up.
      }
    }
  }

  /** Register a data listener. Returns unsubscribe function. */
  onData(sessionId: string, cb: (data: string) => void): (() => void) | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const disposable = session.pty.onData(cb);
    session.listeners += 1;
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      session.listeners -= 1;
      disposable.dispose();
    };
  }

  /**
   * List the sessions whose id starts with `prefix`, returning the trailing
   * id segment and whether anything is currently watching its output. Powers
   * `terminal list` (issue #261), scoped to a single worktree by its prefix.
   */
  listByPrefix(prefix: string): Array<{ id: string; attached: boolean }> {
    const out: Array<{ id: string; attached: boolean }> = [];
    for (const [key, session] of this.sessions) {
      if (key.startsWith(prefix)) {
        out.push({ id: key.slice(prefix.length), attached: session.listeners > 0 });
      }
    }
    return out;
  }

  /**
   * List every live terminal in a worktree, including tmux-only sessions that
   * have no in-memory PTY. The agent's `terminal list` should always reach a
   * terminal the user can see in the Terminals tab — that tab list is built
   * from persisted tabs + live tmux sessions (see `terminal-tabs.ts`), so the
   * agent surface has to agree or it returns 0 terminals in worktrees the
   * user is currently using. PTY-backed sessions take precedence on duplicate
   * ids (their `attached` flag is more informative than the false we'd report
   * for a tmux-only entry).
   */
  listLiveByPrefix(prefix: string): Array<{ id: string; attached: boolean }> {
    const out = new Map<string, { id: string; attached: boolean }>();
    for (const [key, session] of this.sessions) {
      if (key.startsWith(prefix)) {
        out.set(key.slice(prefix.length), {
          id: key.slice(prefix.length),
          attached: session.listeners > 0,
        });
      }
    }
    const targetPrefixes = tmuxPrefixes(prefix);
    for (const sessionName of listTmuxSessions()) {
      const id = terminalIdFromTmuxSessionName(sessionName, targetPrefixes);
      if (!id || out.has(id)) continue;
      out.set(id, { id, attached: false });
    }
    return Array.from(out.values());
  }

  /**
   * True when a terminal is reachable: either a PTY is currently attached
   * (`this.sessions.has`) or the underlying tmux session is still alive. The
   * tmux session outlives the PTY — `detachIfIdle` kills the node-pty on WS
   * close but leaves tmux running, and the user can re-attach from the
   * Terminals tab. The agent's `terminal run`/`snapshot`/`tail` should treat
   * a tmux-only session as live too, otherwise the user can see a terminal
   * the agent cannot.
   */
  isLive(sessionId: string): boolean {
    if (this.sessions.has(sessionId)) return true;
    return tmuxSessionExists(sessionId);
  }

  /**
   * True when a terminal is running a foreground job beyond its idle shell.
   * Compares the pane shell's process group with the terminal's foreground
   * process group: they match at an idle prompt and differ while a command
   * such as `bash run.sh` runs. Command names can't tell these apart (a
   * running script shows up as `bash`), and counting child processes would
   * misfire on shell plugins that keep background helpers alive.
   */
  isCommandRunning(sessionId: string): boolean {
    const name = liveTmuxSessionName(sessionId);
    if (!name) return false;
    try {
      const panePid = (execTmuxSync(
        ["display-message", "-p", "-t", tmuxActivePaneTarget(name), "#{pane_pid}"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ) as string).trim();
      const [pgid, tpgid] = execFileSync("ps", ["-o", "pgid=,tpgid=", "-p", panePid], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().split(/\s+/);
      return Boolean(pgid && tpgid) && tpgid !== "-1" && pgid !== tpgid;
    } catch {
      // The pane exited between the lookup and the check: nothing is running.
      return false;
    }
  }

  /**
   * Return the last `lines` lines of a session's output, or null when the
   * session is not live. PTY-backed sessions read from the in-memory rolling
   * buffer; tmux-only sessions (PTY was detached by `detachIfIdle` but tmux
   * is still alive) read from `tmux capture-pane` so the agent gets the
   * actual on-screen content the user sees.
   */
  snapshot(sessionId: string, lines: number): string | null {
    const session = this.sessions.get(sessionId);
    if (session) return lastLines(session.buffer, lines);
    return captureTmuxPane(sessionId, lines);
  }

  /**
   * Async iterable over new output for a session, or null when the session
   * does not exist. Wraps the existing `onData` subscription so multiple
   * tails can run alongside the renderer's stream. Pass an `AbortSignal` to
   * stop the iteration (a `--follow` client disconnecting, or a non-follow
   * idle timeout); the subscription is always cleaned up on exit.
   */
  tail(sessionId: string, signal?: AbortSignal): AsyncIterable<string> | null {
    if (!this.sessions.has(sessionId)) return null;
    const self = this;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<string> {
        const queue: string[] = [];
        let wake: (() => void) | null = null;
        const onAbort = () => wake?.();
        signal?.addEventListener("abort", onAbort);
        const unsubscribe = self.onData(sessionId, (data) => {
          queue.push(data);
          wake?.();
        });
        if (!unsubscribe) {
          signal?.removeEventListener("abort", onAbort);
          return;
        }
        try {
          while (!signal?.aborted) {
            if (queue.length === 0) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = null;
              if (signal?.aborted) break;
            }
            while (queue.length > 0) {
              yield queue.shift() as string;
            }
          }
        } finally {
          unsubscribe();
          signal?.removeEventListener("abort", onAbort);
        }
      },
    };
  }

  /** Check if a session has a PTY. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Detach the tmux client PTY when nobody is watching it, leaving the
   * underlying tmux session and its shell/processes alive for a later attach.
   */
  detachIfIdle(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.listeners > 0) return false;
    session.pty.kill();
    this.sessions.delete(sessionId);
    return true;
  }

  /** Kill and remove a PTY. Also kills the underlying tmux session for both
   * the current and the pre-rename legacy session name (issue #296) — the
   * periodic `getTerminalTabs` poll discovers both, so a close that only
   * killed the current name would let a legacy session resurface. */
  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pty.kill();
      this.sessions.delete(sessionId);
    }
    for (const name of tmuxSessionNames(sessionId)) {
      killTmuxSession(name);
    }
  }

  /** Kill and remove every PTY whose session id starts with a prefix. */
  killByPrefix(prefix: string): void {
    for (const sessionId of Array.from(this.sessions.keys())) {
      if (sessionId.startsWith(prefix)) {
        this.kill(sessionId);
      }
    }
    const targetPrefixes = tmuxPrefixes(prefix);
    for (const sessionName of listTmuxSessions()) {
      if (targetPrefixes.some((target) => sessionName.startsWith(target))) {
        killTmuxSession(sessionName);
      }
    }
  }
}

export const ptyManager = new PtyManager();
