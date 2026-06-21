/*
 * Import existing per-agent skills into the unified skill catalog (issue #145).
 *
 * Users often have skills installed under per-agent locations:
 *   - ~/.ada/skills/<name>/SKILL.md
 *   - ~/.codex/skills/<name>/SKILL.md (+ ~/.codex/skills/.system/<name>/SKILL.md)
 *   - ~/.claude/skills/<name>/SKILL.md
 *   - <project>/.ada/skills/<name>/SKILL.md
 *   - <project>/.codex/skills/<name>/SKILL.md
 *   - <project>/.claude/skills/<name>/SKILL.md
 *
 * The unified catalog (issue #134) lives under the orchestrator home
 * (`~/coding-orchestrator/skills/<name>/SKILL.md`). Importing copies a
 * per-agent skill's content into the unified catalog so it is owned by the
 * app and wins by name over per-provider matches for all sessions.
 *
 * Collision policy (default): **skip** duplicates. The user can manually
 * rename the existing unified skill before re-importing, or the import
 * endpoint accepts an explicit `overwrite` flag per-skill for callers that
 * know what they're doing. Skipped / imported / errored skills are returned
 * per-skill so the caller can show a clear summary.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSkillFile, type SkillMetadata, type SkillScope } from "./skills.js";
import { getProjects } from "./projects.js";
import { listUnifiedSkills, createUnifiedSkill, deleteUnifiedSkill } from "./unified-skills.js";

/** A per-agent skill surfaced for import. */
export interface ImportableSkill {
  name: string;
  description: string;
  /** Provider id (`ada` / `codex` / `claude`). */
  providerId: string;
  /** Original scope (`user` / `system` / `repo`). */
  scope: SkillScope;
  /** Absolute path to the source `SKILL.md`. */
  sourcePath: string;
  /**
   * The project root this skill was discovered under, when `scope === "repo"`.
   * `null` for user/system skills.
   */
  projectPath: string | null;
}

/** Result of importing one skill. */
export interface SkillImportResult {
  /** The provider id the skill was imported from. */
  providerId: string;
  /** Original scope. */
  scope: SkillScope;
  name: string;
  /** What happened during the import. */
  status: "imported" | "skipped" | "error";
  /** Human-readable detail for `skipped` / `error`. */
  reason?: string;
  /** For `imported`, the unified-skill metadata that was written. */
  metadata?: SkillMetadata;
}

export interface SkillImportRequest {
  /** Skills to import. */
  selections: Array<{
    providerId: string;
    /** Source path to the `SKILL.md` (unique per discovery entry). */
    sourcePath: string;
    /**
     * Original scope from discovery (`user` / `system` / `repo`). Recorded in
     * the import result so the caller can display provenance; not persisted
     * into the unified catalog.
     */
    scope: SkillScope;
    /**
     * If `true`, overwrite an existing unified skill with the same name.
     * Defaults to `false` (skip duplicates).
     */
    overwrite?: boolean;
  }>;
}

export interface SkillImportResponse {
  results: SkillImportResult[];
}

/** Test seam: lets tests redirect home/CODEX_HOME. */
export interface SkillImportEnv {
  homedir: () => string;
  codexHome: () => string;
  getProjects: typeof getProjects;
}

function defaultEnv(): SkillImportEnv {
  return {
    homedir: () => os.homedir(),
    codexHome: () => {
      const override = process.env.CODEX_HOME?.trim();
      if (!override) return path.join(os.homedir(), ".codex");
      if (override === "~") return os.homedir();
      if (override.startsWith(`~${path.sep}`)) {
        return path.join(os.homedir(), override.slice(2));
      }
      return override;
    },
    getProjects,
  };
}

// ---------------------------------------------------------------------------
// Per-provider scan roots — kept in sync with the loader in `skills.ts` so
// discovery finds the same files the agent would see.
// ---------------------------------------------------------------------------

interface ProviderScanConfig {
  providerId: string;
  userDirs(): string[];
  systemDirs?(): string[];
  repoDirName: string;
}

function providerConfigs(env: SkillImportEnv): ProviderScanConfig[] {
  return [
    {
      providerId: "ada",
      userDirs: () => [path.join(env.homedir(), ".ada", "skills")],
      repoDirName: ".ada/skills",
    },
    {
      providerId: "codex",
      userDirs: () => [path.join(env.codexHome(), "skills")],
      systemDirs: () => [path.join(env.codexHome(), "skills", ".system")],
      repoDirName: ".codex/skills",
    },
    {
      providerId: "claude",
      userDirs: () => [path.join(env.homedir(), ".claude", "skills")],
      repoDirName: ".claude/skills",
    },
  ];
}

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
  providerId: string,
  scope: SkillScope,
  projectPath: string | null
): Promise<ImportableSkill | null> {
  const skillFile = path.join(dir, "SKILL.md");
  let raw: string;
  try {
    raw = await fs.readFile(skillFile, "utf-8");
  } catch {
    return null;
  }
  const parsed = parseSkillFile(raw);
  if (!parsed) return null;
  const name = (parsed.metadata.name ?? "").trim();
  if (!name) return null;
  return {
    name,
    description: (parsed.metadata.description ?? "").trim(),
    providerId,
    scope,
    sourcePath: skillFile,
    projectPath,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Scan all known per-agent skill locations and return one record per skill
 * we can parse. Each record is unique by `(sourcePath)` so the same skill
 * can't be imported twice. Repo skills are scanned for every registered
 * project so the user doesn't have to point at a specific cwd.
 */
export async function discoverImportableSkills(
  env: SkillImportEnv = defaultEnv()
): Promise<ImportableSkill[]> {
  const out: ImportableSkill[] = [];
  const seenPaths = new Set<string>();

  for (const config of providerConfigs(env)) {
    for (const base of config.userDirs()) {
      for (const dir of await listSkillDirs(base)) {
        const skill = await readMetadataFromDir(dir, config.providerId, "user", null);
        if (skill && !seenPaths.has(skill.sourcePath)) {
          seenPaths.add(skill.sourcePath);
          out.push(skill);
        }
      }
    }
    if (config.systemDirs) {
      for (const base of config.systemDirs()) {
        for (const dir of await listSkillDirs(base)) {
          const skill = await readMetadataFromDir(
            dir,
            config.providerId,
            "system",
            null
          );
          if (skill && !seenPaths.has(skill.sourcePath)) {
            seenPaths.add(skill.sourcePath);
            out.push(skill);
          }
        }
      }
    }
    // Repo skills for every registered project. The repo dir follows the
    // same `<cwd>/.<provider>/skills/` convention the loader uses.
    const projects = await env.getProjects();
    for (const project of projects) {
      const base = path.join(project.path, config.repoDirName);
      for (const dir of await listSkillDirs(base)) {
        const skill = await readMetadataFromDir(
          dir,
          config.providerId,
          "repo",
          project.path
        );
        if (skill && !seenPaths.has(skill.sourcePath)) {
          seenPaths.add(skill.sourcePath);
          out.push(skill);
        }
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Import the selected skills into the unified catalog. Per-skill results are
 * returned so the caller can show exactly what was imported, skipped
 * (collision), or errored. By default, name collisions with existing unified
 * skills are skipped; pass `overwrite: true` per-skill to replace them.
 */
export async function importSkills(
  request: SkillImportRequest,
  env: SkillImportEnv = defaultEnv()
): Promise<SkillImportResponse> {
  const results: SkillImportResult[] = [];
  // Read the existing catalog once and update it incrementally so two
  // selections in the same request don't race past each other on collisions.
  let unified = await listUnifiedSkills();

  for (const selection of request.selections) {
    const providerIds = new Set(providerConfigs(env).map((c) => c.providerId));
    if (!providerIds.has(selection.providerId)) {
      results.push({
        providerId: selection.providerId,
        scope: "user",
        name: "",
        status: "error",
        reason: `Unknown agent provider: ${selection.providerId}`,
      });
      continue;
    }

    const sourceSkill = await readImportableSource(selection.sourcePath);
    if (!sourceSkill) {
      results.push({
        providerId: selection.providerId,
        scope: selection.scope,
        name: "",
        status: "error",
        reason: `Skill file not found or unreadable: ${selection.sourcePath}`,
      });
      continue;
    }

    const collision = unified.some(
      (entry) => entry.name.toLowerCase() === sourceSkill.name.toLowerCase()
    );
    if (collision && !selection.overwrite) {
      results.push({
        providerId: selection.providerId,
        scope: selection.scope,
        name: sourceSkill.name,
        status: "skipped",
        reason: `A unified skill named "${sourceSkill.name}" already exists. Delete it first or import with overwrite.`,
      });
      continue;
    }

    if (collision && selection.overwrite) {
      // Overwrite path: delete the existing unified skill first.
      await deleteUnifiedSkill(sourceSkill.name);
    }

    const created = await createUnifiedSkill({
      name: sourceSkill.name,
      description: sourceSkill.description,
      body: sourceSkill.body,
    });
    if ("error" in created) {
      results.push({
        providerId: selection.providerId,
        scope: selection.scope,
        name: sourceSkill.name,
        status: "error",
        reason: created.error,
      });
      continue;
    }
    unified = [
      ...unified.filter(
        (entry) => entry.name.toLowerCase() !== created.name.toLowerCase()
      ),
      created,
    ];
    results.push({
      providerId: selection.providerId,
      scope: selection.scope,
      name: sourceSkill.name,
      status: "imported",
      metadata: created,
    });
  }

  return { results };
}

interface SourceSkill {
  name: string;
  description: string;
  body: string;
}

async function readImportableSource(sourcePath: string): Promise<SourceSkill | null> {
  let raw: string;
  try {
    raw = await fs.readFile(sourcePath, "utf-8");
  } catch {
    return null;
  }
  const parsed = parseSkillFile(raw);
  if (!parsed) return null;
  const name = (parsed.metadata.name ?? "").trim();
  if (!name) return null;
  return {
    name,
    description: (parsed.metadata.description ?? "").trim(),
    body: parsed.body,
  };
}
