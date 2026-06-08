import { contextBridge, ipcRenderer } from "electron";

import type {
  ControllerBridge,
  ControllerCheckResult,
  ControllerStatus,
} from "../shared/controller.js";

const statusListeners = new Set<(status: ControllerStatus) => void>();

ipcRenderer.on("controller:status", (_event, status: ControllerStatus) => {
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
