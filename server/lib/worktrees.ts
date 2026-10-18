import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { v4 as uuidv4 } from "uuid";
import { getProject, getProjects, type Project } from "./projects.js";
import {
  RegistryParseError,
  readJsonRegistry,
  validateArray,
  withLock,
  writeJsonRegistry,
} from "./json-registry.js";
import { worktreesRegistryFile } from "./paths.js";

export interface Worktree {
  id: string;
  projectId: string;
  name: string;
  path: string;
  branch?: string;
  /** Identity of Git's administrative directory, for safe reappearance checks. */
  gitIdentity?: string;
  isMain: boolean;
  portOffset?: number;
  createdAt: string;
  setupRanAt?: string;
  setupExitCode?: number;
  setupLogPath?: string;
  origin?: "controller" | "external";
  presence?: "active" | "missing" | "removed";
  linkedPr?: { number: number; state: "OPEN" | "CLOSED" | "MERGED"; url: string };
  /** Project has a run.sh; without one there is no server to report. */
  hasRunScript?: boolean;
  serverRunning?: boolean;
}

/** Missing and removed worktrees keep their history but cannot run work. */
export function isWorktreeUnavailable(worktree: Worktree): boolean {
  return worktree.presence === "missing" || worktree.presence === "removed";
}

const MAIN_WORKTREE_NAME = "main";
const execFileAsync = promisify(execFile);
const WORKTREE_CACHE_LIMIT = 64;
interface WorktreeSnapshot {
  byProject: Map<string, Worktree[]>;
  projectsWithMain: Set<string>;
}
const worktreeCache = new Map<string, WorktreeSnapshot>();

/** Clear cached registry snapshots, primarily for tests that replace fixtures. */
export function invalidateWorktreeCache(): void {
  worktreeCache.clear();
}

async function registryVersion(file: string): Promise<string> {
  try {
    const stat = await fs.stat(file);
    // The inode and size distinguish atomic replacements with the same mtime.
    return `${stat.mtimeMs}:${stat.ino}:${stat.size}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw err;
  }
}

function cachedRegistry(key: string): WorktreeSnapshot | undefined {
  const cached = worktreeCache.get(key);
  if (!cached) return undefined;
  worktreeCache.delete(key);
  worktreeCache.set(key, cached);
  return cached;
}

function cacheRegistry(file: string, key: string, worktrees: Worktree[]): WorktreeSnapshot {
  const snapshot: WorktreeSnapshot = {
    byProject: new Map(),
    projectsWithMain: new Set(),
  };
  for (const worktree of worktrees) {
    const group = snapshot.byProject.get(worktree.projectId) ?? [];
    group.push({ ...worktree });
    snapshot.byProject.set(worktree.projectId, group);
    if (worktree.isMain) snapshot.projectsWithMain.add(worktree.projectId);
  }
  // A newer version supersedes earlier snapshots of this same file.
  for (const cachedKey of worktreeCache.keys()) {
    if (cachedKey.startsWith(`${file}\0`)) worktreeCache.delete(cachedKey);
  }
  worktreeCache.set(key, snapshot);
  if (worktreeCache.size > WORKTREE_CACHE_LIMIT) {
    worktreeCache.delete(worktreeCache.keys().next().value!);
  }
  return snapshot;
}

function projectWorktrees(snapshot: WorktreeSnapshot, projectId: string): Worktree[] | undefined {
  if (!snapshot.projectsWithMain.has(projectId)) return undefined;
  return snapshot.byProject.get(projectId)?.map((worktree) => ({ ...worktree })) ?? [];
}

/**
 * Run `fn` with the worktrees registry loaded and the per-file mutex held.
 *
 * Issue #332: every read-modify-write against `worktrees.json` must go
 * through this helper. Concurrent reads that observe a stale or partial
 * file used to silently nuke the registry; holding the lock around the
 * read-modify-write window prevents the interleaving that caused that
 * loss.
 *
 * `fn` is given the current registry contents (or `[]` on first run)
 * and may mutate the array in place. Whatever it leaves in the array
 * is what gets persisted — there is no separate "compute new value"
 * step that could race against another caller.
 */
async function withWorktreeRegistry<T>(
  fn: (registry: Worktree[]) => Promise<T>
): Promise<T> {
  const file = worktreesRegistryFile();
  return withLock(file, async () => {
    const { value: registry } = await readJsonRegistry<Worktree[]>(file, {
      defaultValue: [],
      backup: `${file}.bak`,
      validate: validateArray<Worktree>,
    });
    const before = JSON.stringify(registry);
    const result = await fn(registry);
    if (JSON.stringify(registry) !== before) await writeJsonRegistry(file, registry);
    return result;
  });
}

function buildMainWorktree(project: Project): Worktree {
  return {
    id: uuidv4(),
    projectId: project.id,
    name: MAIN_WORKTREE_NAME,
    path: project.path,
    isMain: true,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Ensure a project has a main worktree row. Returns the main worktree
 * after lazy-creating the row if it was missing. Mutates `registry` in
 * place — callers must run inside a registry lock so concurrent callers
 * don't both observe "no main", both create one, and both write back,
 * leaving two orphan rows for the same project.
 */
function ensureMainInRegistry(
  project: Project,
  registry: Worktree[]
): Worktree {
  const existing = registry.find(
    (w) => w.projectId === project.id && w.isMain
  );
  if (existing) return existing;
  const main = buildMainWorktree(project);
  registry.push(main);
  return main;
}

export async function ensureMainWorktree(project: Project): Promise<Worktree> {
  return withWorktreeRegistry(async (registry) =>
    ensureMainInRegistry(project, registry)
  );
}

export async function getProjectWorktrees(
  projectId: string
): Promise<Worktree[]> {
  const project = await getProject(projectId);
  if (!project) return [];
  const file = worktreesRegistryFile();
  try {
    const key = `${file}\0${await registryVersion(file)}`;
    const hit = cachedRegistry(key);
    if (hit) {
      const found = projectWorktrees(hit, projectId);
      if (found) return withPresence(found);
    }
    const worktrees = await withLock(file, async () => {
      // Another caller may have populated the cache while we waited.
      const lockedKey = `${file}\0${await registryVersion(file)}`;
      const lockedHit = cachedRegistry(lockedKey);
      if (lockedHit) {
        const found = projectWorktrees(lockedHit, projectId);
        if (found) return found;
      }
      const { value: registry, fromBackup } = await readJsonRegistry<Worktree[]>(file, {
        defaultValue: [],
        backup: `${file}.bak`,
        validate: validateArray<Worktree>,
      });
      const hasMain = registry.some((w) => w.projectId === projectId && w.isMain);
      if (!hasMain) ensureMainInRegistry(project, registry);
      if (!hasMain || fromBackup) {
        await writeJsonRegistry(file, registry);
      }
      const currentKey = `${file}\0${await registryVersion(file)}`;
      const snapshot = cacheRegistry(file, currentKey, registry);
      return projectWorktrees(snapshot, projectId) ?? [];
    });
    return withPresence(worktrees);
  } catch (err) {
    if (err instanceof RegistryParseError) {
      // Surface the corruption to the operator but do not persist a
      // replacement. Returning `[]` here would let a single bad write
      // empty the entire registry on the next caller.
      console.error(`worktrees.json is unreadable: ${err.message}`);
      return [];
    }
    throw err;
  }
}

/** Report missing paths without mutating or reparsing the registry on every read. */
async function withPresence(worktrees: Worktree[]): Promise<Worktree[]> {
  return Promise.all(worktrees.map(async (worktree) => {
    if (worktree.presence === "removed" || worktree.presence === "missing") return worktree;
    try {
      await fs.access(worktree.path);
      return { ...worktree, presence: "active" as const };
    } catch {
      return { ...worktree, presence: "missing" as const };
    }
  }));
}

interface GitWorktree {
  path: string;
  branch?: string;
  prunable: boolean;
  identity?: string;
}

/** Parse Git's blank-line-delimited porcelain records without splitting paths on spaces. */
export function parseGitWorktrees(output: string): GitWorktree[] {
  return output.trim().split(/\n\n+/).filter(Boolean).map((block) => {
    const lines = block.split("\n");
    const first = lines[0];
    if (!first.startsWith("worktree ")) throw new Error("Invalid git worktree list output");
    const branch = lines.find((line) => line.startsWith("branch "))?.slice(7);
    return {
      path: first.slice(9),
      branch: branch?.replace(/^refs\/heads\//, ""),
      prunable: lines.some((line) => line.startsWith("prunable")),
    };
  });
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(value);
    throw error;
  }
}

/** Register linked Git worktrees without touching their checkouts or running setup. */
export async function reconcileGitWorktrees(project: Project): Promise<Worktree[]> {
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
    cwd: project.path,
    maxBuffer: 4 * 1024 * 1024,
  });
  const listed = parseGitWorktrees(stdout);
  const mainPath = await canonicalPath(project.path);
  const { stdout: projectCommonDir } = await execFileAsync(
    "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: project.path }
  );
  const commonDir = await fs.realpath(projectCommonDir.trim());
  const active = new Map<string, GitWorktree>();
  for (const item of listed) {
    const resolved = await canonicalPath(item.path);
    if (resolved === mainPath || item.prunable) continue;
    if (active.has(resolved)) throw new Error(`Git reported duplicate worktree path: ${resolved}`);
    try {
      if (!(await fs.stat(resolved)).isDirectory()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    active.set(resolved, item);
  }

  await Promise.all([...active.entries()].map(async ([resolved, item]) => {
    try {
      const { stdout: linkedCommonDir } = await execFileAsync(
        "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: resolved }
      );
      if (await fs.realpath(linkedCommonDir.trim()) !== commonDir) {
        active.delete(resolved);
        return;
      }
      const { stdout: gitDir } = await execFileAsync("git", ["rev-parse", "--absolute-git-dir"], { cwd: resolved });
      const canonicalDir = await fs.realpath(gitDir.trim());
      const stat = await fs.stat(canonicalDir);
      item.identity = `${canonicalDir}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    } catch {
      // A checkout can disappear between list and inspection. It is not
      // eligible for registration until the next refresh.
      active.delete(resolved);
    }
  }));

  return withWorktreeRegistry(async (registry) => {
    ensureMainInRegistry(project, registry);
    const added: Worktree[] = [];
    const knownPaths = new Set(await Promise.all(registry.map((worktree) => canonicalPath(worktree.path))));
    let offset = Math.max(0, ...registry
      .filter((worktree) => worktree.projectId === project.id)
      .map((worktree) => worktree.portOffset ?? 0));
    for (const worktree of registry) {
      if (worktree.projectId !== project.id || worktree.isMain || worktree.presence === "removed") continue;
      const key = await canonicalPath(worktree.path);
      const git = active.get(key);
      if (!git) {
        worktree.presence = "missing";
      } else if (worktree.presence !== "missing" ||
        (worktree.gitIdentity && worktree.gitIdentity === git.identity)) {
        worktree.branch = git.branch;
        worktree.gitIdentity = git.identity;
        worktree.presence = "active";
        active.delete(key);
      } else {
        // Session storage is keyed by path. A vanished path may have been
        // recreated as a different checkout, so retain its history safely.
        active.delete(key);
      }
    }
    for (const [resolved, git] of active) {
      // Never attach a new checkout to an old path's sessions. This also
      // prevents duplicate records across projects sharing a repository.
      if (knownPaths.has(resolved)) continue;
      offset += PORT_OFFSET_STRIDE;
      const worktree: Worktree = {
        id: uuidv4(),
        projectId: project.id,
        name: path.basename(resolved),
        path: git.path,
        branch: git.branch,
        gitIdentity: git.identity,
        isMain: false,
        portOffset: offset,
        createdAt: new Date().toISOString(),
        origin: "external",
        presence: "active",
      };
      registry.push(worktree);
      knownPaths.add(resolved);
      added.push(worktree);
    }
    return added;
  });
}

export async function getWorktree(
  projectId: string,
  worktreeId: string
): Promise<Worktree | null> {
  const worktrees = await getProjectWorktrees(projectId);
  if (worktreeId === MAIN_WORKTREE_NAME) {
    return worktrees.find((w) => w.isMain) ?? null;
  }
  return worktrees.find((w) => w.id === worktreeId) ?? null;
}

/**
 * Find the worktree that contains the given filesystem path, matching the
 * longest path prefix across every project. Used by the preview browser route
 * to map an agent's shell cwd to the pane it should drive.
 */
export async function findWorktreeByPath(
  targetPath: string
): Promise<Worktree | null> {
  const resolved = path.resolve(targetPath);
  const projects = await getProjects();
  let best: Worktree | null = null;
  let bestLen = -1;
  for (const project of projects) {
    for (const worktree of await getProjectWorktrees(project.id)) {
      if (isWorktreeUnavailable(worktree)) continue;
      const worktreePath = path.resolve(worktree.path);
      const inside =
        resolved === worktreePath ||
        resolved.startsWith(worktreePath + path.sep);
      if (inside && worktreePath.length > bestLen) {
        best = worktree;
        bestLen = worktreePath.length;
      }
    }
  }
  return best;
}

/**
 * Resolve a worktree from a query string. Defaults to the project's main
 * worktree when no id is provided. Accepts the literal alias "main".
 */
export async function resolveWorktree(
  projectId: string,
  worktreeIdParam?: string | string[]
): Promise<Worktree | null> {
  const project = await getProject(projectId);
  if (!project) return null;
  const id = Array.isArray(worktreeIdParam)
    ? worktreeIdParam[0]
    : worktreeIdParam;
  if (!id || id === MAIN_WORKTREE_NAME) {
    return ensureMainWorktree(project);
  }
  return getWorktree(projectId, id);
}

/**
 * Maximum number of known worktree ids echoed back in a 404 body. A
 * project with dozens of worktrees would otherwise turn a one-line CLI
 * error into a wall of UUIDs; the `worktrees list` pointer in the hint
 * covers the overflow.
 */
export const WORKTREE_NOT_FOUND_ID_LIMIT = 10;

/**
 * Body of a `404 Worktree not found` response (issue #367).
 *
 * The bare `{ error: "Worktree not found" }` shape gave a caller no way
 * to tell "I passed a project id by mistake" apart from "that worktree
 * was deleted". Every field beyond `error` is diagnostic: `error` keeps
 * its historical text so existing clients keep matching on it, and the
 * actionable one-liner rides along in `hint`.
 */
export interface WorktreeNotFoundPayload {
  error: string;
  /** The project the lookup was scoped to. Always present. */
  projectId: string;
  /** The worktree id the caller supplied, when it supplied one. */
  suppliedId?: string;
  /** True when `suppliedId` is a known *project* id — the "did you mean" case. */
  suppliedIdIsProjectId?: boolean;
  /** Worktree ids that do exist for `projectId`, capped at {@link WORKTREE_NOT_FOUND_ID_LIMIT}. */
  knownWorktreeIds?: string[];
  /** One-line, actionable next step. Absent when the caller passed no worktree id. */
  hint?: string;
}

/**
 * Build the enriched 404 body for a failed worktree lookup.
 *
 * When no worktree id was supplied the lookup failed for some other
 * reason (an unknown project, a corrupt registry), so the payload stays
 * at the historical single-key shape rather than inventing a hint the
 * caller can't act on.
 */
export async function worktreeNotFoundPayload(
  projectId: string,
  worktreeIdParam?: string | string[]
): Promise<WorktreeNotFoundPayload> {
  const payload: WorktreeNotFoundPayload = {
    error: "Worktree not found",
    projectId,
  };
  const suppliedId = Array.isArray(worktreeIdParam)
    ? worktreeIdParam[0]
    : worktreeIdParam;
  if (!suppliedId) return payload;
  payload.suppliedId = suppliedId;

  const worktrees = await getProjectWorktrees(projectId);
  payload.knownWorktreeIds = worktrees
    .slice(0, WORKTREE_NOT_FOUND_ID_LIMIT)
    .map((worktree) => worktree.id);

  const projects = await getProjects();
  payload.suppliedIdIsProjectId = projects.some((p) => p.id === suppliedId);
  payload.hint = payload.suppliedIdIsProjectId
    ? `${suppliedId} is a project id, not a worktree id. Use 'controller worktrees list ${suppliedId}' to discover worktree ids.`
    : `No worktree ${suppliedId} in project ${projectId}. Use 'controller worktrees list ${projectId}' to discover worktree ids.`;
  return payload;
}

/**
 * Flatten a {@link WorktreeNotFoundPayload} into the single line that
 * non-JSON transports (the terminal WebSocket) and the CLI's `fail()`
 * both print. Kept here so the two never drift.
 */
export function worktreeNotFoundMessage(
  payload: WorktreeNotFoundPayload
): string {
  return payload.hint ? `${payload.error}. ${payload.hint}` : payload.error;
}

export async function addWorktree(
  worktree: Omit<Worktree, "id" | "createdAt"> & { id?: string }
): Promise<Worktree> {
  const record: Worktree = {
    id: worktree.id ?? uuidv4(),
    createdAt: new Date().toISOString(),
    origin: "controller",
    presence: "active",
    ...worktree,
  };
  return withWorktreeRegistry(async (registry) => {
    if (!record.isMain && record.portOffset === undefined) {
      const used = registry
        .filter((entry) => entry.projectId === record.projectId)
        .map((entry) => entry.portOffset ?? 0);
      record.portOffset = Math.max(0, ...used) + PORT_OFFSET_STRIDE;
    }
    registry.push(record);
    return record;
  });
}

export async function updateWorktree(
  worktreeId: string,
  patch: Partial<Worktree>
): Promise<Worktree | null> {
  return withWorktreeRegistry(async (registry) => {
    const idx = registry.findIndex((w) => w.id === worktreeId);
    if (idx === -1) return null;
    const updated: Worktree = { ...registry[idx], ...patch, id: registry[idx].id };
    registry[idx] = updated;
    return updated;
  });
}

export async function removeWorktree(worktreeId: string): Promise<boolean> {
  return withWorktreeRegistry(async (registry) => {
    const worktree = registry.find((entry) => entry.id === worktreeId);
    if (!worktree || worktree.presence === "removed") return false;
    worktree.presence = "removed";
    return true;
  });
}

/**
 * Gap between consecutive worktree port offsets. Projects often run several
 * services on consecutive ports (e.g. 5000 and 5001), so a stride of 1 would
 * let one worktree's higher port collide with the next worktree's base port.
 * A stride of 3 leaves room between worktrees; projects that need more are
 * responsible for picking free ports at runtime.
 */
export const PORT_OFFSET_STRIDE = 3;

export function isMainWorktreeName(name: string): boolean {
  return name === MAIN_WORKTREE_NAME;
}

export const WORKTREE_NAME_REGEX = /^[a-z0-9][a-z0-9._-]*$/;
export const WORKTREE_NAME_MAX_LENGTH = 64;
