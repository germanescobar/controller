/*
 * Decides whether a dev server (`npm run dev`) runs as a *dev instance* next
 * to a live Controller app, and builds the env it is spawned with.
 *
 * A dev instance shares the app's CONTROLLER_HOME (state files) but keeps
 * its CLI install and runtime file under `<CONTROLLER_HOME>/dev/`, and skips
 * the managed-skills install and the scheduler loops the app already owns
 * (see `isDevInstance` in server/lib/controller-cli.ts).
 *
 * Only a server started from inside a running app qualifies: the app stamps
 * CONTROLLER_SERVER_URL on every agent and terminal it spawns, so we require
 * that URL to be inherited *and* to answer. A standalone `npm run dev` (plain
 * terminal, or the app already closed) stays a regular instance, so it still
 * installs skills and runs schedules, wakes and goals.
 *
 * Kept in its own module so the decision is testable without spawning the
 * server.
 */

const PROBE_TIMEOUT_MS = 1000;

/** True when a Controller server answers at `serverUrl`. */
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

/**
 * Env for the dev server child. Always drops the inherited
 * CONTROLLER_SERVER_URL / CONTROLLER_SESSION_ID (they belong to the app and
 * must not leak into the dev server); sets CONTROLLER_DEV_INSTANCE=1 only
 * when the inherited URL points at a live app.
 */
export async function devServerBaseEnv(env = process.env, probe = isControllerServerAlive) {
  const appServerUrl = env.CONTROLLER_SERVER_URL?.trim();
  const next = { ...env };
  delete next.CONTROLLER_SERVER_URL;
  delete next.CONTROLLER_SESSION_ID;
  delete next.CONTROLLER_DEV_INSTANCE;
  if (appServerUrl && (await probe(appServerUrl))) {
    next.CONTROLLER_DEV_INSTANCE = "1";
  }
  return next;
}
