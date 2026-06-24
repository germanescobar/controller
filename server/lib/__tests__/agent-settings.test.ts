import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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
  const original = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;
  return run().finally(() => {
    if (original === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("getAgentSetting defaults to enabled with no path", async () => {
  await withTempHome(async () => {
    const setting = await getAgentSetting("codex");
    assert.deepEqual(setting, { enabled: true, path: null, defaultModel: null });
  });
});

test("setAgentSetting persists enabled and path", async () => {
  await withTempHome(async () => {
    await setAgentSetting("codex", { enabled: false, path: "/usr/local/bin/codex" });
    const setting = await getAgentSetting("codex");
    assert.deepEqual(setting, { enabled: false, path: "/usr/local/bin/codex", defaultModel: null });

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
    assert.deepEqual(setting, { enabled: false, path: "/opt/anita", defaultModel: null });
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
      defaultModel: null,
    });
    assert.deepEqual(await getAgentSetting("ada"), {
      enabled: false,
      path: "/opt/ada",
      defaultModel: null,
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

test("setAgentSetting persists and clears defaultModel", async () => {
  await withTempHome(async () => {
    await setAgentSetting("codex", { defaultModel: "gpt-5.5" });
    let setting = await getAgentSetting("codex");
    assert.equal(setting.defaultModel, "gpt-5.5");

    await setAgentSetting("codex", { defaultModel: null });
    setting = await getAgentSetting("codex");
    assert.equal(setting.defaultModel, null);

    await setAgentSetting("codex", { defaultModel: "" });
    setting = await getAgentSetting("codex");
    assert.equal(setting.defaultModel, null);

    const onDisk = JSON.parse(readFileSync(agentSettingsFile(), "utf-8"));
    assert.equal(onDisk.codex.defaultModel, null);
  });
});

test("normalizeSetting tolerates legacy objects without defaultModel", async () => {
  await withTempHome(async () => {
    writeFileSync(
      agentSettingsFile(),
      JSON.stringify({ claude: { enabled: true, path: "/usr/local/bin/claude" } }),
      "utf-8"
    );
    const setting = await getAgentSetting("claude");
    assert.deepEqual(setting, {
      enabled: true,
      path: "/usr/local/bin/claude",
      defaultModel: null,
    });
  });
});
