import * as pty from "node-pty";
import os from "node:os";

interface PtySession {
  pty: pty.IPty;
  buffer: string;
  cwd: string;
}

const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB per session buffer

class PtyManager {
  private sessions = new Map<string, PtySession>();

  /** Get or create a PTY for a session. Returns the existing buffer if reconnecting. */
  getOrCreate(sessionId: string, cwd: string): { isNew: boolean; buffer: string; error?: string } {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return { isNew: false, buffer: existing.buffer };
    }

    const shell = process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "/bin/zsh");

    // Build a clean env — filter out keys that can interfere with node-pty
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(process.env)) {
      if (val === undefined) continue;
      env[key] = val;
    }

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to spawn PTY for session ${sessionId}: ${msg}`);
      return { isNew: true, buffer: "", error: msg };
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
  }

  /** Kill and remove every PTY whose session id starts with a prefix. */
  killByPrefix(prefix: string): void {
    for (const sessionId of Array.from(this.sessions.keys())) {
      if (sessionId.startsWith(prefix)) {
        this.kill(sessionId);
      }
    }
  }
}

export const ptyManager = new PtyManager();
