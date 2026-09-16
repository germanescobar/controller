import { stopAllSessionRuntimes } from "./session-runtime.js";

type ShutdownProcess = Pick<
  NodeJS.Process,
  "pid" | "once" | "removeAllListeners" | "kill"
>;

const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Reap isolated agent process groups on both orderly exits and termination
 * signals. Installing a signal listener replaces Node's default termination
 * behavior, so remove it and re-send the same signal after cleanup.
 */
export function installSessionRuntimeShutdownHandlers(
  target: ShutdownProcess = process,
  stopRuntimes: () => number = stopAllSessionRuntimes
): void {
  target.once("exit", () => {
    stopRuntimes();
  });

  for (const signal of TERMINATION_SIGNALS) {
    target.once(signal, () => {
      stopRuntimes();
      target.removeAllListeners(signal);
      target.kill(target.pid, signal);
    });
  }
}
