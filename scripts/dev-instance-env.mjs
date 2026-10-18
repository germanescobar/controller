/* Classify source servers independently of the shell's inherited env. */
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PROBE_TIMEOUT_MS = 1000;

export async function isControllerServerAlive(serverUrl, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/agent-providers`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function controllerHome(env) {
  if (env.CONTROLLER_HOME?.trim()) return env.CONTROLLER_HOME.trim();
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Controller");
  }
  if (process.platform === "linux") {
    return path.join(env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state"), "Controller");
  }
  return path.join(os.homedir(), "coding-orchestrator");
}

async function runtimeUrl(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return typeof value.serverUrl === "string" ? value.serverUrl : null;
  } catch {
    return null;
  }
}

/** Find an already running owner of shared schedules, wakes and goals. */
export async function hasLiveController(env, probe = isControllerServerAlive) {
  const home = controllerHome(env);
  const urls = [env.CONTROLLER_SERVER_URL?.trim(), await runtimeUrl(path.join(home, "controller-runtime.json"))];
  try {
    for (const entry of await readdir(path.join(home, "dev"), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        urls.push(await runtimeUrl(path.join(home, "dev", entry.name, "controller-runtime.json")));
      }
    }
  } catch { /* No dev runtimes yet. */ }
  if ((await Promise.all([...new Set(urls.filter(Boolean))].map((url) => probe(url)))).some(Boolean)) {
    return true;
  }
  // Electron walks up to 100 ports from 4500 when its preferred port is busy.
  // This also recovers when an old dev server left the shared runtime stale.
  const appPorts = Array.from({ length: 101 }, (_, offset) => `http://localhost:${4500 + offset}`);
  return (await Promise.all(appPorts.map((url) => probe(url)))).some(Boolean);
}

export async function devServerBaseEnv(env = process.env, probe = isControllerServerAlive) {
  const next = { ...env };
  delete next.CONTROLLER_SERVER_URL;
  delete next.CONTROLLER_SESSION_ID;
  delete next.CONTROLLER_SHARED_STATE_SECONDARY;
  // Every checkout must keep its CLI and runtime away from the packaged app.
  next.CONTROLLER_DEV_INSTANCE = "1";
  if (await hasLiveController(env, probe)) next.CONTROLLER_SHARED_STATE_SECONDARY = "1";
  return next;
}
