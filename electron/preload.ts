import { contextBridge, ipcRenderer } from "electron";

import type {
  ControllerBridge,
  ControllerCheckResult,
  PreviewUrlCheckResult,
  ControllerStatus,
} from "../shared/controller.js";

const statusListeners = new Set<(status: ControllerStatus) => void>();
// Cached so getStatus() can return synchronously, which is what the
// StatusBar needs on mount to avoid flashing "Connecting...".
let latestStatus: ControllerStatus | null = null;

ipcRenderer.on("controller:status", (_event, status: ControllerStatus) => {
  latestStatus = status;
  for (const listener of statusListeners) {
    try {
      listener(status);
    } catch (err) {
      console.error("controller:status listener threw:", err);
    }
  }
});

const bridge: ControllerBridge = {
  isElectron: true,
  checkPort: (port) =>
    ipcRenderer.invoke(
      "controller:check-port",
      port
    ) as Promise<ControllerCheckResult>,
  startServer: (port) =>
    ipcRenderer.invoke("controller:start-server", port) as Promise<{
      port: number;
      url: string;
    }>,
  onStatus: (cb) => {
    statusListeners.add(cb);
    return () => {
      statusListeners.delete(cb);
    };
  },
  getStatus: () => {
    if (latestStatus !== null) return latestStatus;
    // Fall back to a synchronous IPC call so the very first render of
    // the StatusBar sees the current state. sendSync is deprecated in
    // newer Electron, but it's still the only way to read state
    // synchronously from the renderer. The cache above is hot in the
    // common case (renderer mounts after the main process has already
    // broadcast), so this is a rare path.
    return ipcRenderer.sendSync("controller:get-status") as
      | ControllerStatus
      | null;
  },
  validatePreviewUrl: (url, projectRoot) =>
    ipcRenderer.invoke(
      "controller:validate-preview-url",
      url,
      projectRoot
    ) as Promise<PreviewUrlCheckResult>,
  navigateToApp: (url) => {
    window.location.href = url;
  },
  showWindow: () => {
    ipcRenderer.send("controller:show-window");
  },
  quit: () => {
    ipcRenderer.send("controller:quit");
  },
};

contextBridge.exposeInMainWorld("controller", bridge);
