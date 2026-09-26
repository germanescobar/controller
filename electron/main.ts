import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  dialog,
  ipcMain,
  session as electronSession,
  type Session,
  type WebContents,
  shell,
} from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CLIENT_PORT = 4500;
const MAX_PORT_SEARCH_OFFSET = 100;
const PREVIEW_PARTITION = "controller-preview";

// Toggle for the preview-pane cert-verify bypass. Set by the
// `controller:set-preview-cert-policy` IPC handler when the agent passes
// `--insecure` to `controller browser open`, and reset by the next
// non-`--insecure` open (so the bypass is per-call, not sticky).
//
// We can't just call `setCertificateVerifyProc` on demand inside the IPC
// handler: in Electron the proc only takes effect if it's installed on
// the session before any webview starts using it. Once a webview has
// navigated through `controller-preview`, swapping the proc is a no-op —
// the next load still uses Chromium's default verifier and fails on
// self-signed loopback certs. Installing the proc eagerly at startup
// and reading this flag from inside the closure avoids that race
// entirely; the IPC handler is now a one-line flag flip.
//
// Known limitation: every preview pane shares the same
// `controller-preview` partition (see `PreviewBrowserPool.tsx`), so this
// flag is effectively process-wide. When two panes issue `open` calls
// that overlap — e.g. one starts an `--insecure` navigation and another
// pane performs a plain open before the cert handshake fires — the last
// IPC wins, and the earlier pane can lose (or gain) the bypass
// spuriously. A full fix (per-pane partitions, each with its own proc)
// is tracked in #325; this PR stays within the original #324 / #323
// scope and only fixes the eager-install race.
let previewCertBypassEnabled = false;

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

/**
 * Hard cap on the file size the Electron main process will read into
 * memory for a `setFiles` upload (issue #356 review, P2). The page's
 * own `max-file-size` attribute runs inside the webview *after* the
 * bytes have already been buffered here, so we need a backstop on the
 * host side: a multi-GB upload would otherwise allocate a `Buffer`
 * + base64 string + IPC payload + `executeJavaScript` payload, all
 * before the page got a chance to refuse. 100 MiB is well above what
 * any real "upload an artifact" workflow sends and well below what
 * would threaten the Electron process.
 */
const MAX_PREVIEW_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Read a file from disk for the agent-driven preview browser (issue #356).
 *
 * Mirrors `validateBrowserUrl` from the server-side policy: paths must be
 * inside the active worktree by default, with `allowOutside` as the
 * explicit opt-in. The server has already pre-checked the path before
 * the renderer asked for bytes; this is the final gate before the
 * bytes leave the sandboxed main process.
 *
 * Three review-driven guards sit in front of `fs.readFile`:
 *
 *  1. Symlink resolution — `realpath` runs on both `projectRoot` and
 *     the resolved target so a symlink in or out of the worktree
 *     cannot be used to bypass the boundary check.
 *  2. Size cap — `stat.size` is compared against `MAX_PREVIEW_FILE_BYTES`
 *     before any allocation, so a hostile 10 GiB path returns a
 *     structured error without buffering the file.
 *  3. Confirmation prompt — when `allowOutside` is true and the
 *     canonical target lands outside the worktree, a
 *     `dialog.showMessageBox` is shown modal to the requesting
 *     window. The bytes are only read when the user clicks
 *     "Allow"; "Deny" returns a structured rejection. This is the
 *     user-visible gate the CLI help text promises.
 *
 * The Electron `<webview>` guest page cannot read local files directly,
 * so the bytes cross the IPC boundary base64-encoded inside a single
 * `executeJavaScript` round-trip. The renderer wraps them in `File`
 * objects and assigns them to the target `<input type="file">` (or
 * synthesizes a drop event for a dropzone).
 */
async function readPreviewFile(
  event: { sender: Electron.WebContents },
  input: unknown,
  options: unknown
): Promise<{
  ok: boolean;
  path?: string;
  name?: string;
  type?: string;
  size?: number;
  contentBase64?: string;
  scope?: "inside-project" | "outside-project" | "invalid";
  error?: string;
}> {
  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, error: "Path must be a non-empty string" };
  }
  const opts =
    options && typeof options === "object"
      ? (options as {
          projectRoot?: unknown;
          allowOutside?: unknown;
          // Optional CLI cwd so relative paths resolve against the
          // agent's shell, not the server's process (issue #356
          // review, P1).
          cwd?: unknown;
        })
      : {};
  const projectRoot =
    typeof opts.projectRoot === "string" && opts.projectRoot.trim()
      ? opts.projectRoot
      : undefined;
  const allowOutside = opts.allowOutside === true;
  const cwd =
    typeof opts.cwd === "string" && opts.cwd.trim() ? opts.cwd : undefined;
  let resolved: string;
  try {
    if (path.isAbsolute(input) || !cwd) {
      resolved = path.resolve(input);
    } else {
      resolved = path.resolve(cwd, input);
    }
  } catch {
    return { ok: false, error: "Could not resolve path" };
  }
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    return { ok: false, scope: "invalid", error: "File does not exist" };
  }
  if (!stat.isFile()) {
    return { ok: false, scope: "invalid", error: "Path is not a regular file" };
  }
  if (!projectRoot) {
    return {
      ok: false,
      error: "File uploads can only run from inside an active worktree",
    };
  }
  // (1) Canonicalize both sides. A symlink in-worktree that points
  // to /etc/passwd would otherwise be classified as inside-project
  // because the link itself is in-worktree.
  const canonicalRoot = await canonicalizeForBoundary(projectRoot);
  const canonicalResolved = await canonicalizeForBoundary(resolved);
  if (!isPathInside(canonicalRoot, canonicalResolved)) {
    if (!allowOutside) {
      return {
        ok: false,
        error:
          "File is outside the active worktree. Re-run with --allow-outside " +
          "to attach it; the Electron main process will surface a confirmation prompt " +
          "the user must approve before the file leaves the worktree boundary.",
      };
    }
    // (3) Confirmation prompt. The agent-supplied flag is not the
    // approval — the user is. Modal to the requesting window so the
    // dialog sits next to the page the file is about to enter.
    const win = BrowserWindow.fromWebContents(event.sender);
    const promptOptions: Electron.MessageBoxOptions = {
      type: "question",
      buttons: ["Deny", "Allow"],
      defaultId: 0,
      cancelId: 0,
      title: "Allow file upload outside the worktree?",
      message: `The agent is asking to attach a file outside the active worktree:\n\n${canonicalResolved}`,
      detail:
        `Size: ${formatBytes(stat.size)}\n` +
        `Worktree: ${canonicalRoot}\n\n` +
        "Choose Allow to attach the file to the preview, or Deny to leave the page unchanged.",
      noLink: true,
    };
    const choice = win
      ? await dialog.showMessageBox(win, promptOptions)
      : await dialog.showMessageBox(promptOptions);
    if (choice.response !== 1) {
      return {
        ok: false,
        scope: "outside-project",
        error: "User denied the out-of-worktree file upload",
      };
    }
  }
  // (2) Size cap before any allocation. The page's own max-file-size
  // attribute is enforced inside the webview, but it only runs after
  // the bytes are already buffered here.
  if (stat.size > MAX_PREVIEW_FILE_BYTES) {
    return {
      ok: false,
      scope: isPathInside(canonicalRoot, canonicalResolved)
        ? "inside-project"
        : "outside-project",
      error:
        `File is ${formatBytes(stat.size)}, which exceeds the host-side ` +
        `cap of ${formatBytes(MAX_PREVIEW_FILE_BYTES)}. ` +
        `Compress or split the file and try again.`,
    };
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(canonicalResolved);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not read file: ${message}` };
  }
  const scope = isPathInside(canonicalRoot, canonicalResolved)
    ? "inside-project"
    : "outside-project";
  const name = path.basename(canonicalResolved);
  // MIME: best-effort extension map. The renderer lets the page's own
  // `accept` filter override whatever we send — what we return is
  // just the value Chromium's `File` constructor will observe, so a
  // page that does `.type === 'image/png'` works on a .png without
  // sniffing the bytes. Unknown extensions fall back to
  // application/octet-stream, the same default Chromium uses when a
  // user picks a file with an unknown type in the OS picker.
  const type = mimeFromName(name);
  return {
    ok: true,
    path: canonicalResolved,
    name,
    type,
    size: bytes.byteLength,
    contentBase64: bytes.toString("base64"),
    scope,
  };
}

/** Async wrapper around `realpath` for the Electron main path
 * (the policy side uses the sync variant because it runs in the
 * server process). Returns the input unchanged on error so the
 * caller's downstream "does not exist" / "not a file" messages
 * still see the user-typed path. */
async function canonicalizeForBoundary(input: string): Promise<string> {
  try {
    return await fs.realpath(input);
  } catch {
    return input;
  }
}

/** Human-readable byte size for the confirmation prompt detail. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".html": "text/html",
  ".htm": "text/html",
};

function mimeFromName(name: string): string {
  const lower = name.toLowerCase();
  const idx = lower.lastIndexOf(".");
  if (idx <= 0) return "application/octet-stream";
  return MIME_BY_EXT[lower.slice(idx)] ?? "application/octet-stream";
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
  attachExternalLinkHandler(win.webContents);

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
  const session = electronSession.fromPartition(PREVIEW_PARTITION);
  denyPreviewSessionPermissions(session);
  // Install the cert-verify proc ONCE, before any webview touches the
  // session. See the `previewCertBypassEnabled` comment for why we can't
  // install it lazily inside the IPC handler — Electron only honors a
  // proc that was in place before the first connection.
  //
  // The proc is scoped to loopback hosts so the agent can reach a local
  // dev server with a self-signed cert without gaining the ability to
  // talk to an arbitrary external host without cert validation. External
  // requests return `-3` (Chromium's default verification result) rather
  // than `-2` ("fail"), so legitimate HTTPS subresources loaded by an
  // insecure-localhost page — a CDN script, font, or external API over
  // a valid cert — are still checked and accepted. Returning `-2` would
  // actively break those loads.
  session.setCertificateVerifyProc((request, callback) => {
    if (!previewCertBypassEnabled) {
      callback(-3);
      return;
    }
    const host = (request.hostname ?? "").toLowerCase();
    const isLoopback =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "::1";
    callback(isLoopback ? 0 : -3);
  });
}

function blockPreviewPopups(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    warnWithTime(`blocked preview popup: ${url}`);
    return { action: "deny" };
  });
}

// Electron 22+ denies `target="_blank"` requests by default. Without a
// setWindowOpenHandler, `window.open()` (and therefore every external
// link rendered by the app) is silently dropped — the status bar's
// Tailscale link and the transcript's external anchors never reach the
// user's browser. We forward http(s) URLs to the system default browser
// and mailto: URLs to the user's mail client, both via
// shell.openExternal, and deny anything else. Preview webviews override
// this with a stricter deny-all handler installed by
// attachPreviewWebviewGuards.
function attachExternalLinkHandler(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      warnWithTime(`ignoring window.open with non-URL: ${url}`);
      return { action: "deny" };
    }
    // Accept http(s) for the system browser and mailto: for the
    // user's mail client. Reject every other scheme (file:, data:,
    // javascript:, custom app schemes, …) — those would either
    // fail to open or constitute a security risk.
    const allowed = parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "mailto:";
    if (!allowed) {
      warnWithTime(`denied window.open with disallowed scheme: ${url}`);
      return { action: "deny" };
    }
    void shell.openExternal(parsed.toString()).catch((error) => {
      warnWithTime(`failed to open external URL ${url}:`, error);
    });
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

/**
 * Toggle the TLS-cert verification bypass on the preview pane's session.
 * Called from the renderer through the `controller:set-preview-cert-policy`
 * IPC handler when the agent passes `--insecure` to `controller browser open`.
 *
 * The actual cert-verify proc is installed eagerly at app startup by
 * `attachPreviewPartitionGuards` — once a webview has navigated through
 * `controller-preview`, calling `setCertificateVerifyProc` from the IPC
 * handler is a silent no-op and the next load still uses Chromium's default
 * verifier. Flipping the `previewCertBypassEnabled` flag here is enough:
 * the proc reads the flag on every verification and decides whether to
 * allow loopback certs.
 *
 * The bypass is intentionally scoped to localhost-shaped hosts so the agent
 * can reach a local dev server with a self-signed cert without gaining the
 * ability to talk to an arbitrary external host without cert validation.
 * External-host calls fall through to Chromium's default verifier and
 * continue to be rejected on TLS errors.
 */
function setPreviewCertPolicy(opts: unknown): { ok: boolean; error?: string } {
  if (opts === null) {
    previewCertBypassEnabled = false;
    return { ok: true };
  }
  if (!opts || typeof opts !== "object") {
    return { ok: false, error: "Cert-policy opts must be an object or null" };
  }
  previewCertBypassEnabled = (opts as { insecure?: unknown }).insecure === true;
  return { ok: true };
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

  ipcMain.handle(
    "controller:set-preview-cert-policy",
    (_event, opts: unknown) => setPreviewCertPolicy(opts)
  );

  ipcMain.handle(
    "controller:read-preview-file",
    async (event, input: unknown, options: unknown) => {
      // `event` is threaded through so the confirmation dialog can
      // be modal'd to the requesting window (issue #356 review, P1).
      return readPreviewFile(event, input, options);
    }
  );

  ipcMain.handle("controller:pick-directory", async (event) => {
    // Modal to the renderer that asked, so the picker feels attached
    // to the right window when the user has multiple windows open.
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "Select project directory",
      properties: ["openDirectory", "createDirectory"],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return null;
    const [first] = result.filePaths;
    return first ?? null;
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
