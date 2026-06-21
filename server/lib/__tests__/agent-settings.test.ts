import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAgentSetting,
  getAgentSettings,
  setAgentSetting,
} from "../agent-settings.js";
import { agentSettingsFile } from "../paths.js";

function withTempHome(run: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-settings-"));
  const original = process.env.CODING_ORCHESTRATOR_HOME;
  process.env.CODING_ORCHESTRATOR_HOME = dir;
  return run().finally(() => {
    if (original === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
    else process.env.CODING_ORCHESTRATOR_HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("getAgentSetting defaults to enabled with no path", async () => {
  await withTempHome(async () => {
    const setting = await getAgentSetting("codex");
    assert.deepEqual(setting, { enabled: true, path: null });
  });
});

test("setAgentSetting persists enabled and path", async () => {
  await withTempHome(async () => {
    await setAgentSetting("codex", { enabled: false, path: "/usr/local/bin/codex" });
    const setting = await getAgentSetting("codex");
    assert.deepEqual(setting, { enabled: false, path: "/usr/local/bin/codex" });

    const onDisk = JSON.parse(readFileSync(agentSettingsFile(), "utf-8"));
    assert.equal(onDisk.codex.enabled, false);
    assert.equal(onDisk.codex.path, "/usr/local/bin/codex");
  });
});

test("setAgentSetting merges partial patches", async () => {
  await withTempHome(async () => {
    await setAgentSetting("anita", { enabled: false });
    await setAgentSetting("anita", { path: "/opt/anita" });
    const setting = await getAgentSetting("anita");
    assert.deepEqual(setting, { enabled: false, path: "/opt/anita" });
  });
});

test("legacy 'ada' settings resolve to the canonical 'anita' id", async () => {
  await withTempHome(async () => {
    // Settings saved before the Ada→Anita rename were keyed by "ada".
    await setAgentSetting("ada", { enabled: false, path: "/opt/ada" });
    // Both the legacy and canonical ids return the same setting.
    assert.deepEqual(await getAgentSetting("anita"), {
      enabled: false,
      path: "/opt/ada",
    });
    assert.deepEqual(await getAgentSetting("ada"), {
      enabled: false,
      path: "/opt/ada",
    });
  });
});

test("setAgentSetting normalizes blank path to null", async () => {
  await withTempHome(async () => {
    await setAgentSetting("claude", { path: "   " });
    const settings = await getAgentSettings();
    assert.equal(settings.claude.path, null);
  });
});
