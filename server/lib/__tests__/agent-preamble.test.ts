import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildAvailableIntegrationsBlock,
  buildAvailableSkillsBlock,
  buildControllerPreamble,
  framePreambleForPrompt,
} from "../agent-preamble.js";
import { createConnection } from "../integrations.js";
import { orchestratorHome } from "../paths.js";

async function withTempHome(
  fn: () => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "preamble-test-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousOrchHome = process.env.CODING_ORCHESTRATOR_HOME;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.CODING_ORCHESTRATOR_HOME = dir;
  try {
    await fn();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousOrchHome === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
    else process.env.CODING_ORCHESTRATOR_HOME = previousOrchHome;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function makeUnifiedSkill(
  name: string,
  description: string
): Promise<void> {
  const dir = path.join(orchestratorHome(), "skills", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}\n`
  );
}

async function makeUserSkill(
  name: string,
  description: string
): Promise<void> {
  // Per-agent user-scope skills live under the per-provider user home. We use
  // the Anita layout here because the orchestrator is the only consumer of
  // these files in this test; we just need them to exist where a per-provider
  // catalog reader would find them.
  const dir = path.join(os.homedir(), ".anita", "skills", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}\n`
  );
}

async function makeConnection(
  name: string,
  mode: "rest" | "openapi" | "cli",
  enabled = true
): Promise<void> {
  const config: Record<string, string> =
    mode === "cli" ? { binary: name } : { baseUrl: `https://${name}.example` };
  await createConnection({
    name,
    enabled,
    transport: { mode, config, headers: {}, query: {} },
    auth: { schemes: [] },
  });
}

// ---------------------------------------------------------------------------
// Static identity line + framing
// ---------------------------------------------------------------------------

test("always states the agent is running inside Controller", async () => {
  const preamble = await buildControllerPreamble();
  assert.match(preamble, /running inside Controller/);
});

test("framing marks the block as context-only", () => {
  const framed = framePreambleForPrompt("hello");
  assert.match(framed, /do not repeat back/i);
  assert.match(framed, /hello/);
});

// ---------------------------------------------------------------------------
// Empty catalogs render the explicit "(none configured)" placeholder
// ---------------------------------------------------------------------------

test("skills block renders (none configured) when the unified catalog is empty", async () => {
  await withTempHome(async () => {
    const block = await buildAvailableSkillsBlock();
    assert.equal(block, "<available_skills>\n(none configured)\n</available_skills>");
  });
});

test("integrations block renders (none configured) when no connections are enabled", async () => {
  await withTempHome(async () => {
    const block = await buildAvailableIntegrationsBlock();
    assert.equal(
      block,
      "<available_integrations>\n(none configured)\n</available_integrations>"
    );
  });
});

// ---------------------------------------------------------------------------
// Populated catalogs: name + description only
// ---------------------------------------------------------------------------

test("skills block lists unified skills by name and description only", async () => {
  await withTempHome(async () => {
    await makeUnifiedSkill("github-issues", "Work on GitHub issues");
    await makeUnifiedSkill("pr-feedback", "Triage and address PR review feedback");
    const block = await buildAvailableSkillsBlock();
    assert.match(block, /<available_skills>/);
    assert.match(block, /- github-issues — Work on GitHub issues/);
    assert.match(block, /- pr-feedback — Triage and address PR review feedback/);
    // No bodies leaked into the preamble.
    assert.doesNotMatch(block, /Body for/);
  });
});

test("skills block does NOT advertise per-agent (user/repo) skills", async () => {
  // Per-agent skills are intentionally excluded: `controller skills describe`
  // only resolves the unified catalog, so listing per-agent skills would
  // point the agent at a 404 on the advertised drill-down path.
  await withTempHome(async () => {
    await makeUnifiedSkill("shared", "Unified, app-owned");
    await makeUserSkill("anita-only", "Anita-specific skill");
    const block = await buildAvailableSkillsBlock();
    assert.match(block, /- shared — Unified, app-owned/);
    assert.doesNotMatch(block, /anita-only/);
    assert.doesNotMatch(block, /Anita-specific/);
  });
});

test("integrations block lists name, mode/kind, summary, sorted by name", async () => {
  await withTempHome(async () => {
    await makeConnection("zeta", "rest");
    await makeConnection("alpha", "openapi");
    await makeConnection("hidden", "rest", false); // disabled → must NOT appear
    const block = await buildAvailableIntegrationsBlock();
    const alphaIdx = block.indexOf("- alpha");
    const zetaIdx = block.indexOf("- zeta");
    assert.ok(alphaIdx >= 0 && zetaIdx >= 0 && alphaIdx < zetaIdx, "must sort by name");
    assert.match(block, /- alpha \(openapi\/tools\)/);
    assert.match(block, /- zeta \(rest\/request\)/);
    assert.doesNotMatch(block, /hidden/, "disabled connections must not appear");
  });
});

// ---------------------------------------------------------------------------
// Full preamble composition
// ---------------------------------------------------------------------------

test("full preamble composes identity line, skills block, and integrations block", async () => {
  await withTempHome(async () => {
    await makeUnifiedSkill("github-issues", "Work on GitHub issues");
    await makeConnection("github", "openapi");

    const preamble = await buildControllerPreamble();
    assert.match(preamble, /running inside Controller/);
    assert.match(preamble, /<available_skills>/);
    assert.match(preamble, /- github-issues — Work on GitHub issues/);
    assert.match(preamble, /<available_integrations>/);
    assert.match(preamble, /- github \(openapi\/tools\)/);
  });
});

test("full preamble is stable for the same catalog (snapshot)", async () => {
  await withTempHome(async () => {
    await makeUnifiedSkill("github-issues", "Work on GitHub issues");
    await makeConnection("github", "openapi");
    await makeConnection("tavily", "cli");

    const preamble = await buildControllerPreamble();
    const expected = [
      "You are running inside Controller, a desktop orchestrator for coding agents.",
      "",
      "The following skills are available. To use one, call `controller skills describe <name>` for the full body and follow its instructions, or ask the user to invoke it as `/<name>`.",
      "",
      "<available_skills>",
      "- github-issues — Work on GitHub issues",
      "</available_skills>",
      "",
      "The following integrations are available. To discover their tools call `controller integrations tools <name>`; to invoke one call `controller integrations call <name> <tool>` (or `request` for raw HTTP).",
      "",
      "<available_integrations>",
      "- github (openapi/tools) — OpenAPI (https://github.example) — run `tools`/`describe` to discover operations, then `call`.",
      "- tavily (cli/cli) — Native CLI `tavily` — run `status`, then invoke it directly.",
      "</available_integrations>",
    ].join("\n");
    assert.equal(preamble, expected);
  });
});
