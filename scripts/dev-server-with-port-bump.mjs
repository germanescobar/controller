#!/usr/bin/env node
/*
 * Spawns the Express dev server (`tsx watch server/index.ts`) with an
 * API port that is guaranteed to be free. Mirrors the packaged-app
 * behavior in `electron/main.ts` (tryBindPort → walk forward up to 100
 * ports), so `npm run dev` next to anything else holding 3102 (a stale
 * dev server, a stray node process) does not crash with EADDRINUSE.
 *
 * The bumped port is exported to the child via PORT / API_PORT /
 * VITE_API_PORT. The Vite dev server shares the same env (via
 * concurrently), so its /api proxy target lands on the same port
 * without any coordination step.
 *
 * If `.env.local` exists in the working directory, we load it first
 * so the port preference written by `.coding-orchestrator/setup.sh`
 * is honoured. Without this, calling `npm run dev` from a clean
 * shell (no exported `VITE_API_PORT`) would fall back to the
 * packaged-app default (3102) and the Vite proxy — which DOES read
 * `.env.local` via Vite's loadEnv — would point at a different port
 * and every request would 404 or hit the wrong backend.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const DEV_API_BASE_PORT = 3102;
const MAX_PORT_SEARCH_OFFSET = 100;
const BIND_TIMEOUT_MS = 1000;

function parseEnvPort(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}

/*
 * Minimal `.env.local` loader — `KEY=value` lines, comments with `#`,
 * optional surrounding quotes. Vite has its own richer loader; we
 * only need the port keys, so a hand-rolled parser is simpler than
 * pulling in `dotenv`. Only used as a fallback when the parent
 * shell didn't export the port (e.g. raw `npm run dev` from a fresh
 * terminal).
 */
function loadEnvLocal() {
  const path = resolvePath(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Don't clobber values the parent shell already set — the
    // run-script (`run.sh`) exports them on purpose, and that wins.
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvLocal();

function tryBindPort(port, timeoutMs = BIND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const probe = createServer();
    let settled = false;
    const finish = (bound) => {
      if (settled) return;
      settled = true;
      probe.removeAllListeners();
      resolve(bound);
      try {
        probe.close();
      } catch {
        /* already resolving the caller; close errors are not actionable */
      }
    };
    probe.once("error", () => finish(false));
    probe.once("listening", () => finish(true));
    setTimeout(() => finish(false), timeoutMs);
    probe.listen(port, "0.0.0.0");
  });
}

async function findFreePort(start) {
  for (let offset = 0; offset <= MAX_PORT_SEARCH_OFFSET; offset += 1) {
    const candidate = start + offset;
    if (candidate > 65535) return null;
    // eslint-disable-next-line no-await-in-loop -- sequential probe is the point
    if (await tryBindPort(candidate)) return candidate;
  }
  return null;
}

const requested =
  parseEnvPort("VITE_API_PORT") ??
  parseEnvPort("API_PORT") ??
  parseEnvPort("PORT") ??
  DEV_API_BASE_PORT;

const port = await findFreePort(requested);
if (port === null) {
  console.error(
    `[dev:server] No free API port found near ${requested} (searched up to +${MAX_PORT_SEARCH_OFFSET}).`
  );
  process.exit(1);
}

if (port !== requested) {
  console.warn(
    `[dev:server] Port ${requested} is in use; falling back to ${port}.`
  );
} else {
  console.log(`[dev:server] Using API port ${port}.`);
}

/*
 * When `npm run dev` runs inside a Controller agent or terminal, it inherits
 * the app's CONTROLLER_SERVER_URL / CONTROLLER_SESSION_ID. Drop them so they
 * can't leak into the dev server, and mark it as a dev instance so it keeps
 * its CLI install and runtime file under `<CONTROLLER_HOME>/dev/` instead of
 * overwriting the running app's (see `isDevInstance` in
 * server/lib/controller-cli.ts). CONTROLLER_HOME itself is kept: the dev
 * server intentionally shares the app's state files.
 */
function devServerBaseEnv() {
  const env = { ...process.env, CONTROLLER_DEV_INSTANCE: "1" };
  delete env.CONTROLLER_SERVER_URL;
  delete env.CONTROLLER_SESSION_ID;
  return env;
}

const child = spawn(
  "npx",
  ["tsx", "watch", "--env-file-if-exists=.env.local", "server/index.ts"],
  {
    stdio: "inherit",
    env: {
      ...devServerBaseEnv(),
      PORT: String(port),
      API_PORT: String(port),
      VITE_API_PORT: String(port),
    },
  }
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}