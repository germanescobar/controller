import { contextBridge, ipcRenderer } from "electron";

import type {
  ControllerBridge,
  ControllerCheckResult,
  ControllerStatus,
} from "../shared/controller.js";

const statusListeners = new Set<(status: ControllerStatus) => void>();
// Cached so getStatus() can return synchronously, which is what the
// StatusBar needs on mount to avoid flashing "Connecting...".
let latestStatus: ControllerStatus | null = null;

ipcRenderer.on("controller:status", (_event, status: ControllerStatus) => {
  console.log(
    `[controller:preload] received controller:status -> ${JSON.stringify(status)}`
  );
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
  checkPort: (port) => {
    console.log(`[controller:preload] checkPort(${port})`);
    return ipcRenderer.invoke(
      "controller:check-port",
      port
    ) as Promise<ControllerCheckResult>;
  },
  startServer: (port) => {
    console.log(`[controller:preload] startServer(${port})`);
    return ipcRenderer.invoke("controller:start-server", port) as Promise<{
      port: number;
      url: string;
    }>;
  },
  onStatus: (cb) => {
    statusListeners.add(cb);
    return () => {
      statusListeners.delete(cb);
    };
  },
  getStatus: () => {
    console.log(`[controller:preload] getStatus() -> ${JSON.stringify(latestStatus)}`);
    return latestStatus;
  },
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
