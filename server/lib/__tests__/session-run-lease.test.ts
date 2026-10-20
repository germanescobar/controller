import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claimSessionRunStart, releaseSessionRunLease, releaseSessionRunStart } from "../session-runtime.js";

const run = promisify(execFile);

test("a live server's run lease excludes another process, then releases", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "session-lease-"));
  const oldHome = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = home;
  const sessionId = "lease-live";
  const childCode = `
    import { claimSessionRunStart, releaseSessionRunLease, releaseSessionRunStart } from ${JSON.stringify(new URL("../session-runtime.ts", import.meta.url).href)};
    const claimed = await claimSessionRunStart(${JSON.stringify(sessionId)});
    console.log(claimed);
    if (claimed) { releaseSessionRunStart(${JSON.stringify(sessionId)}); await releaseSessionRunLease(${JSON.stringify(sessionId)}); }
  `;
  try {
    assert.equal(await claimSessionRunStart(sessionId), true);
    assert.equal((await run(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childCode], { env: process.env })).stdout.trim(), "false");
    releaseSessionRunStart(sessionId);
    await releaseSessionRunLease(sessionId);
    assert.equal((await run(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childCode], { env: process.env })).stdout.trim(), "true");
  } finally {
    await releaseSessionRunLease(sessionId);
    releaseSessionRunStart(sessionId);
    if (oldHome === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = oldHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("a stale run lease from a dead process is recovered", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "session-lease-stale-"));
  const oldHome = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = home;
  const sessionId = "lease-stale";
  const lockDir = path.join(home, "queues", `${sessionId}.run.lock`);
  try {
    await fs.mkdir(lockDir, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockDir, old, old);
    assert.equal(await claimSessionRunStart(sessionId), true);
    releaseSessionRunStart(sessionId);
    await releaseSessionRunLease(sessionId);
  } finally {
    await releaseSessionRunLease(sessionId);
    releaseSessionRunStart(sessionId);
    if (oldHome === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = oldHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});
