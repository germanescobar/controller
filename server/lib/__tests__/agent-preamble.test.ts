import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildAvailableIntegrationsBlock,
  buildAvailableProjectManagementBlock,
  buildAvailableSkillsBlock,
  buildControllerPreamble,
  framePreambleForPrompt,
} from "../agent-preamble.js";
import { controllerCliInstalledPath } from "../controller-cli.js";
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

// Regex metacharacter escape for the absolute CLI install path. Centralized
// so the "absolute path is inlined" tests share one definition.
function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    assert.equal(block, "<additional_skills>\n(none configured)\n</additional_skills>");
  });
});

test("integrations block renders (none configured) when no connections are enabled", async () => {
  await withTempHome(async () => {
    const block = await buildAvailableIntegrationsBlock();
    assert.equal(
      block,
      "<additional_integrations>\n(none configured)\n</additional_integrations>"
    );
  });
});

// ---------------------------------------------------------------------------
// Project-management block (issue #190)
// ---------------------------------------------------------------------------

test("project-management block lists the worktrees and sessions CLI surfaces", async () => {
  await withTempHome(async () => {
    const block = await buildAvailableProjectManagementBlock();
    const cliPath = controllerCliInstalledPath();
    // The block must surface every new CLI subcommand, with the
    // absolute install path so the agent can copy/paste it.
    assert.match(block, new RegExp(`\\\`${escapeForRegex(cliPath)} worktrees list`));
    assert.match(block, new RegExp(`\\\`${escapeForRegex(cliPath)} worktrees create`));
    assert.match(block, new RegExp(`\\\`${escapeForRegex(cliPath)} worktrees delete`));
    assert.match(block, new RegExp(`\\\`${escapeForRegex(cliPath)} sessions start`));
    // The block explicitly notes that <project> accepts id OR name.
    assert.match(block, /<project>\` accepts either the project's id or its human name/);
  });
});

test("full preamble includes the project-management block alongside skills and integrations", async () => {
  await withTempHome(async () => {
    const preamble = await buildControllerPreamble();
    const cliPath = controllerCliInstalledPath();
    assert.match(
      preamble,
      new RegExp(`\\\`${escapeForRegex(cliPath)} sessions start`)
    );
    // The project-management intro is present.
    assert.match(
      preamble,
      /Controller exposes a small set of project-management commands/
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
    assert.match(block, /<additional_skills>/);
    assert.match(block, /- github-issues — Work on GitHub issues/);
    assert.match(block, /- pr-feedback — Triage and address PR review feedback/);
    // No bodies leaked into the preamble.
    assert.doesNotMatch(block, /Body for/);
  });
});

test("skills block does NOT advertise per-agent (user/repo) skills", async () => {
  // Per-agent skills are intentionally excluded: `controller skills describe`
  // only resolves the unified catalog, so listing per-agent skills would
  // point the agent at a 404 on the advertised drill-down path. The
  // preamble instead names those locations in the intro so the agent
  // knows they still apply.
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
    assert.match(preamble, /<additional_skills>/);
    assert.match(preamble, /- github-issues — Work on GitHub issues/);
    assert.match(preamble, /<additional_integrations>/);
    assert.match(preamble, /- github \(openapi\/tools\)/);
  });
});

test("full preamble is stable for the same catalog (snapshot)", async () => {
  await withTempHome(async () => {
    await makeUnifiedSkill("github-issues", "Work on GitHub issues");
    await makeConnection("github", "openapi");
    await makeConnection("tavily", "cli");

    const preamble = await buildControllerPreamble();
    const cliPath = controllerCliInstalledPath();
    const note = `Invoke the Controller CLI by its absolute path \`${cliPath}\` — the bare \`controller\` command is not guaranteed to be on your PATH. Copy the full path verbatim from this preamble.`;
    const projectMgmtBlock = await buildAvailableProjectManagementBlock();
    const expected = [
      "You are running inside Controller, a desktop orchestrator for coding agents.",
      "",
      note,
      "",
      "In addition to your own skills, Controller exposes a catalog of " +
        "*additional* skills. To use one, call " +
        `\`${cliPath} skills describe <name>\` for the full body and follow its instructions, or ask the user to invoke it as ` +
        "`/<name>`. The `/<name>` picker accepts both your native skills and " +
        "Controller's.",
      "",
      "<additional_skills>",
      "- github-issues — Work on GitHub issues",
      "</additional_skills>",
      "",
      note,
      "",
      "In addition to any native tooling your provider exposes, the following " +
        "third-party integrations are connected through Controller. To discover " +
        "their tools call " +
        `\`${cliPath} integrations tools <name>\`; to invoke one call ` +
        `\`${cliPath} integrations call <name> <tool>\` (or ` +
        "`request` for raw HTTP). These integrations are *additional* — " +
        "they do not replace any native capabilities you already have.",
      "",
      "<additional_integrations>",
      "- github (openapi/tools) — OpenAPI (https://github.example) — run `tools`/`describe` to discover operations, then `call`.",
      "- tavily (cli/cli) — Native CLI `tavily` — run `status`, then invoke it directly.",
      "</additional_integrations>",
      "",
      // Project-management block (issue #190) is appended after the
      // integrations block; it surfaces the new `worktrees` and
      // `sessions` CLI surfaces with the absolute CLI path so the agent
      // can copy/paste them.
      note,
      "",
      "Controller exposes a small set of project-management commands on the same CLI " +
        "for managing worktrees and starting new sessions. The commands below are " +
        "also surfaced via `controller --help` and `controller <surface> --help`. Use " +
        "`worktrees create` + `sessions start` to worktree a conversation and then " +
        "kick off a turn on the new worktree — e.g. when the user says \"let's " +
        "create a worktree and start working on issue X\".",
      "",
      projectMgmtBlock,
    ].join("\n");
    assert.equal(preamble, expected);
  });
});

test("full preamble inlines the absolute controller CLI path so agents can copy/paste it", async () => {
  // Codex's exec layer rebuilds the env before spawning user commands, so the
  // bare `controller` command is not guaranteed to resolve on PATH inside the
  // agent's shell. The preamble must include the absolute install path so
  // agents can invoke the CLI verbatim.
  await withTempHome(async () => {
    const cliPath = controllerCliInstalledPath();
    const escaped = escapeForRegex(cliPath);
    const preamble = await buildControllerPreamble();
    // The path is introduced once at the top of the skills intro and again
    // at the top of the integrations intro, plus embedded in the example
    // commands — so it appears at least four times.
    const pathOccurrences = preamble.match(new RegExp(escaped, "g")) ?? [];
    assert.ok(
      pathOccurrences.length >= 4,
      `expected the absolute path to appear in both the skills and integrations intros, saw ${pathOccurrences.length} occurrences`
    );
    // The preamble inlines copy/paste-ready commands for the CLI.
    assert.match(preamble, new RegExp(`\`${escaped} skills describe <name>\``));
    assert.match(preamble, new RegExp(`\`${escaped} integrations tools <name>\``));
    assert.match(preamble, new RegExp(`\`${escaped} integrations call <name> <tool>\``));
    // And it warns that the bare `controller` command is unreliable on PATH.
    assert.match(preamble, /not guaranteed to be on your PATH/);
  });
});

test("preamble frames skills and integrations as additive, not exhaustive", async () => {
  // Each provider (Codex, Claude, Anita) has its own native skill system —
  // built-ins, per-agent user/repo skills, plugin marketplaces, repo
  // conventions, etc. Controller layers an app-owned catalog on top of
  // that. The preamble must make the layering explicit so agents don't
  // treat this as the full universe and forget about their own skills.
  await withTempHome(async () => {
    const preamble = await buildControllerPreamble();
    // Both blocks are explicitly labeled `<additional_*>`.
    assert.match(preamble, /<additional_skills>/);
    assert.match(preamble, /<\/additional_skills>/);
    assert.match(preamble, /<additional_integrations>/);
    assert.match(preamble, /<\/additional_integrations>/);
    // The intros frame Controller's skills/integrations as an *extra*
    // layer, not a replacement for the agent's own capabilities.
    assert.match(preamble, /In addition to your own skills/);
    assert.match(preamble, /In addition to any native tooling/);
    // The skills intro points at the `/<name>` picker and explains that it
    // accepts both the agent's native skills and Controller's.
    assert.match(preamble, /\/<name>\` picker accepts both your native skills and Controller's/);
    // The word "*additional*" (with markdown emphasis) appears in both
    // intros to reinforce the layering.
    const additionalCount = (preamble.match(/\*additional\*/g) ?? []).length;
    assert.ok(
      additionalCount >= 2,
      `expected "*additional*" to appear in both intros, saw ${additionalCount}`
    );
  });
});
