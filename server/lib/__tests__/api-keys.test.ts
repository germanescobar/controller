import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROVIDERS,
  getConfiguredProviders,
  getApiKeyEnvVars,
} from "../api-keys.js";
import { apiKeysFile } from "../paths.js";

function withTempHome(seed: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "api-keys-"));
  const original = process.env.CODING_ORCHESTRATOR_HOME;
  process.env.CODING_ORCHESTRATOR_HOME = dir;
  writeFileSync(path.join(dir, "api-keys.json"), JSON.stringify(seed, null, 2));
  return run().finally(() => {
    if (original === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
    else process.env.CODING_ORCHESTRATOR_HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("PROVIDERS no longer includes OpenAI", () => {
  assert.ok(!PROVIDERS.some((p) => p.id === "openai"));
});

test("a stored OpenAI key is pruned on read", async () => {
  await withTempHome({ openai: "sk-old", groq: "gk-keep" }, async () => {
    const configured = await getConfiguredProviders();
    assert.ok(!configured.includes("openai"));
    assert.ok(configured.includes("groq"));

    const env = await getApiKeyEnvVars();
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.GROQ_API_KEY, "gk-keep");

    // Prune persists to disk.
    const onDisk = JSON.parse(readFileSync(apiKeysFile(), "utf-8"));
    assert.equal("openai" in onDisk, false);
    assert.equal(onDisk.groq, "gk-keep");
    assert.ok(existsSync(apiKeysFile()));
  });
});
