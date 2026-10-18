/* Classify source servers independently of the shell's inherited env. */
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PROBE_TIMEOUT_MS = 1000;

export function controllerHomeId(home) {
  const resolved = path.resolve(home);
  let identity;
  try {
    const stats = statSync(resolved, { bigint: true });
    if (!stats.isDirectory()) throw new Error(`Controller home is not a directory: ${resolved}`);
    identity = stats.ino > 0n
      ? `inode:${stats.dev}:${stats.ino}`
      : `path:${realpathSync.native(resolved)}`;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const missing = [];
    let ancestor = resolved;
    for (;;) {
      try {
        identity = `path:${path.join(realpathSync.native(ancestor), ...missing)}`;
        break;
      } catch (ancestorError) {
        if (ancestorError?.code !== "ENOENT") throw ancestorError;
        missing.unshift(path.basename(ancestor));
        ancestor = path.dirname(ancestor);
      }
    }
  }
  return createHash("sha256").update(identity).digest("hex");
}

/** Null means this server is unreachable or predates home identity support. */
export async function probeControllerHome(serverUrl, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/instance`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body.homeId === "string" ? body.homeId : null;
  } catch {
    return null;
  }
}

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
export async function hasLiveController(
  env,
  probe = probeControllerHome,
  legacyProbe = isControllerServerAlive,
) {
  const home = controllerHome(env);
  const expectedHomeId = controllerHomeId(home);
  const sharedRuntimeUrl = await runtimeUrl(path.join(home, "controller-runtime.json"));
  const urls = [env.CONTROLLER_SERVER_URL?.trim(), sharedRuntimeUrl];
  try {
    for (const entry of await readdir(path.join(home, "dev"), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        urls.push(await runtimeUrl(path.join(home, "dev", entry.name, "controller-runtime.json")));
      }
    }
  } catch { /* No dev runtimes yet. */ }
  const knownUrls = [...new Set(urls.filter(Boolean))];
  const identities = await Promise.all(knownUrls.map((url) => probe(url)));
  if (identities.includes(expectedHomeId)) {
    return true;
  }
  // Older packaged apps have no identity endpoint. Only the exact URL
  // published inside this home is trusted as a legacy binding.
  const runtimeIndex = knownUrls.indexOf(sharedRuntimeUrl);
  if (sharedRuntimeUrl && identities[runtimeIndex] === null && (await legacyProbe(sharedRuntimeUrl))) {
    return true;
  }
  // Electron walks up to 100 ports from 4500 when its preferred port is busy.
  // An unrelated Controller may occupy any one of them, so require identity.
  const appPorts = Array.from({ length: 101 }, (_, offset) => `http://localhost:${4500 + offset}`);
  return (await Promise.all(appPorts.map((url) => probe(url)))).includes(expectedHomeId);
}

export async function devServerBaseEnv(
  env = process.env,
  probe = probeControllerHome,
  legacyProbe = isControllerServerAlive,
) {
  const next = { ...env };
  delete next.CONTROLLER_SERVER_URL;
  delete next.CONTROLLER_SESSION_ID;
  delete next.CONTROLLER_SHARED_STATE_SECONDARY;
  // Every checkout must keep its CLI and runtime away from the packaged app.
  next.CONTROLLER_DEV_INSTANCE = "1";
  if (await hasLiveController(env, probe, legacyProbe)) next.CONTROLLER_SHARED_STATE_SECONDARY = "1";
  return next;
}
