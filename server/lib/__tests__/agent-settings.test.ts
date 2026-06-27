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
    assert.deepEqual(setting, {
      enabled: true,
      path: null,
      defaultModel: null,
      autoApprove: true,
    });
  });
});

test("setAgentSetting persists enabled and path", async () => {
  await withTempHome(async () => {
    await setAgentSetting("codex", { enabled: false, path: "/usr/local/bin/codex" });
    const setting = await getAgentSetting("codex");
    assert.deepEqual(setting, {
      enabled: false,
      path: "/usr/local/bin/codex",
      defaultModel: null,
      autoApprove: true,
    });

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
    assert.deepEqual(setting, {
      enabled: false,
      path: "/opt/anita",
      defaultModel: null,
      autoApprove: true,
    });
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
      autoApprove: true,
    });
    assert.deepEqual(await getAgentSetting("ada"), {
      enabled: false,
      path: "/opt/ada",
      defaultModel: null,
      autoApprove: true,
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

test("autoApprove defaults to on and persists when toggled off", async () => {
  await withTempHome(async () => {
    // Default for a brand-new agent config is auto-approve = on.
    assert.equal((await getAgentSetting("claude")).autoApprove, true);

    await setAgentSetting("claude", { autoApprove: false });
    assert.equal((await getAgentSetting("claude")).autoApprove, false);

    const onDisk = JSON.parse(readFileSync(agentSettingsFile(), "utf-8"));
    assert.equal(onDisk.claude.autoApprove, false);

    // Toggling it back on persists too.
    await setAgentSetting("claude", { autoApprove: true });
    assert.equal((await getAgentSetting("claude")).autoApprove, true);
  });
});

test("normalizeSetting defaults autoApprove to on for legacy objects", async () => {
  await withTempHome(async () => {
    // Settings written before auto-approve existed have no `autoApprove` key;
    // they must read back as on so behavior is unchanged for existing users.
    writeFileSync(
      agentSettingsFile(),
      JSON.stringify({ codex: { enabled: true, path: null, defaultModel: null } }),
      "utf-8"
    );
    assert.equal((await getAgentSetting("codex")).autoApprove, true);
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
      autoApprove: true,
    });
  });
});
