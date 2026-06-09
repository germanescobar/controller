import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  ipcMain,
} from "electron";
import path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CLIENT_PORT = 4500;
const MAX_PORT_SEARCH_OFFSET = 100;

// Mark the start of the main process so every log line can be prefixed
// with elapsed time. Helpful for diagnosing slow first-launch flows where
// macOS Gatekeeper / code-sign verification can take 30+ seconds before
// any of our code runs.
const PROCESS_START_MS = Date.now();
function elapsed(): string {
  return `+${Date.now() - PROCESS_START_MS}ms`;
}
function logWithTime(...args: unknown[]): void {
  console.log(`[controller ${elapsed()}]`, ...args);
}
function warnWithTime(...args: unknown[]): void {
  console.warn(`[controller ${elapsed()}]`, ...args);
}
function errorWithTime(...args: unknown[]): void {
  console.error(`[controller ${elapsed()}]`, ...args);
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : fallback;
}

function getDevUrl(): string {
  const port = parsePort(process.env.VITE_DEV_SERVER_PORT, DEFAULT_CLIENT_PORT);
  return `http://localhost:${port}`;
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`Server responded with ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timed out waiting for Coding Orchestrator backend at ${url}: ${String(lastError)}`
  );
}

function tryBindPort(
  port: number,
  host: string,
  timeoutMs = 1000
): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    let settled = false;
    const finish = (value: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      probe.removeAllListeners();
      console.log(
        `[controller ${elapsed()}] tryBindPort(${port}, ${host}) -> ${value} (${reason})`
      );
      // Resolve immediately; close the probe in the background. Waiting
      // for the close callback can hang the Promise indefinitely on some
      // macOS / network-stack edge cases.
      resolve(value);
      try {
        probe.close();
      } catch {
        // Ignore close errors — we've already resolved.
      }
    };
    probe.once("error", (err) => finish(false, `error: ${err.message}`));
    probe.once("listening", () => finish(true, "listening"));
    setTimeout(() => finish(false, "timeout"), timeoutMs);
    probe.listen(port, host);
  });
}

// Returns true only if the port is bindable on the wildcard address. On
// macOS, the default Node `net.Server.listen(port)` (no host) binds to
// `::` with IPV6_V6ONLY=0, which conflicts with anything on any
// interface — including processes bound to a specific external IP
// (e.g. `192.168.1.5:4500`) and processes bound to `0.0.0.0:4500`.
//
// Probing only loopback (127.0.0.1 and ::1) yields false positives: a
// process on a specific external IP doesn't block our loopback bind, but
// it WOULD block the Express server's later `listen(PORT)` call (which
// defaults to all interfaces), so the welcome screen would happily
// approve a port that's already serving someone else.
async function isPortFree(port: number): Promise<boolean> {
  return tryBindPort(port, "::");
}

async function checkPortAvailable(
  port: number
): Promise<{ available: boolean; suggestion?: number; error?: string }> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { available: false, error: "Port out of range" };
  }
  if (await isPortFree(port)) {
    return { available: true };
  }
  for (let offset = 1; offset <= MAX_PORT_SEARCH_OFFSET; offset += 1) {
    const candidate = port + offset;
    if (candidate > 65535) break;
    if (await isPortFree(candidate)) {
      return { available: false, suggestion: candidate };
    }
  }
  return { available: false, error: "No free port found nearby" };
}

type ControllerStatus =
  | { state: "starting"; port: number }
  | { state: "listening"; port: number }
  | { state: "error"; port?: number; message: string };

let mainWindow: BrowserWindow | null = null;

function broadcastStatus(status: ControllerStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send("controller:status", status);
  }
}

async function startProductionServer(port: number): Promise<string> {
  const appPath = app.getAppPath();
  const clientDistDir = path.join(appPath, "dist/client");
  const serverEntry = path.join(appPath, "dist/server/index.js");

  process.env.PORT = String(port);
  process.env.CLIENT_DIST_DIR = clientDistDir;
  process.env.SERVE_CLIENT_DIST = "1";
  process.env.NODE_ENV = "production";

  broadcastStatus({ state: "starting", port });

  await import(pathToFileURL(serverEntry).href);

  const url = `http://localhost:${port}`;
  await waitForServer(`${url}/api/agent-providers`);
  broadcastStatus({ state: "listening", port });
  return url;
}

function getPreloadPath(): string {
  // After the build, the main, preload, and welcome assets all live in
  // dist/electron/ relative to the packaged app root.
  return path.join(__dirname, "preload.js");
}

function getWelcomeHtmlPath(): string {
  return path.join(__dirname, "welcome.html");
}

function registerContextMenu(win: BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params) => {
    const template: MenuItemConstructorOptions[] = [];

    if (params.isEditable) {
      template.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll", enabled: params.editFlags.canSelectAll }
      );
    } else if (params.selectionText.trim().length > 0) {
      template.push({ role: "copy" });
    }

    if (!app.isPackaged) {
      if (template.length > 0) {
        template.push({ type: "separator" });
      }
      template.push({
        label: "Inspect Element",
        click: () => {
          win.webContents.inspectElement(params.x, params.y);
        },
      });
    }

    if (template.length === 0) return;

    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

interface CreateWindowOptions {
  loadUrl?: string;
  loadFile?: string;
  show?: boolean;
}

async function createWindow(options: CreateWindowOptions): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "Coding Orchestrator",
    show: options.show ?? true,
    backgroundColor: "#0b0b0d",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Sandboxed preloads run in a CommonJS context regardless of the
      // project's "type": "module" setting, so an ESM preload fails to
      // load with "Cannot use import statement outside a module". The
      // strong isolation we need still comes from contextIsolation +
      // nodeIntegration: false + the minimal contextBridge surface in
      // electron/preload.ts.
      sandbox: false,
      preload: getPreloadPath(),
    },
  });

  registerContextMenu(win);
  attachErrorReporting(win);
  logWithTime(
    `BrowserWindow created (loadFile=${options.loadFile ?? "none"}, loadUrl=${options.loadUrl ?? "none"})`
  );

  if (options.loadFile) {
    logWithTime(`loadFile start: ${options.loadFile}`);
    await win.loadFile(options.loadFile);
    logWithTime(`loadFile resolved`);
  } else if (options.loadUrl) {
    logWithTime(`loadURL start: ${options.loadUrl}`);
    await win.loadURL(options.loadUrl);
    logWithTime(`loadURL resolved`);
  } else {
    throw new Error("createWindow requires either loadUrl or loadFile");
  }

  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: "detach" });
  }

  return win;
}

function attachErrorReporting(win: BrowserWindow): void {
  win.webContents.on("did-start-loading", () => {
    logWithTime(`did-start-loading`);
  });
  win.webContents.on("did-finish-load", () => {
    logWithTime(`did-finish-load`);
  });
  win.webContents.on("dom-ready", () => {
    logWithTime(`dom-ready`);
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    errorWithTime(
      `webContents did-fail-load (${errorCode} ${errorDescription}) for ${validatedURL}`
    );
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    errorWithTime(
      `render process gone: reason=${details.reason} exitCode=${details.exitCode}`
    );
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    errorWithTime(`preload error in ${preloadPath}:`, error);
  });
  win.webContents.on("console-message", (_event, level, message, line, source) => {
    const tag = level >= 2 ? "error" : level === 1 ? "warn" : "log";
    const prefix = `[controller:renderer ${elapsed()}] ${source}:${line}`;
    if (level >= 2) console.error(prefix, message);
    else if (level === 1) console.warn(prefix, message);
    else console.log(prefix, message);
  });
}

async function openWelcomeWindow(): Promise<BrowserWindow> {
  const win = await createWindow({
    loadFile: getWelcomeHtmlPath(),
    show: true,
  });
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

async function openMainAppWindow(loadUrl: string): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(loadUrl);
    return mainWindow;
  }
  const win = await createWindow({ loadUrl });
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

function registerIpcHandlers(): void {
  ipcMain.handle("controller:check-port", async (_event, port: unknown) => {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return { available: false, error: "Port out of range" };
    }
    logWithTime(`check-port ${parsed}`);
    const result = await checkPortAvailable(parsed);
    logWithTime(`check-port ${parsed} ->`, result);
    return result;
  });

  ipcMain.handle("controller:start-server", async (_event, port: unknown) => {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error("Port out of range");
    }
    logWithTime(`start-server ${parsed}`);
    try {
      const url = await startProductionServer(parsed);
      // Replace the welcome window with the main app shell. The renderer
      // also calls `navigateToApp`, but doing it from the main process makes
      // the transition robust if the renderer misses the IPC reply.
      await openMainAppWindow(url);
      return { port: parsed, url };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcastStatus({ state: "error", port: parsed, message });
      throw err;
    }
  });

  ipcMain.on("controller:show-window", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.show();
  });

  ipcMain.on("controller:quit", () => {
    app.quit();
  });
}

process.on("uncaughtException", (error) => {
  errorWithTime("uncaughtException:", error);
});

process.on("unhandledRejection", (reason) => {
  errorWithTime("unhandledRejection:", reason);
});

app.whenReady().then(async () => {
  logWithTime("app ready");
  registerIpcHandlers();
  logWithTime("ipc handlers registered");

  try {
    if (!app.isPackaged) {
      logWithTime("dev mode, opening dev URL");
      await createWindow({ loadUrl: getDevUrl() });
    } else {
      logWithTime("packaged mode, opening welcome window");
      await openWelcomeWindow();
      logWithTime("welcome window opened");
    }
  } catch (error) {
    errorWithTime("failed to open initial window:", error);
    await showStartupErrorWindow(error);
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (app.isPackaged) {
        void openWelcomeWindow();
      } else {
        void createWindow({ loadUrl: getDevUrl() });
      }
    }
  });
}).catch((error: unknown) => {
  errorWithTime("Failed to start Coding Orchestrator Electron shell:", error);
  app.quit();
});

async function showStartupErrorWindow(error: unknown): Promise<void> {
  const message = error instanceof Error ? `${error.message}\n\n${error.stack ?? ""}` : String(error);
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Controller failed to start</title>
<style>
  body { margin: 0; padding: 32px; background: #0b0b0d; color: #f3f3f5;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; line-height: 1.5; }
  h1 { font-size: 16px; margin: 0 0 12px; color: #ef4444; }
  pre { white-space: pre-wrap; word-break: break-word; background: #15151a;
        border: 1px solid #2a2a31; border-radius: 8px; padding: 16px; font-size: 12px; }
</style></head><body>
<h1>Controller failed to start</h1>
<pre>${escapeHtml(message)}</pre>
</body></html>`;
  const errorWin = new BrowserWindow({
    width: 720,
    height: 480,
    title: "Controller failed to start",
    backgroundColor: "#0b0b0d",
  });
  attachErrorReporting(errorWin);
  await errorWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
