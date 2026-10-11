import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { devServerBaseEnv, isControllerServerAlive } from "../../scripts/dev-instance-env.mjs";

// `npm run dev` is only a dev instance when started from inside a live
// Controller app; a standalone run must keep skills and background loops.

const alive = async () => true;
const dead = async () => false;

test("inherited URL of a live app marks the dev server as a dev instance", async () => {
  const env = await devServerBaseEnv(
    { CONTROLLER_SERVER_URL: "http://localhost:4500", CONTROLLER_SESSION_ID: "s1", KEEP: "x" },
    alive,
  );
  assert.equal(env.CONTROLLER_DEV_INSTANCE, "1");
  assert.equal(env.CONTROLLER_SERVER_URL, undefined);
  assert.equal(env.CONTROLLER_SESSION_ID, undefined);
  assert.equal(env.KEEP, "x");
});

test("inherited URL that does not answer leaves a regular instance", async () => {
  const env = await devServerBaseEnv({ CONTROLLER_SERVER_URL: "http://localhost:4500" }, dead);
  assert.equal(env.CONTROLLER_DEV_INSTANCE, undefined);
  assert.equal(env.CONTROLLER_SERVER_URL, undefined);
});

test("no inherited URL leaves a regular instance without probing", async () => {
  let probed = false;
  const env = await devServerBaseEnv({ CONTROLLER_DEV_INSTANCE: "1" }, async () => {
    probed = true;
    return true;
  });
  assert.equal(probed, false);
  // A stale flag from the parent shell is not trusted either.
  assert.equal(env.CONTROLLER_DEV_INSTANCE, undefined);
});

test("isControllerServerAlive probes a real HTTP endpoint", async () => {
  const server = createServer((req, res) => {
    res.statusCode = req.url === "/api/agent-providers" ? 200 : 404;
    res.end("[]");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    assert.equal(await isControllerServerAlive(`http://127.0.0.1:${port}/`), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await isControllerServerAlive(`http://127.0.0.1:${port}`, 300), false);
});
