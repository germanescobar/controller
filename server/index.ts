import express from "express";
import cors from "cors";
import http from "node:http";
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

const app = express();
app.use(cors());
app.use(express.json());

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

const server = http.createServer(app);

// WebSocket server for terminal connections
const wss = new WebSocketServer({ server, path: "/ws/terminal" });

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
      const projectId = msg.projectId as string;
      const worktreeIdParam = msg.worktreeId as string | undefined;
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

      ptyKey = `${projectId}:${worktree.id}`;
      const result = ptyManager.getOrCreate(ptyKey, worktree.path);

      if (result.error) {
        ws.send(JSON.stringify({ type: "error", message: `Failed to spawn terminal: ${result.error}` }));
        return;
      }

      // Send buffered output so the terminal restores its state
      if (result.buffer) {
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
    }
  });

  ws.on("close", () => {
    unsubscribe?.();
  });
});

const PORT = 3100;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
