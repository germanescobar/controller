import express from "express";
import cors from "cors";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { projectsRouter } from "./routes/projects.js";
import { sessionsRouter } from "./routes/sessions.js";
import { worktreesRouter } from "./routes/worktrees.js";
import { eventsRouter } from "./routes/events.js";
import { modelsRouter } from "./routes/models.js";
import { apiKeysRouter } from "./routes/api-keys.js";
import { agentsRouter } from "./routes/agents.js";
import { skillsRouter } from "./routes/skills.js";
import { getAvailableAgentProviders } from "./lib/agents.js";
import { listSessionRuntimes } from "./lib/session-runtime.js";
import { getProject } from "./lib/projects.js";
import { resolveWorktree } from "./lib/worktrees.js";
import { ptyManager } from "./lib/pty-manager.js";
import { buildScriptEnv } from "./lib/project-scripts.js";
import { restoreLoginShellPath } from "./lib/shell-env.js";
import { previewBrowserBridge } from "./lib/preview-browser.js";
import { browserRouter } from "./routes/browser.js";
import { integrationsRouter } from "./routes/integrations.js";
import { unifiedSkillsRouter } from "./routes/unified-skills.js";
import { installManagedSkills } from "./lib/managed-skills.js";
import { installControllerCli, controllerCliInstalledPath } from "./lib/controller-cli.js";
import { migrateLegacyHomeIfNeeded } from "./lib/paths.js";

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
app.use("/api/projects", eventsRouter);
app.use("/api/models", modelsRouter);
app.use("/api/api-keys", apiKeysRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/agents", skillsRouter);
app.use("/api/browser", browserRouter);
app.use("/api/integrations", integrationsRouter);
app.use("/api", unifiedSkillsRouter);

// Available agent providers (installed AND enabled). Kept for the session
// picker and the Electron health check; richer status lives at /api/agents.
app.get("/api/agent-providers", async (_req, res) => {
  const providers = (await getAvailableAgentProviders()).map((p) => ({ id: p.id, name: p.name }));
  res.json(providers);
});

// Bulk session runtime snapshot — replaces the per-session /runtime polling
// the sidebar and SessionView were doing. One request returns the active
// state for every session currently known to the runtime map.
app.get("/api/runtimes", (_req, res) => {
  res.json({ sessions: listSessionRuntimes() });
});

const shouldServeClient =
  process.env.SERVE_CLIENT_DIST === "1" || process.env.NODE_ENV === "production";
const clientDistDir =
  process.env.CLIENT_DIST_DIR ?? path.resolve(process.cwd(), "dist/client");
const clientIndexPath = path.join(clientDistDir, "index.html");

if (shouldServeClient && fs.existsSync(clientIndexPath)) {
  app.use(express.static(clientDistDir));
  app.get(/^(?!\/api\/|\/ws\/).*/, (_req, res) => {
    res.sendFile(clientIndexPath);
  });
}

const server = http.createServer(app);

// Route WebSocket upgrades explicitly. Multiple `WebSocketServer({ server, path })`
// instances attach independent upgrade listeners to the same HTTP server; a
// non-matching listener can still write a 400 after the matching one accepts,
// corrupting the stream with an invalid frame.
const terminalWss = new WebSocketServer({ noServer: true });

// WebSocket server that lets the renderer register the preview pane it owns so
// the browser bridge can forward agent commands to the visible `<webview>`.
const previewBrowserWss = new WebSocketServer({ noServer: true });
previewBrowserWss.on("connection", (ws: WebSocket) => {
  previewBrowserBridge.handleConnection(ws);
});

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname === "/ws/terminal") {
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      terminalWss.emit("connection", ws, req);
    });
    return;
  }
  if (pathname === "/ws/preview-browser") {
    previewBrowserWss.handleUpgrade(req, socket, head, (ws) => {
      previewBrowserWss.emit("connection", ws, req);
    });
    return;
  }
  socket.destroy();
});

const DEFAULT_TERMINAL_ID = "default";

function normalizeTerminalId(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_TERMINAL_ID;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_TERMINAL_ID;
  return /^[a-zA-Z0-9._-]+$/.test(trimmed) ? trimmed : DEFAULT_TERMINAL_ID;
}

terminalWss.on("connection", (ws: WebSocket) => {
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

// In a packaged Electron build launched from Finder/Dock the inherited PATH is
// minimal, so agent CLIs (and the node their shebangs need) fail to spawn.
// Restore the login-shell PATH before accepting requests. Skipped in dev,
// where the terminal PATH is already inherited.
async function start(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    await restoreLoginShellPath();
  }
  // Move any legacy `~/coding-orchestrator` state into the platform-default
  // home (issue #223). Idempotent and silent on subsequent boots.
  await migrateLegacyHomeIfNeeded().catch((error: unknown) => {
    console.error("Failed to migrate legacy orchestrator home:", error);
  });
  // Sync managed skills (browser, controller-scripts, etc.) into each agent's
  // user skills home so they are available across Anita, Codex, and Claude.
  await installManagedSkills().catch((error: unknown) => {
    console.error("Failed to install managed skills:", error);
  });
  // Install the CLI to a stable absolute path and publish the server URL, so
  // agents can reach it without depending on PATH or inherited env vars.
  try {
    await installControllerCli();
    console.log(`controller CLI ready at ${controllerCliInstalledPath()}`);
  } catch (error) {
    console.error("Failed to install controller CLI:", error);
  }
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

void start();
