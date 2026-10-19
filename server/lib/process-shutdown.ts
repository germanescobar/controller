import { killAllMonitorsNow } from "./monitors.js";
import { stopAllSessionRuntimes } from "./session-runtime.js";

type ShutdownProcess = Pick<
  NodeJS.Process,
  "pid" | "once" | "removeAllListeners" | "kill"
>;

const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Reap isolated agent and monitor process groups on both orderly exits and
 * termination signals. Both run detached from the server's process group, so
 * a terminal SIGINT never reaches them directly. Installing a signal listener
 * replaces Node's default termination behavior, so remove it and re-send the
 * same signal after cleanup.
 */
export function installSessionRuntimeShutdownHandlers(
  target: ShutdownProcess = process,
  stopRuntimes: () => number = stopAllSessionRuntimes,
  stopMonitors: () => number = killAllMonitorsNow
): void {
  const stopAll = (): void => {
    stopRuntimes();
    stopMonitors();
  };

  target.once("exit", stopAll);

  for (const signal of TERMINATION_SIGNALS) {
    target.once(signal, () => {
      stopAll();
      target.removeAllListeners(signal);
      target.kill(target.pid, signal);
    });
  }
}
