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

import { controllerCliInstalledPath } from "./controller-cli.js";
import { gatewayList, type ListedConnection } from "./integration-gateway.js";
import { listUnifiedSkills } from "./unified-skills.js";
import type { SkillMetadata } from "./skills.js";

export interface ControllerPreambleOptions {
  // Reserved for future per-session options (e.g. feature flags).
}

// Some providers (Codex) sanitize or rebuild env vars before spawning user
// commands, so the bare `controller` command is not guaranteed to resolve on
// PATH inside the agent's shell. The preamble inlines the absolute install
// path so the agent can copy/paste a working command. The path is resolved
// lazily at preamble-build time so the tests (which override
// `CONTROLLER_HOME` after module import) see the test temp home,
// not the real install path. The path is stable across rebuilds — the
// install step is idempotent (see `controller-cli.ts`).

function controllerCliNote(): string {
  return (
    `Invoke the Controller CLI by its absolute path ` +
    `\`${controllerCliInstalledPath()}\` — the bare \`controller\` command ` +
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
    `\`${controllerCliInstalledPath()} skills describe <name>\` for the ` +
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
    `\`${controllerCliInstalledPath()} integrations tools <name>\`; to invoke one call ` +
    `\`${controllerCliInstalledPath()} integrations call <name> <tool>\` ` +
    "(or `request` for raw HTTP). These integrations are *additional* — " +
    "they do not replace any native capabilities you already have."
  );
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
 */
export async function buildControllerPreamble(
  _options?: ControllerPreambleOptions,
): Promise<string> {
  const [skillsBlock, integrationsBlock] = await Promise.all([
    buildAvailableSkillsBlock(),
    buildAvailableIntegrationsBlock(),
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
