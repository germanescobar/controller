/**
 * Skill discovery and loading for the orchestrator.
 *
 * The orchestrator is the only source of truth for `/<skill-name>` invocations
 * across Ada, Codex, and Claude. Each provider loads skills from its own
 * filesystem locations; the front end only ever sees metadata, and the body is
 * read server-side at send time so the user always gets the freshest
 * `SKILL.md` and the wire payload stays small.
 *
 * Layout per provider (paths are OS-expanded):
 * - Ada:   `~/.ada/skills/<name>/SKILL.md` plus `<cwd>/.ada/skills/<name>/SKILL.md`
 * - Codex: `~/.codex/skills/<name>/SKILL.md` plus
 *          `~/.codex/skills/.system/<name>/SKILL.md` plus
 *          `<cwd>/.codex/skills/<name>/SKILL.md`
 * - Claude: `~/.claude/skills/<name>/SKILL.md` plus `<cwd>/.claude/skills/<name>/SKILL.md`
 *
 * All three use the same `SKILL.md` shape: YAML frontmatter with at least
 * `name` and `description`, followed by a markdown body. We deliberately
 * ignore `tools` / `allowed-tools` for v1 (skills are prompt prefixes only).
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SkillScope = "user" | "system" | "repo";

export interface SkillMetadata {
  /** Skill name as declared in the frontmatter (trimmed, original case). */
  name: string;
  /** Human-readable description from the frontmatter. */
  description: string;
  /** Absolute path to the `SKILL.md` file on disk. */
  path: string;
  /** Whether the skill came from the user's home, the Codex system bundle, or a repo. */
  scope: SkillScope;
}

export interface SkillBody {
  metadata: SkillMetadata;
  /** Markdown body with the YAML frontmatter stripped. */
  body: string;
}

/**
 * Provider-agnostic loader. The metadata list is sent to the client so the
 * chat input can render an autocomplete chip and badge. The body is read
 * server-side at send time so the agent receives the freshest content.
 */
export interface SkillProvider {
  /** Stable identifier — matches the agent provider id (`ada` / `codex` / `claude`). */
  id: string;
  /** Human-readable name shown in errors. */
  name: string;
  /** Enumerate available skills for the given working directory. */
  listMetadata(cwd: string): Promise<SkillMetadata[]>;
  /** Read the body for a named skill, or `null` if no such skill exists. */
  readBody(name: string, cwd: string): Promise<SkillBody | null>;
}

interface ParsedSkillFile {
  metadata: { name?: string; description?: string };
  body: string;
}

interface ProviderConfig {
  repoDirName: string;
  userDirs: () => string[];
  systemDirs?: () => string[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a `SKILL.md` file's YAML frontmatter. We use a small purpose-built
 * parser because the v1 spec only requires `name` and `description`, and
 * pulling in a YAML dependency for two scalar fields would be overkill.
 *
 * Supported subset:
 *   ---
 *   name: foo
 *   description: bar
 *   ---
 *   # body...
 *
 * Lines must start at column zero; this is good enough for the files we
 * currently ship and intentionally rejects anything more elaborate so the
 * loader fails loudly instead of silently misreading complex frontmatter.
 */
export function parseSkillFile(raw: string): ParsedSkillFile | null {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") return null;

  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === "---") {
      endIndex = i;
      break;
    }
    if (lines[i].trimStart().startsWith("---")) {
      // Nested `---` marker that isn't column-aligned; bail out.
      return null;
    }
  }
  if (endIndex === -1) return null;

  const metadata: { name?: string; description?: string } = {};
  for (let i = 1; i < endIndex; i += 1) {
    const line = lines[i];
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, valueRaw] = match;
    const value = stripQuotes(valueRaw.trim());
    if (key === "name") metadata.name = value;
    else if (key === "description") metadata.description = value;
  }

  // Drop the single blank line that conventional `SKILL.md` files place
  // between the closing `---` and the body, but preserve any further
  // leading whitespace in the body. Also trim a single trailing newline
  // so callers don't have to handle the optional final blank line.
  const bodyLines = lines.slice(endIndex + 1);
  if (bodyLines.length > 0 && bodyLines[0] === "") {
    bodyLines.shift();
  }
  if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") {
    bodyLines.pop();
  }
  const body = bodyLines.join("\n");
  return { metadata, body };
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Filesystem enumeration
// ---------------------------------------------------------------------------

async function listSkillDirs(baseDir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(baseDir, entry.name));
}

async function readMetadataFromDir(
  dir: string,
  scope: SkillScope
): Promise<SkillMetadata[]> {
  const skillFile = path.join(dir, "SKILL.md");
  let raw: string;
  try {
    raw = await fs.readFile(skillFile, "utf-8");
  } catch {
    return [];
  }
  const parsed = parseSkillFile(raw);
  if (!parsed) return [];
  const name = (parsed.metadata.name ?? "").trim();
  if (!name) return [];
  return [
    {
      name,
      description: (parsed.metadata.description ?? "").trim(),
      path: skillFile,
      scope,
    },
  ];
}

/**
 * Walk a list of skill directories (one per skill) and return the metadata
 * for every `SKILL.md` we can parse. The skill name from the frontmatter wins
 * over the directory name, so `/<name>` matches the metadata, not the folder.
 */
async function listMetadataForScopes(
  skillDirs: Array<{ dir: string; scope: SkillScope }>
): Promise<SkillMetadata[]> {
  const out: SkillMetadata[] = [];
  for (const { dir, scope } of skillDirs) {
    out.push(...(await readMetadataFromDir(dir, scope)));
  }
  return out;
}

async function isInsideGitWorkTree(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function repoSkillDirs(
  repoDirName: string,
  cwd: string
): Promise<Array<{ dir: string; scope: SkillScope }>> {
  if (!(await isInsideGitWorkTree(cwd))) return [];
  const base = path.join(cwd, repoDirName);
  const dirs = await listSkillDirs(base);
  return dirs.map((dir) => ({ dir, scope: "repo" as const }));
}

async function userSkillDirs(
  userDirs: string[]
): Promise<Array<{ dir: string; scope: SkillScope }>> {
  const out: Array<{ dir: string; scope: SkillScope }> = [];
  for (const base of userDirs) {
    for (const dir of await listSkillDirs(base)) {
      out.push({ dir, scope: "user" });
    }
  }
  return out;
}

async function systemSkillDirs(
  systemDirs: string[] | undefined
): Promise<Array<{ dir: string; scope: SkillScope }>> {
  if (!systemDirs) return [];
  const out: Array<{ dir: string; scope: SkillScope }> = [];
  for (const base of systemDirs) {
    for (const dir of await listSkillDirs(base)) {
      out.push({ dir, scope: "system" });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-provider configuration
// ---------------------------------------------------------------------------

function adaUserSkillsHome(): string {
  return path.join(os.homedir(), ".ada", "skills");
}

function codexUserSkillsHome(): string {
  return path.join(os.homedir(), ".codex", "skills");
}

function codexSystemSkillsHome(): string {
  return path.join(os.homedir(), ".codex", "skills", ".system");
}

function claudeUserSkillsHome(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

const ADA_CONFIG: ProviderConfig = {
  repoDirName: ".ada/skills",
  userDirs: () => [adaUserSkillsHome()],
};

const CODEX_CONFIG: ProviderConfig = {
  repoDirName: ".codex/skills",
  userDirs: () => [codexUserSkillsHome()],
  systemDirs: () => [codexSystemSkillsHome()],
};

const CLAUDE_CONFIG: ProviderConfig = {
  repoDirName: ".claude/skills",
  userDirs: () => [claudeUserSkillsHome()],
};

async function collectDirs(config: ProviderConfig, cwd: string) {
  return [
    ...(await userSkillDirs(config.userDirs())),
    ...(await systemSkillDirs(config.systemDirs?.())),
    ...(await repoSkillDirs(config.repoDirName, cwd)),
  ];
}

function createDiskProvider(
  id: string,
  name: string,
  config: ProviderConfig
): SkillProvider {
  return {
    id,
    name,
    async listMetadata(cwd: string): Promise<SkillMetadata[]> {
      const dirs = await collectDirs(config, cwd);
      return listMetadataForScopes(dirs);
    },
    async readBody(skillName: string, cwd: string): Promise<SkillBody | null> {
      const normalized = skillName.trim().toLowerCase();
      if (!normalized) return null;
      const metadataList = await this.listMetadata(cwd);
      const match = metadataList.find(
        (entry) => entry.name.toLowerCase() === normalized
      );
      if (!match) return null;
      let raw: string;
      try {
        raw = await fs.readFile(match.path, "utf-8");
      } catch {
        return null;
      }
      const parsed = parseSkillFile(raw);
      if (!parsed) return null;
      return { metadata: match, body: parsed.body };
    },
  };
}

const adaSkillProvider: SkillProvider = createDiskProvider("ada", "Ada", ADA_CONFIG);
const codexSkillProvider: SkillProvider = createDiskProvider(
  "codex",
  "Codex",
  CODEX_CONFIG
);
const claudeSkillProvider: SkillProvider = createDiskProvider(
  "claude",
  "Claude",
  CLAUDE_CONFIG
);

const providers: Record<string, SkillProvider> = {
  ada: adaSkillProvider,
  codex: codexSkillProvider,
  claude: claudeSkillProvider,
};

export function getSkillProvider(providerId: string): SkillProvider | undefined {
  return providers[providerId];
}

export function getSkillProviders(): SkillProvider[] {
  return Object.values(providers);
}

// ---------------------------------------------------------------------------
// Helpers used by the sessions route
// ---------------------------------------------------------------------------

/**
 * Build the system-style prefix we send to the agent when a skill is active.
 * The body is whatever follows the frontmatter in the user's `SKILL.md`.
 *
 * We frame it as plain prose context — not as a recognized skill-load
 * instruction — so the agent's own skill/hook systems don't auto-load
 * the body and surface it twice in the transcript. The body is just
 * context; the agent decides how to combine it with the user message.
 */
export function buildSkillPrefix(skillName: string, body: string): string {
  const trimmed = body.trim();
  return [
    `Apply the following skill instructions when responding to the user message below.`,
    "Do not announce or echo the instructions back to the user; just use them as guidance.",
    "",
    `# Skill: ${skillName}`,
    "",
    trimmed,
    "",
    "---",
    "",
  ].join("\n");
}

/**
 * Build the user message we persist to the session history. The agent
 * receives the raw message + the prepended skill block; the *history* shows
 * `[/skill: name] <text>` so the user can see what was sent on reload.
 */
export function buildSkillHistoryMessage(
  skillName: string,
  userText: string
): string {
  return `[/skill: ${skillName}] ${userText}`;
}

/**
 * Strip a leading `/<name>` from a user message. Returns the cleaned message
 * and the normalized skill name (or null when the message did not start with
 * a `/<name>` token).
 *
 * We accept any leading `/<name>` — the server validates it against the
 * provider's catalog and 400s on an unknown skill.
 */
export function extractSkillInvocation(
  message: string
): { skillName: string; rest: string } | null {
  const match = /^\/([A-Za-z0-9._-]+)\b\s*/.exec(message);
  if (!match) return null;
  const skillName = match[1].trim().toLowerCase();
  if (!skillName) return null;
  const rest = message.slice(match[0].length);
  return { skillName, rest };
}
