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
import { controllerCliShellPath } from "../controller-cli.js";
import { createConnection } from "../integrations.js";
import { orchestratorHome } from "../paths.js";

async function withTempHome(
  fn: () => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "preamble-test-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousOrchHome = process.env.CONTROLLER_HOME;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.CONTROLLER_HOME = dir;
  try {
    await fn();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousOrchHome === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previousOrchHome;
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
    // The preamble inlines the shell-quoted path so the macOS default
    // home (which contains a space in `Application Support`) renders as a
    // working command — see `controllerCliShellPath` in controller-cli.ts.
    const cliPath = controllerCliShellPath();
    const note = `Invoke the Controller CLI by its absolute path \`${cliPath}\` — the bare \`controller\` command is not guaranteed to be on your PATH. Copy the full path verbatim from this preamble.`;
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
      note,
      "",
      // Memory intro + manifest (issue #350). The catalog is empty in
      // this test (no notes, no pinned), so the block renders the
      // explicit `(empty)` / `(no notes yet)` placeholders. The home
      // gets the global scope dir on startup via `ensureMemoryDirs`,
      // so `readPinnedMemory` returns "" rather than throwing.
      "Controller has an app-owned **memory** layer where the user persists",
      "facts that survive across sessions: preferences, conventions, deploy",
      "processes, library choices, \"as we discussed X\". The",
      "`<memory_index>` block in this preamble lists every note by slug + scope +",
      "first-line preview — read it before answering questions about preferences,",
      "conventions, deploys, library choice, or anything phrased as \"as we",
      "discussed\" or \"we agreed\".",
      "",
      "Workflow:",
      `1. Scan the \`<memory_index>\` block. If a slug looks relevant, call \`${cliPath} memory read <scope> <slug>\` to fetch the body.`,
      `2. \`${cliPath} memory search <query>\` is the broader version — useful when the user's prompt doesn't lexically match any slug.`,
      `3. When the user gives you a durable preference or fact, offer to write it via \`${cliPath} memory write <scope> <slug> --content <text>\` instead of just acknowledging.`,
      "",
      "Scope is `global` (every session) or `project` (per onboarded project).",
      "When the CLI is invoked from a session, omit `--project` and the server",
      "resolves the project from the active session. Do not read memory for",
      "unrelated tasks — the index alone is enough to decide relevance. If",
      "`memory search` returns nothing relevant, say so; do not fabricate from",
      "context.",
      "",
      "<memory>",
      "<pinned_global>",
      "(empty)",
      "</pinned_global>",
      "<memory_index>",
      "(no notes yet)",
      "</memory_index>",
      "</memory>",
      "",
      note,
      "",
      // The loop primitives intro (issue #339). Kept stable by re-reading
      // the function output rather than hand-rolling a copy here — any
      // drift between the snapshot and `loopPrimitivesIntro` will fail
      // the equality check below.
      "Controller ships three same-session primitives for condition-driven",
      "loops (issue #339). All three compose with the existing session",
      "queue: a follow-up turn runs once the current turn ends, in the same",
      "session, with full context.",
      "",
      "  1. Deferred follow-up. `wake <self> \"...\" --delay 30s`",
      `     enqueues a follow-up and holds it for the duration (forms: 30s,`,
      `     5m, 1h, 2d). The wakes consumer fires it on the next scheduler`,
      `     tick via \`${cliPath} sessions wake <self> "..." --delay 30s\`.`,
      "",
      "  2. Goal-driven loop. `goal set <self> --condition \"<text>\"`",
      `     attaches a completion condition. After every turn the`,
      `     GoalEvaluator (a small fast model) judges whether the condition`,
      `     is met; on met it clears the goal, on not met it enqueues a`,
      `     follow-up so the loop continues without your needing to re-fire.`,
      `     \`--max-turns <n>\` is a hard ceiling.`,
      "",
      "  3. Event-stream watch. `monitor start <self> --description <text>`",
      `     --command <shell> spawns a long-running child whose stdout becomes`,
      `     a session event; each line lands in the event log as a`,
      `     \`monitor_event\`. Bounded by \`--timeout-ms\` (default 5 min,`,
      `     max 1 hr).`,
      "",
      "Worked example — open a PR and stay until CI is green:",
      "",
      "   # Turn 1: write, push, open PR, attach a goal.",
      `   gh pr create --fill`,
      `   ${cliPath} sessions goal set <self> --condition \\`,
      `     "all required CI checks on PR #N are SUCCESS" --max-turns 5`,
      `   ${cliPath} sessions wake <self> "Check gh pr checks <N>; if all`,
      `     SUCCESS, stop the goal; if any FAILURE, read the failing job log,`,
      `     fix, push, and re-set the goal" --delay 30s`,
      "",
      "   # Turn N (after 30s): wake consumer fires the follow-up; the agent",
      "   # reads CI, fixes any failure, and ends the turn.",
      "",
      "   # Turn N+1: GoalEvaluator judges. If met, the goal clears and the",
      "   # session goes idle; if not, the evaluator enqueues the next turn.",
      "   # The loop continues until met or `--max-turns` is exceeded.",
      "",
      "These primitives are not a sandbox — they're plain Controller",
      "subcommands you can invoke like any other shell command.",
      "",
      note,
      "",
      // Cross-session discoverability intro (issue #353). Closes the
      // "how does the agent learn its own id" gap that motivates
      // `controller sessions list --parent self`. The intro inlines
      // worked-example commands so the agent can copy/paste them.
      "Cross-session discoverability (issue #353):",
      "",
      `  - \`${cliPath} sessions list [<project>]\` enumerates every session in`,
      `    the project. \`--worktree <id>\`, \`--parent <id|self>\`, and`,
      `    \`--provider <id>\` filter the result; \`--json\` emits NDJSON for`,
      `    pipelines. \`--limit <n>\` caps the result (default 100).`,
      `  - \`--parent <id>\` walks every worktree of the project, so a parent`,
      `    on the main worktree and a child on a feature worktree are both`,
      `    found. The server has no combined-filter endpoint yet — the CLI`,
      `    stitches the per-worktree results itself.`,
      `  - \`--parent self\` resolves to your own session id via the`,
      `    \`CONTROLLER_SESSION_ID\` env var the orchestrator injects. On a`,
      `    brand-new session that env var isn't set yet (the id is assigned`,
      `    on the agent's first \`run.started\` event); the CLI surfaces a`,
      `    clear error and points you at \`sessions list\` to discover your`,
      `    own id.`,
      `  - \`${cliPath} sessions start <message> --parent <id|self>\` records`,
      `    the new session as a child of the given parent. Use \`self\` to`,
      `    spawn a child of yourself (the coordinator pattern from #351).`,
      `    \`<message>\` is a positional argument in the new shape`,
      `    (issue #355); flags can sit before or after it. If the prompt`,
      `    starts with \`--\`, pass it after \`--\` so the leading dash is`,
      `    treated as literal text: \`... -- "--help me"\`.`,
      "",
      "Typical coordinator startup:",
      "",
      `   # 1. Learn your own session id (works on every turn; env var is`,
      `   #    only set for resumed sessions). Each session-list line is`,
      `   #    emitted as a separate JSON object (NDJSON), so the per-line`,
      `   #    \`select\` runs first — \`.[]\` after \`select\` would iterate`,
      `   #    each scalar field value of the object instead of the`,
      `   #    collection, and jq would reject it with "Cannot index string`,
      `   #    with string 'provider'".`,
      `   SELF=$(${cliPath} sessions list --json | jq -r 'select(.provider == "codex") | .id' | head -1)`,
      `   # 2. Spawn a child pinned to yourself.`,
      `   ${cliPath} sessions start "Review the PR from session $SELF" \\`,
      `     --worktree <wtId> --parent "$SELF" --agent claude`,
      `   # 3. Later, see your children.`,
      `   ${cliPath} sessions list --parent "$SELF" --json`,
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
    // Match the shell-quoted form that the preamble interpolates, so the
    // occurrence count and the example-command regexes below line up with
    // what the agent actually sees in the prompt.
    const cliPath = controllerCliShellPath();
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
    // The worktrees CLI surface still lives in the managed
    // `controller-worktrees` skill; the preamble no longer inlines
    // it. The cross-session discoverability intro (issue #353) does
    // surface `sessions list` and `sessions start --parent` because
    // the agent can't discover its own session id any other way —
    // that's the gap the new intro closes.
    assert.doesNotMatch(preamble, /worktrees list/);
    assert.match(preamble, new RegExp(`sessions list \\[<project>\\]`));
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

test("preamble documents the same-session loop primitives (issue #339)", async () => {
  // The agent preamble must teach the three new primitives (`wake
  // --delay`, `goal set`, `monitor start`) with a worked example, so
  // an agent can adopt them without reading separate docs.
  await withTempHome(async () => {
    const preamble = await buildControllerPreamble();
    assert.match(preamble, /Controller ships three same-session primitives/);
    assert.match(preamble, /wake <self> "\.\.\." --delay 30s/);
    assert.match(preamble, /goal set <self> --condition/);
    assert.match(preamble, /monitor start <self>/);
    assert.match(preamble, /Worked example — open a PR and stay until CI is green/);
    // The worked example must mention every primitive in context — a
    // truncated example would teach the agent the wrong surface.
    assert.match(preamble, /sessions goal set/);
    assert.match(preamble, /sessions wake <self>/);
  });
});
