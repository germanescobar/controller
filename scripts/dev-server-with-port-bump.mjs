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
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";

const DEV_API_BASE_PORT = 3102;
const MAX_PORT_SEARCH_OFFSET = 100;
const BIND_TIMEOUT_MS = 1000;

function parseEnvPort(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}

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

const child = spawn(
  "npx",
  ["tsx", "watch", "--env-file-if-exists=.env.local", "server/index.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
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