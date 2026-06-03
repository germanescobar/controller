import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CLIENT_PORT = 4500;
const DEFAULT_API_PORT = 3100;

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

function getBackendPort(): number {
  return parsePort(
    process.env.PORT ?? process.env.API_PORT ?? process.env.VITE_API_PORT,
    DEFAULT_API_PORT
  );
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

async function startProductionServer(port: number): Promise<string> {
  const appPath = app.getAppPath();
  const clientDistDir = path.join(appPath, "dist/client");
  const serverEntry = path.join(appPath, "dist/server/index.js");

  process.env.PORT = String(port);
  process.env.CLIENT_DIST_DIR = clientDistDir;
  process.env.SERVE_CLIENT_DIST = "1";
  process.env.NODE_ENV = "production";

  await import(pathToFileURL(serverEntry).href);

  const url = `http://localhost:${port}`;
  await waitForServer(`${url}/api/agent-providers`);
  return url;
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

async function createWindow(loadUrl: string): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "Coding Orchestrator",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  registerContextMenu(win);

  await win.loadURL(loadUrl);

  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: "detach" });
  }
}

app.whenReady().then(async () => {
  const loadUrl = app.isPackaged
    ? await startProductionServer(getBackendPort())
    : getDevUrl();

  await createWindow(loadUrl);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow(loadUrl);
    }
  });
}).catch((error: unknown) => {
  console.error("Failed to start Coding Orchestrator Electron shell:", error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
