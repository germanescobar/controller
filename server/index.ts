import express from "express";
import cors from "cors";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { projectsRouter } from "./routes/projects.js";
import { sessionsRouter } from "./routes/sessions.js";
import { worktreesRouter } from "./routes/worktrees.js";
import { modelsRouter } from "./routes/models.js";
import { apiKeysRouter } from "./routes/api-keys.js";
import { getAvailableAgentProviders } from "./lib/agents.js";
import { getProject } from "./lib/projects.js";
import { resolveWorktree } from "./lib/worktrees.js";
import { ptyManager } from "./lib/pty-manager.js";
import { buildScriptEnv } from "./lib/project-scripts.js";

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : fallback;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.use("/api/projects", projectsRouter);
app.use("/api/projects", worktreesRouter);
app.use("/api/projects", sessionsRouter);
app.use("/api/models", modelsRouter);
app.use("/api/api-keys", apiKeysRouter);

// Agent providers
app.get("/api/agent-providers", async (_req, res) => {
  const providers = (await getAvailableAgentProviders()).map((p) => ({ id: p.id, name: p.name }));
  res.json(providers);
});

const shouldServeClient =
  process.env.SERVE_CLIENT_DIST === "1" || process.env.NODE_ENV === "production";
const clientDistDir =
  process.env.CLIENT_DIST_DIR ?? path.resolve(process.cwd(), "dist/client");
const clientIndexPath = path.join(clientDistDir, "index.html");

if (shouldServeClient && fs.existsSync(clientIndexPath)) {
  app.use(express.static(clientDistDir));
  app.get(/^(?!\/api\/|\/ws\/terminal).*/, (_req, res) => {
    res.sendFile(clientIndexPath);
  });
}

const server = http.createServer(app);

// WebSocket server for terminal connections
const wss = new WebSocketServer({ server, path: "/ws/terminal" });
const DEFAULT_TERMINAL_ID = "default";

function normalizeTerminalId(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_TERMINAL_ID;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_TERMINAL_ID;
  return /^[a-zA-Z0-9._-]+$/.test(trimmed) ? trimmed : DEFAULT_TERMINAL_ID;
}

wss.on("connection", (ws: WebSocket) => {
  let ptyKey: string | null = null;
  let unsubscribe: (() => void) | null = null;

  ws.on("message", async (raw: Buffer) => {
    let msg: { type: string; [key: string]: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "attach") {
      unsubscribe?.();
      unsubscribe = null;

      const projectId = msg.projectId as string;
      const worktreeIdParam = msg.worktreeId as string | undefined;
      const terminalId = normalizeTerminalId(msg.terminalId);
      const replayBuffer = msg.replayBuffer !== false;
      if (!projectId) return;

      const project = await getProject(projectId);
      if (!project) {
        ws.send(JSON.stringify({ type: "error", message: "Project not found" }));
        return;
      }

      const worktree = await resolveWorktree(projectId, worktreeIdParam);
      if (!worktree) {
        ws.send(JSON.stringify({ type: "error", message: "Worktree not found" }));
        return;
      }

      ptyKey = `${projectId}:${worktree.id}:${terminalId}`;
      const result = ptyManager.getOrCreate(
        ptyKey,
        worktree.path,
        buildScriptEnv({ project, worktree })
      );

      if (result.error) {
        ws.send(JSON.stringify({ type: "error", message: `Failed to spawn terminal: ${result.error}` }));
        return;
      }

      // Send buffered output so the terminal restores its state
      if (replayBuffer && result.buffer) {
        ws.send(JSON.stringify({ type: "output", data: result.buffer }));
      }

      // Forward new PTY output to this WebSocket client
      unsubscribe = ptyManager.onData(ptyKey, (data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "output", data }));
        }
      });

      ws.send(JSON.stringify({ type: "attached" }));
    } else if (msg.type === "input" && ptyKey) {
      ptyManager.write(ptyKey, msg.data as string);
    } else if (msg.type === "resize" && ptyKey) {
      ptyManager.resize(ptyKey, msg.cols as number, msg.rows as number);
    } else if (msg.type === "close" && ptyKey) {
      unsubscribe?.();
      unsubscribe = null;
      ptyManager.kill(ptyKey);
      ws.send(JSON.stringify({ type: "closed" }));
      ptyKey = null;
      ws.close(1000);
    }
  });

  ws.on("close", () => {
    unsubscribe?.();
  });
});

const PORT = parsePort(process.env.PORT, 3100);
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
