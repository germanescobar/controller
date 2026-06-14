import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  ipcMain,
  session as electronSession,
  type Session,
  type WebContents,
} from "electron";
import path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CLIENT_PORT = 4500;
const MAX_PORT_SEARCH_OFFSET = 100;
const PREVIEW_PARTITION = "controller-preview";

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

function isLocalhostUrl(input: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#].*)?$/i.test(input);
}

function looksLikeRelativeProjectPath(input: string): boolean {
  return (
    input.startsWith("./") ||
    input.startsWith("../") ||
    input.includes("/") ||
    input.includes("\\")
  );
}

function hasUrlScheme(input: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(input);
}

function normalizePreviewUrl(input: string, projectRoot?: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a URL to preview");

  if (isLocalhostUrl(trimmed)) {
    return `http://${trimmed}`;
  }

  if (path.isAbsolute(trimmed)) {
    return pathToFileURL(trimmed).toString();
  }

  if (hasUrlScheme(trimmed)) {
    return new URL(trimmed).toString();
  }

  if (projectRoot && looksLikeRelativeProjectPath(trimmed)) {
    return pathToFileURL(path.resolve(projectRoot, trimmed)).toString();
  }

  return new URL(trimmed).toString();
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function validatePreviewUrl(
  input: string,
  projectRoot?: string
): { allowed: boolean; url?: string; error?: string } {
  let url: URL;
  try {
    url = new URL(normalizePreviewUrl(input, projectRoot));
  } catch {
    return { allowed: false, error: "Enter a valid web or project file URL" };
  }

  if (url.protocol === "http:" || url.protocol === "https:") {
    return { allowed: true, url: url.toString() };
  }

  if (url.protocol === "file:") {
    if (!projectRoot) {
      return { allowed: false, error: "Project files can only be previewed after the worktree is loaded" };
    }
    let filePath: string;
    try {
      filePath = fileURLToPath(url);
    } catch {
      return { allowed: false, error: "Invalid file URL" };
    }
    if (!isPathInside(projectRoot, filePath)) {
      return { allowed: false, error: "File previews must stay inside the active project" };
    }
    return { allowed: true, url: url.toString() };
  }

  return { allowed: false, error: "Only web URLs and project file previews are allowed" };
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
): Promise<{ bound: boolean; reason: string }> {
  return new Promise((resolve) => {
    const probe = createServer();
    let settled = false;
    const finish = (bound: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      probe.removeAllListeners();
      console.log(
        `[controller ${elapsed()}] tryBindPort(${port}, ${host}) -> ${bound ? "free" : "in-use"} (${reason})`
      );
      // Resolve immediately; close the probe in the background. Waiting
      // for the close callback can hang the Promise indefinitely on some
      // macOS / network-stack edge cases.
      resolve({ bound, reason });
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

// Returns true only if the port is bindable on BOTH the IPv4 wildcard
// (0.0.0.0) and the IPv6 wildcard (::). On macOS the kernel tracks
// IPv4 and IPv6 socket bindings separately, so an IPv4-only bind to
// `0.0.0.0:4500` does NOT conflict with an IPv6-only bind to `::` —
// but the Express server's later `listen(PORT)` will pick whichever
// family the kernel routes the new connection through, and fail with
// EADDRINUSE. Probing both families covers Vite (which binds 0.0.0.0
// on macOS) and anything bound to a specific external IP.
async function isPortFree(port: number): Promise<boolean> {
  const [ipv4, ipv6] = await Promise.all([
    tryBindPort(port, "0.0.0.0"),
    tryBindPort(port, "::"),
  ]);
  return ipv4.bound && ipv6.bound;
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

// Tracks the Express server we most recently started in this process.
// Cleared when the server is no longer reachable (so we don't hand the
// renderer a stale URL on next activate).
let activeServer: { port: number; url: string } | null = null;

// Last status we broadcast. Kept here so newly-opened windows can pick
// up the current state via controller:get-status (the broadcast runs
// before the main app window exists, so it has no listeners).
let latestStatus: ControllerStatus | null = null;

function broadcastStatus(status: ControllerStatus): void {
  latestStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send("controller:status", status);
  }
}

// Returns true if the previously-started server is still reachable on its
// port. We probe with a short-timeout fetch against the agent-providers
// endpoint (the same one the renderer uses) so a stuck or crashed child
// process is detected.
async function isActiveServerAlive(): Promise<boolean> {
  if (!activeServer) return false;
  try {
    const res = await fetch(`${activeServer.url}/api/agent-providers`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
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
  activeServer = { port, url };
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
    title: "Controller",
    show: options.show ?? true,
    backgroundColor: "#0b0b0d",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
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

  if (options.loadFile) {
    await win.loadFile(options.loadFile);
  } else if (options.loadUrl) {
    await win.loadURL(options.loadUrl);
  } else {
    throw new Error("createWindow requires either loadUrl or loadFile");
  }

  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: "detach" });
  }

  return win;
}

function denyPreviewSessionPermissions(session: Session): void {
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    warnWithTime(`blocked preview permission request: ${permission}`);
    callback(false);
  });
}

function attachPreviewPartitionGuards(): void {
  denyPreviewSessionPermissions(electronSession.fromPartition(PREVIEW_PARTITION));
}

function blockPreviewPopups(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    warnWithTime(`blocked preview popup: ${url}`);
    return { action: "deny" };
  });
}

function attachPreviewWebviewGuards(contents: WebContents): void {
  blockPreviewPopups(contents);
  contents.on("will-attach-webview", (_event, webPreferences, params) => {
    const src = typeof params.src === "string" ? params.src : "";
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    delete webPreferences.preload;
    logWithTime(`preview webview attached: ${src || "(empty)"}`);
  });
  contents.on("did-attach-webview", (_event, webContents) => {
    blockPreviewPopups(webContents);
    denyPreviewSessionPermissions(webContents.session);
  });
}

function attachErrorReporting(win: BrowserWindow): void {
  win.webContents.on("did-finish-load", () => {
    // Re-send the current status to this window, since the original
    // broadcast may have happened before the window existed (e.g. when
    // startProductionServer finishes and then openMainAppWindow creates
    // a fresh BrowserWindow).
    if (latestStatus) {
      win.webContents.send("controller:status", latestStatus);
    }
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
  win.webContents.on("console-message", (event) => {
    const { level, message, lineNumber, sourceId } = event;
    // `level` is one of 'info' | 'warning' | 'error' | 'debug'.
    const isError = level === "error";
    const isWarn = level === "warning";
    const tag = isError ? "error" : isWarn ? "warn" : "log";
    const prefix = `[controller:renderer ${elapsed()}] ${sourceId}:${lineNumber}`;
    if (isError) console.error(prefix, message);
    else if (isWarn) console.warn(prefix, message);
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
  // Synchronous read of the latest known status. The renderer's
  // getStatus() uses this as a fallback when its cache is cold (which
  // happens whenever a new window mounts before the IPC broadcast
  // arrives).
  ipcMain.on("controller:get-status", (event) => {
    event.returnValue = latestStatus;
  });

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
      activeServer = null;
      broadcastStatus({ state: "error", port: parsed, message });
      throw err;
    }
  });

  ipcMain.handle(
    "controller:validate-preview-url",
    (_event, url: unknown, projectRoot: unknown) => {
      if (typeof url !== "string") {
        return { allowed: false, error: "URL must be a string" };
      }
      return validatePreviewUrl(
        url,
        typeof projectRoot === "string" && projectRoot.trim() ? projectRoot : undefined
      );
    }
  );

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
  attachPreviewPartitionGuards();
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() === "window") {
      attachPreviewWebviewGuards(contents);
    }
  });

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
    if (BrowserWindow.getAllWindows().length > 0) return;

    // Reopening after closing the last window (the macOS dock-icon path).
    // If we still have a live server from this session, just bring back
    // the main app window pointing at it — the user already picked a port
    // and the orphan Express process is still serving. Otherwise fall
    // back to the welcome screen.
    void (async () => {
      if (app.isPackaged && (await isActiveServerAlive())) {
        logWithTime(
          `activate: reusing active server on port ${activeServer!.port}`
        );
        await openMainAppWindow(activeServer!.url);
        return;
      }
      activeServer = null;
      if (app.isPackaged) {
        logWithTime("activate: no active server, opening welcome window");
        await openWelcomeWindow();
      } else {
        logWithTime("activate: dev mode, opening dev URL");
        await createWindow({ loadUrl: getDevUrl() });
      }
    })();
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
