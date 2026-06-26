import * as pty from "node-pty";
import crypto from "node:crypto";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { CONTROLLER_INTERNAL_ENV, childProcessEnv } from "./shell-env.js";

interface PtySession {
  pty: pty.IPty;
  buffer: string;
  cwd: string;
}

const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB per session buffer
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

function tmuxFirstPaneTarget(sessionName: string): string {
  return `${sessionName}:0.0`;
}

/* Both the current and legacy session-name prefixes for a logical prefix, so
 * cleanup matches sessions created by older builds too. */
function tmuxPrefixes(prefix: string): string[] {
  const safe = sanitizeTmuxName(prefix);
  return [`${TMUX_SESSION_PREFIX}${safe}`, `${LEGACY_TMUX_SESSION_PREFIX}${safe}`];
}

function listTmuxSessions(): string[] {
  try {
    const output = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function killTmuxSession(sessionName: string): void {
  try {
    execFileSync("tmux", ["kill-session", "-t", `=${sessionName}`], {
      stdio: "ignore",
    });
  } catch {
    // The tmux session may already be gone.
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatEnvAssignments(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
}

function buildTmuxShellCommand(env?: Record<string, string>): string {
  const shell = process.env.SHELL || "/bin/sh";
  // Strip Controller's own runtime vars (e.g. NODE_ENV=production, our PORT) so
  // the user's interactive shell — and anything launched from it — never
  // inherits them. `-u` removes them even if the tmux server's environment
  // passed them in, and runs before any per-worktree assignments in `env`.
  const parts = ["exec", "env", ...CONTROLLER_INTERNAL_ENV.map((key) => `-u ${key}`)];
  if (env) parts.push(formatEnvAssignments(env));
  parts.push(shellQuote(shell), "-i");
  return parts.join(" ");
}

function runTmux(args: string[], options?: ExecFileSyncOptions): void {
  try {
    execFileSync("tmux", args, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output = typeof err === "object" && err !== null && "stderr" in err
      ? (err as { stderr?: Buffer | string }).stderr
      : undefined;
    const stderr = Buffer.isBuffer(output) ? output.toString().trim() : output?.trim();
    throw new Error(stderr ? `${message}: ${stderr}` : message);
  }
}

function setTmuxEnvironment(sessionName: string, env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    try {
      execFileSync("tmux", ["set-environment", "-t", `=${sessionName}`, key, value], {
        stdio: "ignore",
      });
    } catch {
      // Ignore env set failures on older tmux versions.
    }
  }
}

function ensureTmuxSession(sessionName: string, cwd: string, env?: Record<string, string>): void {
  const exists = (() => {
    try {
      execFileSync("tmux", ["has-session", "-t", `=${sessionName}`], {
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
    const args = ["new-session", "-d", "-s", sessionName, "-c", cwd, buildTmuxShellCommand(env)];
    execFileSync("tmux", args, { stdio: "ignore" });
  }

  if (env) {
    setTmuxEnvironment(sessionName, env);
  }

  configureTmuxSession(sessionName);
}

function configureTmuxSession(sessionName: string): void {
  execFileSync("tmux", ["set-option", "-t", sessionName, "status", "off"], {
    stdio: "ignore",
  });

  execFileSync("tmux", ["set-option", "-t", sessionName, "mouse", "on"], {
    stdio: "ignore",
  });

  execFileSync("tmux", ["set-option", "-t", sessionName, "history-limit", "50000"], {
    stdio: "ignore",
  });
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
    const sessionName = tmuxSessionName(sessionId);
    try {
      ensureTmuxSession(sessionName, cwd, extraEnv);
      ptyProcess = pty.spawn("tmux", ["attach-session", "-t", `=${sessionName}`], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
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
  runCommand(sessionId: string, cwd: string, command: string): void {
    const sessionName = tmuxSessionName(sessionId);
    ensureTmuxSession(sessionName, cwd);
    runTmux(["send-keys", "-t", tmuxFirstPaneTarget(sessionName), command, "C-m"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  }

  /** Resize the PTY. */
  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      const c = Math.max(1, Math.min(cols, 500));
      const r = Math.max(1, Math.min(rows, 200));
      session.pty.resize(c, r);
    }
  }

  /** Register a data listener. Returns unsubscribe function. */
  onData(sessionId: string, cb: (data: string) => void): (() => void) | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const disposable = session.pty.onData(cb);
    return () => disposable.dispose();
  }

  /** Check if a session has a PTY. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Kill and remove a PTY. */
  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pty.kill();
      this.sessions.delete(sessionId);
    }
    killTmuxSession(tmuxSessionName(sessionId));
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
