import type { ChildProcess } from "node:child_process";

export interface SessionRuntimeState {
  active: boolean;
  provider?: string;
  child?: ChildProcess;
}

const runtimes = new Map<string, SessionRuntimeState>();

export function markSessionActive(
  sessionId: string,
  runtime: Omit<SessionRuntimeState, "active"> = {}
) {
  runtimes.set(sessionId, { active: true, ...runtime });
}

export function markSessionInactive(sessionId: string) {
  const runtime = runtimes.get(sessionId);
  if (runtime) {
    runtimes.set(sessionId, { ...runtime, active: false, child: undefined });
    return;
  }
  runtimes.set(sessionId, { active: false });
}

export function getSessionRuntime(sessionId: string): SessionRuntimeState {
  return runtimes.get(sessionId) ?? { active: false };
}

export async function stopSessionRuntime(sessionId: string): Promise<void> {
  const runtime = runtimes.get(sessionId);
  if (!runtime?.active) {
    throw new Error("No active session runtime");
  }
  if (!runtime.child) {
    throw new Error("No stoppable process for this session");
  }

  const child = runtime.child;
  if (child.exitCode !== null || child.killed) {
    markSessionInactive(sessionId);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      child.off("exit", onExit);
      child.off("error", onError);
      markSessionInactive(sessionId);
      resolve();
    };

    const onExit = () => finish();
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      child.off("exit", onExit);
      child.off("error", onError);
      reject(error);
    };

    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 2000);

    child.once("exit", onExit);
    child.once("error", onError);

    const signalled = child.kill("SIGINT");
    if (!signalled) {
      finish();
    }
  });
}
