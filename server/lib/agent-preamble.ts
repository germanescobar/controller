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
 * **Skills are restricted to the unified (app-owned) catalog.** Per-agent
 * user/repo skills are deliberately not advertised here because
 * `controller skills describe` only resolves the unified catalog — listing
 * per-agent skills would point the agent at a 404 on the drill-down path.
 * Per-agent skills are still available via the orchestrator's `/<name>`
 * activation flow (issue #98); the preamble is a discoverability surface
 * for what the CLI can actually fetch.
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

import { gatewayList, type ListedConnection } from "./integration-gateway.js";
import { listUnifiedSkills } from "./unified-skills.js";
import type { SkillMetadata } from "./skills.js";

export interface ControllerPreambleOptions {
  // Reserved for future per-session options (e.g. feature flags).
}

const SKILLS_INTRO =
  "The following skills are available. To use one, call `controller skills describe <name>` " +
  "for the full body and follow its instructions, or ask the user to invoke it as `/<name>`.";

const INTEGRATIONS_INTRO =
  "The following integrations are available. To discover their tools call " +
  "`controller integrations tools <name>`; to invoke one call " +
  "`controller integrations call <name> <tool>` (or `request` for raw HTTP).";

const EMPTY_SKILLS = "<available_skills>\n(none configured)\n</available_skills>";
const EMPTY_INTEGRATIONS =
  "<available_integrations>\n(none configured)\n</available_integrations>";

/**
 * Build the `<available_skills>` block. Only the unified (app-owned) catalog
 * is listed — per-agent user/repo skills are intentionally excluded because
 * the advertised drill-down (`controller skills describe <name>`) only
 * resolves unified skills.
 */
export async function buildAvailableSkillsBlock(): Promise<string> {
  const skills: SkillMetadata[] = await listUnifiedSkills();
  if (skills.length === 0) return EMPTY_SKILLS;

  const lines = skills.map((s) => formatSkillLine(s));
  return ["<available_skills>", ...lines, "</available_skills>"].join("\n");
}

/**
 * Build the `<available_integrations>` block. Lists only enabled connections
 * (matches `gatewayList`); sorted by name for stable output.
 */
export async function buildAvailableIntegrationsBlock(): Promise<string> {
  const connections = await gatewayList();
  if (connections.length === 0) return EMPTY_INTEGRATIONS;
  const sorted = [...connections].sort((a, b) => a.name.localeCompare(b.name));
  const lines = sorted.map((c) => formatIntegrationLine(c));
  return ["<available_integrations>", ...lines, "</available_integrations>"].join("\n");
}

/**
 * Build the full Controller preamble. The static identity line is always
 * present; the skills and integrations blocks are appended in parallel and
 * their order is stable so the output is reproducible.
 */
export async function buildControllerPreamble(
  _options?: ControllerPreambleOptions
): Promise<string> {
  const [skillsBlock, integrationsBlock] = await Promise.all([
    buildAvailableSkillsBlock(),
    buildAvailableIntegrationsBlock(),
  ]);
  return [
    "You are running inside Controller, a desktop orchestrator for coding agents.",
    "",
    SKILLS_INTRO,
    "",
    skillsBlock,
    "",
    INTEGRATIONS_INTRO,
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
