/*
 * HTTP surface for the `controller terminal` CLI (issue #261).
 *
 * The CLI POSTs a terminal command here; the route resolves the agent's cwd to
 * a (projectId, worktreeId) via `findWorktreeByPath` — the same scoping the
 * browser surface uses (`routes/browser.ts`) — and dispatches to `ptyManager`.
 * That keeps an agent confined to the terminals inside its own worktree: the
 * server, not the CLI, owns terminal addressing.
 *
 * Terminals are the persistent tmux-backed PTYs the renderer drives over
 * `/ws/terminal`. Agents can only reach ones the user already has open;
 * creating a terminal stays a UI action, so `run`/`snapshot`/`tail` 404 when
 * the addressed PTY does not exist.
 */

import { Router, type Request, type Response } from "express";
import { findWorktreeByPath } from "../lib/worktrees.js";
import { ptyManager } from "../lib/pty-manager.js";

export const terminalRouter = Router();

const KNOWN_ACTIONS = new Set(["list", "run", "snapshot", "tail"]);
// Same id grammar `normalizeTerminalId` enforces on the WebSocket path.
const TERMINAL_ID_RE = /^[a-zA-Z0-9._-]+$/;
const DEFAULT_SNAPSHOT_LINES = 200;
// Without --follow, `tail` returns once output has gone quiet for this long, so
// the agent gets a bounded read instead of a connection that never closes.
const TAIL_IDLE_MS = 1000;

terminalRouter.post("/command", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // The CLI runs in the agent's shell, whose cwd is the worktree. Mapping that
  // path back to the project/worktree means a single constant server URL is the
  // only thing the agent needs in its environment.
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const action = typeof body.action === "string" ? body.action : "";
  const params =
    body.params && typeof body.params === "object"
      ? (body.params as Record<string, unknown>)
      : {};

  if (!cwd) {
    res.status(400).json({ ok: false, error: "Missing cwd" });
    return;
  }
  if (!KNOWN_ACTIONS.has(action)) {
    res.status(400).json({ ok: false, error: `Unknown terminal action: ${action}` });
    return;
  }

  const worktree = await findWorktreeByPath(cwd);
  if (!worktree) {
    res.status(404).json({
      ok: false,
      error: "Could not match the current directory to a known project worktree",
    });
    return;
  }

  const prefix = `${worktree.projectId}:${worktree.id}:`;

  if (action === "list") {
    const terminals = ptyManager
      .listByPrefix(prefix)
      .map(({ id, attached }) => ({ id, label: id, attached }));
    res.json({
      ok: true,
      projectId: worktree.projectId,
      worktreeId: worktree.id,
      terminals,
    });
    return;
  }

  // run / snapshot / tail all address one terminal by id.
  const terminalId = typeof params.terminalId === "string" ? params.terminalId.trim() : "";
  if (!terminalId || !TERMINAL_ID_RE.test(terminalId)) {
    res.status(400).json({ ok: false, error: "A valid <terminalId> is required" });
    return;
  }
  const sessionId = `${prefix}${terminalId}`;
  if (!ptyManager.has(sessionId)) {
    res.status(404).json({
      ok: false,
      error: `No terminal "${terminalId}" is open in this worktree. Open it in the Terminals tab first, or run \`terminal list\`.`,
    });
    return;
  }

  if (action === "run") {
    const command = typeof params.command === "string" ? params.command : "";
    if (!command.trim()) {
      res.status(400).json({ ok: false, error: "A <command> is required" });
      return;
    }
    try {
      ptyManager.runCommand(sessionId, worktree.path, command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(409).json({ ok: false, error: message });
      return;
    }
    res.json({ ok: true, terminalId, sent: command });
    return;
  }

  if (action === "snapshot") {
    const lines = parseLines(params.lines);
    const text = ptyManager.snapshot(sessionId, lines) ?? "";
    res.json({ ok: true, terminalId, text });
    return;
  }

  // action === "tail"
  const follow = params.follow === true;
  await streamTail(res, sessionId, follow);
});

/** Resolve the `--lines` param to a positive integer, defaulting to 200. */
function parseLines(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SNAPSHOT_LINES;
  return Math.floor(n);
}

/**
 * Stream a terminal's new output to the response as plain text. `--follow`
 * keeps the connection open until the client disconnects; otherwise the stream
 * ends after `TAIL_IDLE_MS` with no new output.
 */
async function streamTail(res: Response, sessionId: string, follow: boolean): Promise<void> {
  const controller = new AbortController();
  const iterable = ptyManager.tail(sessionId, controller.signal);
  if (!iterable) {
    res.status(404).json({ ok: false, error: "Terminal is no longer open" });
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  let idleTimer: NodeJS.Timeout | null = null;
  const resetIdle = () => {
    if (follow) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), TAIL_IDLE_MS);
  };
  res.on("close", () => controller.abort());
  resetIdle();

  try {
    for await (const chunk of iterable) {
      if (res.writableEnded) break;
      res.write(chunk);
      resetIdle();
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (!res.writableEnded) res.end();
  }
}
