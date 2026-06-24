import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Attachment } from "../integrations.js";

const QUERY = (name: string): Attachment => ({ kind: "query", name });
const BEARER: Attachment = { kind: "header", name: "Authorization", prefix: "Bearer " };

/*
 * The integrations store derives its file paths from CONTROLLER_HOME
 * (via paths.ts), so each test points it at a fresh temp dir. The module is
 * imported dynamically after the env var is set. Outside Electron, safeStorage
 * is unavailable, so secrets fall back to the plaintext envelope — which is
 * exactly what we assert never leaks through the public API.
 */
async function withTempHome<T>(
  fn: (mod: typeof import("../integrations.js")) => Promise<T>
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "integrations-test-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;
  try {
    const mod = await import(`../integrations.js?t=${Date.now()}-${Math.random()}`);
    return await fn(mod);
  } finally {
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("create stores an AND-set of schemes; secret values never leak (Trello)", async () => {
  await withTempHome(async (mod) => {
    const created = await mod.createConnection({
      name: "  Trello  ",
      transport: { mode: "rest", config: { baseUrl: "https://api.trello.com/1" }, headers: {} },
      auth: {
        schemes: [
          { acquisition: "static", attachment: QUERY("key"), secret: "APIKEY" },
          { acquisition: "static", attachment: QUERY("token"), secret: "USERTOKEN" },
        ],
      },
    });

    assert.equal(created.name, "Trello");
    assert.equal(created.auth.schemes.length, 2);
    assert.ok(
      created.auth.schemes.every(
        (s) => s.acquisition === "static" && s.attachment?.kind === "query" && s.hasSecret
      )
    );
    assert.ok(!JSON.stringify(created).includes("APIKEY"));
    assert.ok(!JSON.stringify(created).includes("USERTOKEN"));

    const secrets = await mod.getConnectionSecrets(created.id);
    const values = created.auth.schemes.map((s) => secrets[s.id]).sort();
    assert.deepEqual(values, ["APIKEY", "USERTOKEN"]);
  });
});

test("transport carries constant non-secret headers (Notion shape)", async () => {
  await withTempHome(async (mod) => {
    const created = await mod.createConnection({
      name: "Notion",
      transport: {
        mode: "rest",
        config: { baseUrl: "https://api.notion.com/v1" },
        headers: { "Notion-Version": "2026-03-11" },
        query: { "api-version": "2024-01-01" },
      },
      auth: { schemes: [{ acquisition: "static", attachment: BEARER, secret: "secret_xyz" }] },
    });

    assert.deepEqual(created.transport.headers, { "Notion-Version": "2026-03-11" });
    assert.deepEqual(created.transport.query, { "api-version": "2024-01-01" });
    assert.ok(JSON.stringify(created).includes("Notion-Version"));
    assert.ok(!JSON.stringify(created).includes("secret_xyz"));
  });
});

test("update preserves a scheme's secret when its value is omitted", async () => {
  await withTempHome(async (mod) => {
    const created = await mod.createConnection({
      name: "Keepit",
      transport: { mode: "rest", config: {}, headers: {} },
      auth: { schemes: [{ acquisition: "static", attachment: BEARER, secret: "tok" }] },
    });
    const schemeId = created.auth.schemes[0].id;

    const updated = await mod.updateConnection(created.id, {
      auth: { schemes: [{ id: schemeId, acquisition: "static", attachment: BEARER }] },
    });

    assert.ok(updated);
    assert.equal(updated.auth.schemes[0].id, schemeId);
    assert.equal(updated.auth.schemes[0].hasSecret, true);
    assert.equal((await mod.getConnectionSecrets(created.id))[schemeId], "tok");
  });
});

test("removing a scheme drops its stored secret", async () => {
  await withTempHome(async (mod) => {
    const created = await mod.createConnection({
      name: "Drop",
      transport: { mode: "rest", config: {}, headers: {} },
      auth: {
        schemes: [
          { acquisition: "static", attachment: QUERY("key"), secret: "k" },
          { acquisition: "static", attachment: QUERY("token"), secret: "t" },
        ],
      },
    });
    const [keep, drop] = created.auth.schemes;

    const updated = await mod.updateConnection(created.id, {
      auth: { schemes: [{ id: keep.id, acquisition: "static", attachment: QUERY("key") }] },
    });

    assert.ok(updated);
    assert.equal(updated.auth.schemes.length, 1);
    const secrets = await mod.getConnectionSecrets(created.id);
    assert.equal(secrets[keep.id], "k");
    assert.equal(secrets[drop.id], undefined);
  });
});

test("acquired-credential schemes start in a 'none' acquired state", async () => {
  await withTempHome(async (mod) => {
    const created = await mod.createConnection({
      name: "OAuthy",
      transport: { mode: "rest", config: {}, headers: {} },
      auth: { schemes: [{ acquisition: "oauth", attachment: BEARER, config: { clientId: "abc" } }] },
    });
    assert.equal(created.auth.schemes[0].acquired?.status, "none");
  });
});

test("delete removes the connection and its secrets", async () => {
  await withTempHome(async (mod) => {
    const created = await mod.createConnection({
      name: "Temp",
      transport: { mode: "rest", config: {}, headers: {} },
      auth: { schemes: [{ acquisition: "static", attachment: BEARER, secret: "t" }] },
    });

    assert.equal(await mod.deleteConnection(created.id), true);
    assert.equal(await mod.getConnection(created.id), null);
    assert.deepEqual(await mod.getConnectionSecrets(created.id), {});
    assert.equal(await mod.deleteConnection(created.id), false);
  });
});
