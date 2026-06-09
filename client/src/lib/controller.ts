export type {
  ControllerBridge,
  ControllerCheckResult,
  ControllerStatus,
} from "../../../shared/controller.ts";

import type { ControllerBridge } from "../../../shared/controller.ts";

declare global {
  interface Window {
    controller?: ControllerBridge;
  }
}

export function getController(): ControllerBridge {
  if (typeof window === "undefined" || !window.controller) {
    throw new Error("Controller bridge is not available");
  }
  return window.controller;
}

export function isControllerAvailable(): boolean {
  return typeof window !== "undefined" && window.controller !== undefined;
}
