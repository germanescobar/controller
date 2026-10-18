import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { devServerBaseEnv, isControllerServerAlive } from "../../scripts/dev-instance-env.mjs";

async function fixture(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "controller-dev-env-"));
  const server = createServer((req, res) => {
    res.statusCode = req.url === "/api/agent-providers" ? 200 : 404;
    res.end("[]");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ home, url, env: { CONTROLLER_HOME: home } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
}

test("absent inherited env discovers a running app from its runtime", async () => {
  await fixture(async ({ home, url, env }) => {
    await writeFile(path.join(home, "controller-runtime.json"), JSON.stringify({ serverUrl: url }));
    const child = await devServerBaseEnv(env);
    assert.equal(child.CONTROLLER_DEV_INSTANCE, "1");
    assert.equal(child.CONTROLLER_SHARED_STATE_SECONDARY, "1");
  });
});

test("stale inherited URL falls back to the running app runtime", async () => {
  await fixture(async ({ home, url, env }) => {
    await writeFile(path.join(home, "controller-runtime.json"), JSON.stringify({ serverUrl: url }));
    const child = await devServerBaseEnv({ ...env, CONTROLLER_SERVER_URL: "http://127.0.0.1:1", CONTROLLER_SESSION_ID: "s1" });
    assert.equal(child.CONTROLLER_SHARED_STATE_SECONDARY, "1");
    assert.equal(child.CONTROLLER_SERVER_URL, undefined);
    assert.equal(child.CONTROLLER_SESSION_ID, undefined);
  });
});

test("stale runtime discovers a packaged app on a bumped port", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "controller-dev-bumped-"));
  try {
    await writeFile(path.join(home, "controller-runtime.json"), '{"serverUrl":"http://localhost:3171"}');
    const child = await devServerBaseEnv(
      { CONTROLLER_HOME: home, CONTROLLER_SERVER_URL: "http://localhost:3171" },
      async (url) => url === "http://localhost:4502",
    );
    assert.equal(child.CONTROLLER_SHARED_STATE_SECONDARY, "1");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("another worktree's live dev runtime prevents duplicate shared loops", async () => {
  await fixture(async ({ home, url, env }) => {
    const dir = path.join(home, "dev", "other-checkout");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "controller-runtime.json"), JSON.stringify({ serverUrl: url }));
    assert.equal((await devServerBaseEnv(env)).CONTROLLER_SHARED_STATE_SECONDARY, "1");
  });
});

test("after shutdown, standalone development owns shared loops", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "controller-dev-stopped-"));
  try {
    await writeFile(path.join(home, "controller-runtime.json"), '{"serverUrl":"http://127.0.0.1:1"}');
    const child = await devServerBaseEnv({ CONTROLLER_HOME: home }, async () => false);
    assert.equal(child.CONTROLLER_DEV_INSTANCE, "1");
    assert.equal(child.CONTROLLER_SHARED_STATE_SECONDARY, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("health probe accepts only a live Controller endpoint", async () => {
  await fixture(async ({ url }) => {
    assert.equal(await isControllerServerAlive(url), true);
  });
  assert.equal(await isControllerServerAlive("http://127.0.0.1:1", 300), false);
});
