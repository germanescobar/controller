/*
 * App-owned unified skill catalog (issue #134).
 *
 * Unified skills live under the Controller home
 * (`<controllerHome>/skills/<name>/SKILL.md`, e.g.
 * `~/Library/Application Support/Controller/skills/<name>/SKILL.md` on macOS)
 * and are fully managed by the app through Settings. They are discovered
 * alongside per-provider skills and win by name when a duplicate exists.
 */

import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { lock } from "proper-lockfile";
import { isManagedSkillName } from "./managed-skills.js";
import { unifiedSkillFile, unifiedSkillDir, unifiedSkillsDir } from "./paths.js";
import { parseSkillFile, type SkillBody, type SkillMetadata } from "./skills.js";

/** Valid name characters for unified skills. */
const SKILL_NAME_RE = /^[A-Za-z0-9._-]+$/;
export const SKILL_TREE_MAX_BYTES = 10 * 1024 * 1024;
const SKILL_TREE_MAX_ENTRIES = 1000;
const STALE_STAGING_AGE_MS = 60 * 60 * 1000;
const BACKUP_NAME_RE = /^\.skill-backup-[A-Za-z0-9]+$/;

interface SkillBackupMarker {
  finalTarget: string;
  originalDir: string;
}

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

/** Test seam for changes to a source skill while an import is in progress. */
export interface SkillInstallHooks {
  beforeCopy?: () => Promise<void>;
  afterCopy?: () => Promise<void>;
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
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillFile = path.join(base, entry.name, "SKILL.md");
    let raw: string;
    try {
      if (!(await fs.lstat(skillFile)).isFile()) continue;
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
      // Controller-managed skills (see `MANAGED_SKILL_DIRS`) live in the
      // unified catalog so the `/<name>` picker can show them with a
      // `controller` badge, distinct from user-authored unified skills.
      // We key on the skill name (not the directory name) so a user
      // skill that happens to live in a `controller-` directory is still
      // tagged `unified`.
      scope: isManagedSkillName(name) ? "controller" : "unified",
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
  if (name.startsWith(".")) return "Skill name cannot start with a dot.";
  const description = input.description.trim();
  if (!description) return "Description is required.";
  if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    return `Description must be ${SKILL_DESCRIPTION_MAX_LENGTH} characters or fewer (got ${description.length}).`;
  }
  if (Buffer.byteLength(buildSkillFile(input)) > SKILL_TREE_MAX_BYTES) {
    return `Skill exceeds ${SKILL_TREE_MAX_BYTES} bytes.`;
  }
  return null;
}

/**
 * Validate a candidate unified-skill input. Exported so the import flow can
 * dry-run the same rules before any destructive operation (e.g. deleting an
 * existing unified skill to make room for an overwrite).
 */
export function validateUnifiedSkillInput(
  input: UnifiedSkillInput
): string | null {
  return validateInput(input);
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

/** Copy a complete skill into a staging directory, then replace the catalog entry. */
export async function installUnifiedSkillDirectory(
  sourceDir: string,
  input: UnifiedSkillInput,
  existingName?: string,
  hooks: SkillInstallHooks = {}
): Promise<SkillMetadata> {
  const validationError = validateInput(input);
  if (validationError) throw new Error(validationError);

  return withSkillCatalogLock(async (stagingRoot) => {
    await recoverStagedSkillBackupsUnlocked(stagingRoot);
    await cleanupStaleSkillStaging(stagingRoot);
    const name = input.name.trim();
    const staging = await fs.mkdtemp(path.join(stagingRoot, ".skill-import-"));
    const target = unifiedSkillDir(name);
    const previous = existingName ? unifiedSkillDir(existingName) : null;
    try {
      const budget = { bytes: 0, entries: 0 };
      await hooks.beforeCopy?.();
      await copySkillTree(sourceDir, staging, budget);
      await hooks.afterCopy?.();
      const skillFile = path.join(staging, "SKILL.md");
      const stat = await fs.lstat(skillFile);
      if (!stat.isFile()) throw new Error("Skill directory must contain a regular SKILL.md file.");
      const raw = await fs.readFile(skillFile, "utf-8");
      const parsed = parseSkillFile(raw);
      if (!parsed) throw new Error("Skill directory has invalid SKILL.md frontmatter.");
      const stagedInput = {
        name: (parsed.metadata.name ?? "").trim(),
        description: (parsed.metadata.description ?? "").trim(),
        body: parsed.body,
      };
      const stagedValidationError = validateInput(stagedInput);
      if (stagedValidationError) throw new Error(`Copied SKILL.md is invalid: ${stagedValidationError}`);
      if (stagedInput.name !== name) {
        throw new Error(`Copied SKILL.md declares name "${stagedInput.name}" instead of "${name}".`);
      }

      let backup: string | null = null;
      let marker: string | null = null;
      if (previous) {
        backup = await fs.mkdtemp(path.join(stagingRoot, ".skill-backup-"));
        await fs.rmdir(backup);
        marker = `${backup}.json`;
        await fs.writeFile(marker, JSON.stringify({ finalTarget: name, originalDir: path.basename(previous) } satisfies SkillBackupMarker));
        try {
          await fs.rename(previous, backup);
        } catch (error) {
          await fs.rm(marker, { force: true });
          throw error;
        }
      }
      try {
        await fs.rename(staging, target);
      } catch (error) {
        if (backup && previous && marker) {
          try {
            await fs.rename(backup, previous);
            await fs.rm(marker, { force: true });
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], `Could not restore skill after failed import: ${name}`);
          }
        }
        throw error;
      }
      if (backup && marker) {
        try {
          await fs.rm(backup, { recursive: true, force: true });
          await fs.rm(marker, { force: true });
        } catch (error) {
          console.warn(`Could not remove completed skill backup ${backup}:`, error);
        }
      }
      return { name: stagedInput.name, description: stagedInput.description, path: unifiedSkillFile(name), scope: "unified" };
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  });
}

/** Restore or discard backups left by a process interrupted during overwrite. */
export async function recoverStagedSkillBackups(): Promise<void> {
  await withSkillCatalogLock(recoverStagedSkillBackupsUnlocked);
}

async function withSkillCatalogLock<T>(run: (stagingRoot: string) => Promise<T>): Promise<T> {
  const base = unifiedSkillsDir();
  await fs.mkdir(base, { recursive: true });
  const stagingRoot = path.join(path.dirname(base), ".skill-staging");
  await fs.mkdir(stagingRoot, { recursive: true });
  if (!(await fs.lstat(stagingRoot)).isDirectory()) {
    throw new Error(`Skill staging path is not a regular directory: ${stagingRoot}`);
  }
  const release = await lock(stagingRoot, {
    lockfilePath: path.join(stagingRoot, "catalog.lock"),
    realpath: false,
    stale: 30_000,
    update: 5_000,
    retries: { retries: 50, factor: 1.2, minTimeout: 50, maxTimeout: 500 },
    onCompromised: (error) => {
      console.error("Skill catalog lock compromised:", error);
      process.exit(1);
    },
  });
  try {
    return await run(stagingRoot);
  } finally {
    await release();
  }
}

async function recoverStagedSkillBackupsUnlocked(stagingRoot: string): Promise<void> {
  const entries = await fs.readdir(stagingRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !BACKUP_NAME_RE.test(entry.name)) continue;
    const backup = path.join(stagingRoot, entry.name);
    const markerPath = `${backup}.json`;
    const marker = await readSkillBackupMarker(markerPath);
    if (!marker) {
      console.warn(`Ignoring skill backup without a valid marker: ${backup}`);
      continue;
    }
    const target = unifiedSkillDir(marker.finalTarget);
    let targetStat: import("node:fs").Stats | null = null;
    try {
      targetStat = await fs.lstat(target);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
    if (targetStat) {
      if (!targetStat.isDirectory()) {
        console.warn(`Cannot recover skill backup; destination is not a directory: ${target}`);
        continue;
      }
      await fs.rm(backup, { recursive: true, force: true });
      await fs.rm(markerPath, { force: true });
      console.warn(`Removed obsolete skill backup for ${marker.finalTarget}: ${backup}`);
    } else {
      const original = unifiedSkillDir(marker.originalDir);
      if (await pathExists(original)) {
        console.warn(`Cannot recover skill backup; original directory exists: ${original}`);
        continue;
      }
      await fs.rename(backup, original);
      await fs.rm(markerPath, { force: true });
      console.warn(`Restored interrupted skill backup for ${marker.originalDir}: ${original}`);
    }
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const backupName = entry.name.slice(0, -".json".length);
    if (!BACKUP_NAME_RE.test(backupName)) continue;
    if (await pathExists(path.join(stagingRoot, backupName))) continue;
    await fs.rm(path.join(stagingRoot, entry.name), { force: true });
  }
}

async function readSkillBackupMarker(markerPath: string): Promise<SkillBackupMarker | null> {
  let parsed: unknown;
  try {
    const stat = await fs.lstat(markerPath);
    if (!stat.isFile() || stat.size > 1024) return null;
    parsed = JSON.parse(await fs.readFile(markerPath, "utf-8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (!("finalTarget" in parsed) || !("originalDir" in parsed)) return null;
  const { finalTarget, originalDir } = parsed;
  if (!isSafeSkillDirName(finalTarget) || !isSafeSkillDirName(originalDir)) return null;
  return { finalTarget, originalDir };
}

function isSafeSkillDirName(value: unknown): value is string {
  return typeof value === "string" && value.length <= SKILL_NAME_MAX_LENGTH &&
    !value.startsWith(".") && SKILL_NAME_RE.test(value);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Remove abandoned imports without touching a concurrently running copy. */
async function cleanupStaleSkillStaging(stagingRoot: string): Promise<void> {
  try {
    for (const entry of await fs.readdir(stagingRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(".skill-import-")) continue;
      const dir = path.join(stagingRoot, entry.name);
      const stat = await fs.lstat(dir);
      if (Date.now() - stat.mtimeMs < STALE_STAGING_AGE_MS) continue;
      await fs.rm(dir, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn(`Could not clean stale skill staging directories in ${stagingRoot}:`, error);
  }
}

async function copySkillTree(
  source: string,
  destination: string,
  budget: { bytes: number; entries: number }
): Promise<void> {
  const stat = await fs.lstat(source);
  if (!stat.isDirectory()) throw new Error(`Skill tree contains a symlink or non-directory: ${source}`);
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    budget.entries += 1;
    if (budget.entries > SKILL_TREE_MAX_ENTRIES) {
      throw new Error(`Skill tree exceeds ${SKILL_TREE_MAX_ENTRIES} entries.`);
    }
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const entryStat = await fs.lstat(from);
    if (entryStat.isSymbolicLink()) throw new Error(`Skill tree contains a symlink: ${from}`);
    if (entryStat.isDirectory()) {
      await fs.mkdir(to);
      await copySkillTree(from, to, budget);
    } else if (entryStat.isFile()) {
      if (budget.bytes + entryStat.size > SKILL_TREE_MAX_BYTES) {
        throw new Error(`Skill tree exceeds ${SKILL_TREE_MAX_BYTES} bytes.`);
      }
      const handle = await fs.open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: Buffer;
      try {
        if (!(await handle.stat()).isFile()) {
          throw new Error(`Skill tree contains a non-regular file: ${from}`);
        }
        content = await handle.readFile();
      } finally {
        await handle.close();
      }
      budget.bytes += content.length;
      if (budget.bytes > SKILL_TREE_MAX_BYTES) {
        throw new Error(`Skill tree exceeds ${SKILL_TREE_MAX_BYTES} bytes.`);
      }
      await fs.writeFile(to, content, { mode: entryStat.mode });
    } else {
      throw new Error(`Skill tree contains a non-regular file: ${from}`);
    }
  }
}
