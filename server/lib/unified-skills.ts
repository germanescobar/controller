/*
 * App-owned unified skill catalog (issue #134).
 *
 * Unified skills live under the orchestrator home
 * (`~/coding-orchestrator/skills/<name>/SKILL.md`) and are fully managed by
 * the app through Settings. They are discovered alongside per-provider skills
 * and win by name when a duplicate exists.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { unifiedSkillFile, unifiedSkillDir, unifiedSkillsDir } from "./paths.js";
import { parseSkillFile, type SkillBody, type SkillMetadata } from "./skills.js";

/** Valid name characters for unified skills. */
const SKILL_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Maximum length for the skill name. Names longer than this are almost
 * certainly not what a user would type as a `/<name>` invocation, and the
 * filesystem is unlikely to be the limiting factor on the platforms we ship
 * to. Tightening the cap also matches what the skill-creator skill proposes.
 */
export const SKILL_NAME_MAX_LENGTH = 64;

/** Maximum length for the description field in the frontmatter. */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

export interface UnifiedSkillInput {
  name: string;
  description: string;
  body: string;
}

/** Read the entire unified skill catalog. */
export async function listUnifiedSkills(): Promise<SkillMetadata[]> {
  const base = unifiedSkillsDir();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SkillMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(base, entry.name, "SKILL.md");
    let raw: string;
    try {
      raw = await fs.readFile(skillFile, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseSkillFile(raw);
    if (!parsed) continue;
    const name = (parsed.metadata.name ?? "").trim();
    if (!name) continue;
    out.push({
      name,
      description: (parsed.metadata.description ?? "").trim(),
      path: skillFile,
      scope: "unified",
    });
  }
  return out;
}

/** Read a single unified skill by name (case-insensitive). */
export async function readUnifiedSkill(
  skillName: string
): Promise<SkillBody | null> {
  const normalized = skillName.trim().toLowerCase();
  if (!normalized) return null;

  const metadataList = await listUnifiedSkills();
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
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function validateInput(input: UnifiedSkillInput): string | null {
  const name = input.name.trim();
  if (!name) return "Skill name is required.";
  if (name.length > SKILL_NAME_MAX_LENGTH) {
    return `Skill name must be ${SKILL_NAME_MAX_LENGTH} characters or fewer (got ${name.length}).`;
  }
  if (!SKILL_NAME_RE.test(name)) {
    return "Skill name may only contain letters, numbers, dots, dashes, and underscores.";
  }
  const description = input.description.trim();
  if (!description) return "Description is required.";
  if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    return `Description must be ${SKILL_DESCRIPTION_MAX_LENGTH} characters or fewer (got ${description.length}).`;
  }
  return null;
}

function buildSkillFile(input: UnifiedSkillInput): string {
  const { name, description, body } = input;
  const trimmedBody = body.trim();
  return `---\nname: ${name.trim()}\ndescription: ${description.trim()}\n---\n\n${trimmedBody}\n`;
}

/** Rename an existing skill by changing its SKILL.md metadata and directory. */
async function renameSkillDir(oldName: string, newName: string): Promise<void> {
  const oldDir = unifiedSkillDir(oldName);
  const newDir = unifiedSkillDir(newName);
  await fs.mkdir(path.dirname(newDir), { recursive: true });
  await fs.rename(oldDir, newDir);
}

/**
 * Create a new unified skill. Returns the persisted metadata, or an error
 * string if the input is invalid or the name is already taken.
 */
export async function createUnifiedSkill(
  input: UnifiedSkillInput
): Promise<SkillMetadata | { error: string }> {
  const validationError = validateInput(input);
  if (validationError) return { error: validationError };

  const name = input.name.trim();
  const normalized = normalizeName(name);
  const existing = await listUnifiedSkills();
  if (existing.some((entry) => entry.name.toLowerCase() === normalized)) {
    return { error: `A unified skill named "${name}" already exists.` };
  }

  const dir = unifiedSkillDir(name);
  const skillFile = unifiedSkillFile(name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(skillFile, buildSkillFile(input), "utf-8");

  return {
    name,
    description: input.description.trim(),
    path: skillFile,
    scope: "unified",
  };
}

/**
 * Update an existing unified skill. The name may change as long as it does not
 * collide with another unified skill. Returns the persisted metadata or an
 * error string.
 */
export async function updateUnifiedSkill(
  originalName: string,
  input: UnifiedSkillInput
): Promise<SkillMetadata | { error: string }> {
  const validationError = validateInput(input);
  if (validationError) return { error: validationError };

  const newName = input.name.trim();
  const newNormalized = normalizeName(newName);
  const originalNormalized = normalizeName(originalName);
  const existing = await listUnifiedSkills();
  const current = existing.find(
    (entry) => entry.name.toLowerCase() === originalNormalized
  );
  if (!current) return { error: `Skill "${originalName}" not found.` };

  if (newNormalized !== originalNormalized) {
    if (existing.some((entry) => entry.name.toLowerCase() === newNormalized)) {
      return { error: `A unified skill named "${newName}" already exists.` };
    }
    await renameSkillDir(current.name, newName);
  }

  const skillFile = unifiedSkillFile(newName);
  await fs.writeFile(skillFile, buildSkillFile(input), "utf-8");

  return {
    name: newName,
    description: input.description.trim(),
    path: skillFile,
    scope: "unified",
  };
}

/** Delete a unified skill by name. */
export async function deleteUnifiedSkill(skillName: string): Promise<void> {
  const normalized = normalizeName(skillName);
  const existing = await listUnifiedSkills();
  const current = existing.find((entry) => entry.name.toLowerCase() === normalized);
  if (!current) return;

  await fs.rm(unifiedSkillDir(current.name), { recursive: true, force: true });
}
