import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  controllerHomeId,
  devServerBaseEnv,
  isControllerServerAlive,
  probeControllerHome,
} from "../../scripts/dev-instance-env.mjs";

async function fixture(run, { otherHome = false, legacy = false } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "controller-dev-env-"));
  const ownerHome = otherHome
    ? await mkdtemp(path.join(os.tmpdir(), "controller-other-home-"))
    : home;
  const server = createServer((req, res) => {
    if (req.url === "/api/instance" && !legacy) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ homeId: controllerHomeId(ownerHome) }));
      return;
    }
    res.statusCode = req.url === "/api/agent-providers" ? 200 : 404;
    res.end("[]");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ home, ownerHome, url, env: { CONTROLLER_HOME: home } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
    if (otherHome) await rm(ownerHome, { recursive: true, force: true });
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
    const child = await devServerBaseEnv({ ...env, CONTROLLER_SERVER_URL: "http://127.0.0.1:1", CONTROLLER_SESSION_ID: "s1", CONTROLLER_DEV_LAUNCH_ID: "parent-launch" });
    assert.equal(child.CONTROLLER_SHARED_STATE_SECONDARY, "1");
    assert.equal(child.CONTROLLER_SERVER_URL, undefined);
    assert.equal(child.CONTROLLER_SESSION_ID, undefined);
    assert.equal(child.CONTROLLER_DEV_LAUNCH_ID, undefined);
  });
});

test("stale runtime discovers a packaged app on a bumped port", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "controller-dev-bumped-"));
  try {
    await writeFile(path.join(home, "controller-runtime.json"), '{"serverUrl":"http://localhost:3171"}');
    const child = await devServerBaseEnv(
      { CONTROLLER_HOME: home, CONTROLLER_SERVER_URL: "http://localhost:3171" },
      async (url) => url === "http://localhost:4502" ? controllerHomeId(home) : null,
      async () => false,
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
    const child = await devServerBaseEnv({ CONTROLLER_HOME: home }, async () => null, async () => false);
    assert.equal(child.CONTROLLER_DEV_INSTANCE, "1");
    assert.equal(child.CONTROLLER_SHARED_STATE_SECONDARY, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("health probe accepts only a live Controller endpoint", async () => {
  await fixture(async ({ home, url }) => {
    assert.equal(await isControllerServerAlive(url), true);
    assert.equal(await probeControllerHome(url), controllerHomeId(home));
  });
  assert.equal(await isControllerServerAlive("http://127.0.0.1:1", 300), false);
});

test("custom home ignores inherited URL owned by another home", async () => {
  await fixture(async ({ env, url }) => {
    const child = await devServerBaseEnv({ ...env, CONTROLLER_SERVER_URL: url });
    assert.equal(child.CONTROLLER_SHARED_STATE_SECONDARY, undefined);
  }, { otherHome: true });
});

test("scanned port owned by another home cannot suppress loops", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "controller-scan-home-"));
  const otherHome = await mkdtemp(path.join(os.tmpdir(), "controller-scan-other-"));
  try {
    const child = await devServerBaseEnv(
      { CONTROLLER_HOME: home },
      async (url) => url === "http://localhost:4502" ? controllerHomeId(otherHome) : null,
      async () => false,
    );
    assert.equal(child.CONTROLLER_SHARED_STATE_SECONDARY, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(otherHome, { recursive: true, force: true });
  }
});

test("same-home runtime URL supports older servers without identity", async () => {
  await fixture(async ({ home, url, env }) => {
    await writeFile(path.join(home, "controller-runtime.json"), JSON.stringify({ serverUrl: url }));
    const child = await devServerBaseEnv(env);
    assert.equal(child.CONTROLLER_SHARED_STATE_SECONDARY, "1");
    assert.equal(child.CONTROLLER_SHARED_STATE_LEGACY_OWNER_URL, url);
  }, { legacy: true });
});

test("a legacy packaged owner wins over a newer secondary's identity", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "controller-legacy-owner-"));
  const legacyUrl = "http://localhost:4500";
  const modernUrl = "http://localhost:3102";
  try {
    await writeFile(path.join(home, "controller-runtime.json"), JSON.stringify({ serverUrl: legacyUrl }));
    const child = await devServerBaseEnv(
      { CONTROLLER_HOME: home, CONTROLLER_SERVER_URL: modernUrl },
      async (url) => url === modernUrl ? controllerHomeId(home) : null,
      async (url) => url === legacyUrl,
    );
    assert.equal(child.CONTROLLER_SHARED_STATE_LEGACY_OWNER_URL, legacyUrl);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("symlink aliases share a home ID and suppress duplicate loops", async () => {
  await fixture(async ({ home, url, env }) => {
    const alias = `${home}-alias`;
    await symlink(home, alias, "dir");
    try {
      assert.equal(controllerHomeId(alias), controllerHomeId(home));
      const child = await devServerBaseEnv({ ...env, CONTROLLER_HOME: alias, CONTROLLER_SERVER_URL: url });
      assert.equal(child.CONTROLLER_SHARED_STATE_SECONDARY, "1");
    } finally {
      await rm(alias);
    }
  });
});

test("distinct homes have distinct IDs", async () => {
  const first = await mkdtemp(path.join(os.tmpdir(), "controller-home-first-"));
  const second = await mkdtemp(path.join(os.tmpdir(), "controller-home-second-"));
  try {
    assert.notEqual(controllerHomeId(first), controllerHomeId(second));
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("missing home resolves aliases of its existing ancestor", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "controller-missing-home-"));
  const real = path.join(parent, "real");
  const alias = path.join(parent, "alias");
  await mkdir(real);
  await symlink(real, alias, "dir");
  try {
    assert.equal(controllerHomeId(path.join(real, "new", "home")), controllerHomeId(path.join(alias, "new", "home")));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("case aliases share a home ID on case-insensitive filesystems", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "controller-case-home-"));
  const home = path.join(parent, "HomeCase");
  const alias = path.join(parent, "homecase");
  await mkdir(home);
  try {
    let sameDirectory = false;
    try {
      const [a, b] = await Promise.all([stat(home), stat(alias)]);
      sameDirectory = a.dev === b.dev && a.ino === b.ino;
    } catch { /* The filesystem is case-sensitive. */ }
    if (!sameDirectory) return t.skip("filesystem is case-sensitive");
    assert.equal(controllerHomeId(home), controllerHomeId(alias));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
