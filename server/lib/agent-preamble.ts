/*
 * System preamble injected into every agent turn (issue #109, #180).
 *
 * Always tells the agent it's running inside Controller. Browser tooling is
 * covered by the managed `browser` skill installed on startup, so the
 * detailed controller-browser CLI instructions have been removed from the
 * runtime preamble to avoid duplication.
 *
 * From #180 the preamble also surfaces the app-owned unified skill catalog
 * and the enabled integrations gateway, so the agent can discover both
 * surfaces without having to run `controller skills list` /
 * `controller integrations list` on a guess.
 *
 * **These are *additional* skills, not the complete list.** Each provider
 * (Codex, Claude, Anita) has its own native skill system — built-in
 * capabilities, per-agent user/repo skills in `~/.codex/skills/`,
 * `~/.claude/skills/`, `.anita/skills/`, repo conventions, plugin
 * marketplaces, etc. Controller layers an *app-owned* catalog on top of
 * that. Calling it `<additional_skills>` makes the layering explicit so
 * the agent doesn't treat this as the full universe and forget about its
 * own skills. The orchestrator's `/<name>` activation flow (issue #98)
 * still works for every skill regardless of source.
 *
 * **Invoke the CLI by its absolute install path.** Some providers (Codex in
 * particular) sanitize or rebuild the env before spawning user commands, so
 * the bare `controller` command may not resolve on PATH inside the agent's
 * shell. The preamble inlines the absolute install path so the agent can
 * copy/paste it verbatim; the skill bodies document the same contract.
 *
 * Only `name` + `description` are inlined; full bodies stay on demand via
 * the CLI.
 *
 * Delivery is provider-aware (see `server/routes/sessions.ts`):
 *   - Anita: passed to the CLI via `--system-prompt`, so it lands in Anita's system
 *     prompt section and is never part of the chat transcript.
 *   - Codex / Claude: prepended to the user message (framed with
 *     `framePreambleForPrompt`), since those providers have no reliable
 *     system-prompt channel in their default modes today.
 */

import { controllerCliShellPath } from "./controller-cli.js";
import { gatewayList, type ListedConnection } from "./integration-gateway.js";
import { buildMemoryBlock } from "./memory.js";
import { listUnifiedSkills } from "./unified-skills.js";
import type { SkillMetadata } from "./skills.js";

export interface ControllerPreambleOptions {
  /**
   * When supplied, the preamble includes the project's pinned memory
   * snippet (`pinned_project`) and the project's notes in the
   * `memory_index` manifest. When omitted, only the global memory
   * surface is shown. The route layer threads this from the
   * message-send `projectId` param (issue #350).
   */
  projectId?: string;
}

// Some providers (Codex) sanitize or rebuild env vars before spawning user
// commands, so the bare `controller` command is not guaranteed to resolve on
// PATH inside the agent's shell. The preamble inlines the absolute install
// path so the agent can copy/paste a working command. The path is resolved
// lazily at preamble-build time so the tests (which override
// `CONTROLLER_HOME` after module import) see the test temp home,
// not the real install path. The path is stable across rebuilds — the
// install step is idempotent (see `controller-cli.ts`).
//
// `controllerCliShellPath()` returns the same path wrapped in single quotes
// so it survives the macOS default home (`~/Library/Application Support/
// Controller`), which contains a literal space. Without the quotes, an agent
// copying the example command verbatim would hit a shell split at the space
// before the CLI ever runs.

function controllerCliNote(): string {
  return (
    `Invoke the Controller CLI by its absolute path ` +
    `\`${controllerCliShellPath()}\` — the bare \`controller\` command ` +
    `is not guaranteed to be on your PATH. Copy the full path verbatim ` +
    `from this preamble.`
  );
}

function skillsIntro(): string {
  return (
    controllerCliNote() +
    "\n\n" +
    "In addition to your own skills, Controller exposes a catalog of " +
    "*additional* skills. To use one, call " +
    `\`${controllerCliShellPath()} skills describe <name>\` for the ` +
    "full body and follow its instructions, or ask the user to invoke it " +
    "as `/<name>`. The `/<name>` picker accepts both your native skills and " +
    "Controller's."
  );
}

function integrationsIntro(): string {
  return (
    controllerCliNote() +
    "\n\n" +
    "In addition to any native tooling your provider exposes, the following " +
    "third-party integrations are connected through Controller. To discover " +
    "their tools call " +
    `\`${controllerCliShellPath()} integrations tools <name>\`; to invoke one call ` +
    `\`${controllerCliShellPath()} integrations call <name> <tool>\` ` +
    "(or `request` for raw HTTP). These integrations are *additional* — " +
    "they do not replace any native capabilities you already have."
  );
}

/**
 * Document the memory surface (issue #350). The full `<memory>` block
 * (pinned snippets + a `slug + scope + 80-char preview` index) lands
 * later in the preamble; the intro here teaches the agent when to
 * reach for it and how to read a full note on demand. Without this
 * the manifest is invisible — the agent would have to guess at the
 * CLI surface from the index alone, which is the exact failure mode
 * the design is meant to avoid.
 */
function memoryIntro(): string {
  const cli = controllerCliShellPath();
  return [
    controllerCliNote(),
    "",
    "Controller has an app-owned **memory** layer where the user persists",
    "facts that survive across sessions: preferences, conventions, deploy",
    "processes, library choices, \"as we discussed X\". The",
    "`<memory_index>` block in this preamble lists every note by slug + scope +",
    "first-line preview — read it before answering questions about preferences,",
    "conventions, deploys, library choice, or anything phrased as \"as we",
    "discussed\" or \"we agreed\".",
    "",
    "Workflow:",
    `1. Scan the \`<memory_index>\` block. If a slug looks relevant, call \`${cli} memory read <scope> <slug>\` to fetch the body.`,
    `2. \`${cli} memory search <query>\` is the broader version — useful when the user's prompt doesn't lexically match any slug.`,
    `3. When the user gives you a durable preference or fact, offer to write it via \`${cli} memory write <scope> <slug> --content <text>\` instead of just acknowledging.`,
    "",
    "Scope is `global` (every session) or `project` (per onboarded project).",
    "When the CLI is invoked from a session, omit `--project` and the server",
    "resolves the project from the active session. Do not read memory for",
    "unrelated tasks — the index alone is enough to decide relevance. If",
    "`memory search` returns nothing relevant, say so; do not fabricate from",
    "context.",
  ].join("\n");
}

/**
 * Document the three same-session loop primitives (issue #339):
 * `wake --delay` for deferred follow-ups, `goal set` for condition-driven
 * loops, and `monitor start` for event-stream watches. Each primitive is
 * framed with the canonical CI-loop worked example so an agent can adopt
 * it without reading separate docs.
 *
 * Returns `null` when the agent preamble doesn't need a primitives block
 * (the empty case keeps the existing tests stable).
 */
function loopPrimitivesIntro(): string {
  const cli = controllerCliShellPath();
  return [
    controllerCliNote(),
    "",
    "Controller ships three same-session primitives for condition-driven",
    "loops (issue #339). All three compose with the existing session",
    "queue: a follow-up turn runs once the current turn ends, in the same",
    "session, with full context.",
    "",
    "  1. Deferred follow-up. `wake <self> \"...\" --delay 30s`",
    `     enqueues a follow-up and holds it for the duration (forms: 30s,`,
    `     5m, 1h, 2d). The wakes consumer fires it on the next scheduler`,
    `     tick via \`${cli} sessions wake <self> "..." --delay 30s\`.`,
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
    `   ${cli} sessions goal set <self> --condition \\`,
    `     "all required CI checks on PR #N are SUCCESS" --max-turns 5`,
    `   ${cli} sessions wake <self> "Check gh pr checks <N>; if all`,
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
  ].join("\n");
}

/**
 * Document the cross-session discoverability surface (issue #353).
 *
 * The same-session primitives above assume you already know your own
 * session id. They don't — the agent preamble is rendered before the
 * session id is assigned, and there's no other way for the agent to
 * learn it. `sessions list` is the CLI verb that closes the gap: it
 * enumerates every session on the project, and `--parent self` resolves
 * to the calling session's id via the `CONTROLLER_SESSION_ID` env var
 * the orchestrator injects at agent spawn time. With it, the agent can
 * (a) discover its own id from `controller sessions list --json | jq
 * -r '.[] | select(.provider == "codex") | .id'` (the row whose
 * `provider` matches the agent that was just spawned), and (b) find its
 * own children via `controller sessions list --parent self`.
 */
function sessionsListIntro(): string | null {
  const cli = controllerCliShellPath();
  return [
    controllerCliNote(),
    "",
    "Cross-session discoverability (issue #353):",
    "",
    `  - \`${cli} sessions list [<project>]\` enumerates every session in`,
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
    `  - \`${cli} sessions start <message> --parent <id|self>\` records`,
    `    the new session as a child of the given parent. Use \`self\` to`,
    `    spawn a child of yourself (the coordinator pattern from #351).`,
    `    \`<message>\` is a positional argument in the new shape`,
    `    (issue #355).`,
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
    `   SELF=$(${cli} sessions list --json | jq -r 'select(.provider == "codex") | .id' | head -1)`,
    `   # 2. Spawn a child pinned to yourself.`,
    `   ${cli} sessions start "Review the PR from session $SELF" \\`,
    `     --worktree <wtId> --parent "$SELF" --agent claude`,
    `   # 3. Later, see your children.`,
    `   ${cli} sessions list --parent "$SELF" --json`,
  ].join("\n");
}

const EMPTY_SKILLS =
  "<additional_skills>\n(none configured)\n</additional_skills>";
const EMPTY_INTEGRATIONS =
  "<additional_integrations>\n(none configured)\n</additional_integrations>";

/**
 * Build the `<additional_skills>` block. Lists Controller's app-owned
 * unified skill catalog only — the per-agent skill system (Codex's
 * `~/.codex/skills/`, Claude's `~/.claude/skills/`, Anita's
 * `.anita/skills/`, repo conventions, built-ins) is a separate layer the
 * agent already has access to on its own and is intentionally not surfaced
 * here. The `controller skills describe <name>` drill-down only resolves
 * the unified catalog, so listing per-agent skills would point the agent
 * at a 404 on the advertised path.
 */
export async function buildAvailableSkillsBlock(): Promise<string> {
  const skills: SkillMetadata[] = await listUnifiedSkills();
  if (skills.length === 0) return EMPTY_SKILLS;

  const lines = skills.map((s) => formatSkillLine(s));
  return ["<additional_skills>", ...lines, "</additional_skills>"].join("\n");
}

/**
 * Build the `<additional_integrations>` block. Lists only enabled
 * third-party connections (matches `gatewayList`); sorted by name for
 * stable output. This is layered on top of whatever native tools the
 * provider already exposes.
 */
export async function buildAvailableIntegrationsBlock(): Promise<string> {
  const connections = await gatewayList();
  if (connections.length === 0) return EMPTY_INTEGRATIONS;
  const sorted = [...connections].sort((a, b) => a.name.localeCompare(b.name));
  const lines = sorted.map((c) => formatIntegrationLine(c));
  return [
    "<additional_integrations>",
    ...lines,
    "</additional_integrations>",
  ].join("\n");
}

/**
 * Build the full Controller preamble. The static identity line is always
 * present; the skills and integrations blocks are appended in parallel and
 * their order is stable so the output is reproducible. Project management
 * (`worktrees` + `sessions` CLI surfaces) used to live here as its own
 * block but moved to the `controller-worktrees` managed skill so the
 * preamble only enumerates *what's available* and the skill carries the
 * *how to use it*. The skills catalog still surfaces `controller-worktrees`
 * to the agent with its description.
 *
 * The memory block (issue #350) is appended last so the manifest sits
 * next to the intros that explain it. When the home is empty the block
 * still renders, with explicit `(empty)` placeholders, so the agent
 * learns the surface exists the very first turn.
 */
export async function buildControllerPreamble(
  options?: ControllerPreambleOptions,
): Promise<string> {
  const [skillsBlock, integrationsBlock, memoryBlock] = await Promise.all([
    buildAvailableSkillsBlock(),
    buildAvailableIntegrationsBlock(),
    buildMemoryBlock({ projectId: options?.projectId }),
  ]);
  return [
    "You are running inside Controller, a desktop orchestrator for coding agents.",
    "",
    skillsIntro(),
    "",
    skillsBlock,
    "",
    integrationsIntro(),
    "",
    integrationsBlock,
    "",
    memoryIntro(),
    "",
    memoryBlock,
    "",
    loopPrimitivesIntro(),
    "",
    sessionsListIntro(),
  ].join("\n");
}

function formatSkillLine(skill: SkillMetadata): string {
  return `- ${skill.name} — ${skill.description || "(no description)"}`;
}

function formatIntegrationLine(connection: ListedConnection): string {
  return `- ${connection.name} (${connection.mode}/${connection.kind}) — ${connection.summary}`;
}

/**
 * Frame the preamble as a non-echoed context block for providers that have no
 * system-prompt flag today (Codex in default mode, Claude in default mode),
 * so it can be prepended to the user message without the agent repeating it
 * back. Anita receives the preamble via `--system-prompt` instead and does not
 * need this wrapper — see the call site in `server/routes/sessions.ts`.
 */
export function framePreambleForPrompt(preamble: string): string {
  return [
    "[Controller environment — context only, do not repeat back to the user]",
    preamble,
    "",
    "---",
    "",
  ].join("\n");
}
