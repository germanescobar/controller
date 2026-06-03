import * as pty from "node-pty";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

interface PtySession {
  pty: pty.IPty;
  buffer: string;
  cwd: string;
}

const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB per session buffer
const TMUX_SESSION_PREFIX = "coding-orchestrator-";

function sanitizeTmuxName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function tmuxSessionName(sessionId: string): string {
  const safeId = sanitizeTmuxName(sessionId).slice(0, 160);
  const hash = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  return `${TMUX_SESSION_PREFIX}${safeId}-${hash}`;
}

function tmuxPrefix(prefix: string): string {
  return `${TMUX_SESSION_PREFIX}${sanitizeTmuxName(prefix)}`;
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
    execFileSync("tmux", ["new-session", "-d", "-s", sessionName, "-c", cwd], {
      stdio: "ignore",
    });
  }

  // Inject worktree env vars into the tmux session so the shell inherits them.
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      try {
        execFileSync("tmux", ["set-environment", "-t", `=${sessionName}`, key, value], {
          stdio: "ignore",
        });
      } catch {
        // Silently ignore env set failures on older tmux versions.
      }
    }
  }

  configureTmuxSession(sessionName);
}

function configureTmuxSession(sessionName: string): void {
  execFileSync("tmux", ["set-option", "-t", sessionName, "status", "off"], {
    stdio: "ignore",
  });

  execFileSync("tmux", ["set-option", "-t", sessionName, "mouse", "off"], {
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
        const sessionName = tmuxSessionName(sessionId);
        for (const [key, value] of Object.entries(extraEnv)) {
          try {
            execFileSync("tmux", ["set-environment", "-t", `=${sessionName}`, key, value], {
              stdio: "ignore",
            });
          } catch { /* ignore */ }
        }
      }
      configureTmuxSession(tmuxSessionName(sessionId));
      return { isNew: false, buffer: existing.buffer };
    }

    // Build a clean env — copy process.env then layer on worktree vars
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(process.env)) {
      if (val === undefined) continue;
      env[key] = val;
    }
    if (extraEnv) {
      Object.assign(env, extraEnv);
    }

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
    execFileSync("tmux", ["send-keys", "-t", `=${sessionName}`, command, "C-m"], {
      stdio: "ignore",
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
    const targetPrefix = tmuxPrefix(prefix);
    for (const sessionName of listTmuxSessions()) {
      if (sessionName.startsWith(targetPrefix)) {
        killTmuxSession(sessionName);
      }
    }
  }
}

export const ptyManager = new PtyManager();
