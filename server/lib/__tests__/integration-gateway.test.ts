import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function withTempHome(
  fn: (mods: {
    integrations: typeof import("../integrations.js");
    gateway: typeof import("../integration-gateway.js");
  }) => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-test-"));
  const previous = process.env.CODING_ORCHESTRATOR_HOME;
  process.env.CODING_ORCHESTRATOR_HOME = dir;
  try {
    await fn({
      integrations: await import("../integrations.js"),
      gateway: await import("../integration-gateway.js"),
    });
  } finally {
    if (previous === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
    else process.env.CODING_ORCHESTRATOR_HOME = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("gatewayList shows only enabled connections", async () => {
  await withTempHome(async ({ integrations, gateway }) => {
    await integrations.createConnection({
      name: "Visible",
      transport: { mode: "rest", config: { baseUrl: "https://a.example" }, headers: {}, query: {} },
      auth: { schemes: [] },
    });
    await integrations.createConnection({
      name: "Hidden",
      enabled: false,
      transport: { mode: "rest", config: { baseUrl: "https://b.example" }, headers: {}, query: {} },
      auth: { schemes: [] },
    });

    const listed = await gateway.gatewayList();
    assert.deepEqual(listed.map((c) => c.name), ["Visible"]);
    assert.equal(listed[0].kind, "request");
  });
});

test("list tags OpenAPI as `tools` and GraphQL as `request`", async () => {
  await withTempHome(async ({ integrations, gateway }) => {
    await integrations.createConnection({
      name: "Specced",
      transport: { mode: "openapi", config: { specUrl: "https://x/spec.json" }, headers: {}, query: {} },
      auth: { schemes: [] },
    });
    await integrations.createConnection({
      name: "Graph",
      transport: { mode: "graphql", config: { endpoint: "https://x/graphql" }, headers: {}, query: {} },
      auth: { schemes: [] },
    });

    const byName = new Map((await gateway.gatewayList()).map((c) => [c.name, c.kind]));
    assert.equal(byName.get("Specced"), "tools");
    assert.equal(byName.get("Graph"), "request");
  });
});

test("request is rejected for non-HTTP transports", async () => {
  await withTempHome(async ({ integrations, gateway }) => {
    await integrations.createConnection({
      name: "MyCli",
      transport: { mode: "cli", config: { binary: "gh" }, headers: {}, query: {} },
      auth: { schemes: [] },
    });
    await assert.rejects(
      () => gateway.gatewayRequest("MyCli", { method: "GET", path: "/" }),
      /only works for HTTP/
    );
  });
});

test("resolving an unknown or disabled integration errors", async () => {
  await withTempHome(async ({ gateway }) => {
    await assert.rejects(() => gateway.gatewayStatus("Nope"), /No enabled integration/);
  });
});
