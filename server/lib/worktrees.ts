import fs from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { getProject, getProjects, type Project } from "./projects.js";
import { orchestratorHome, worktreesRegistryFile } from "./paths.js";

export interface Worktree {
  id: string;
  projectId: string;
  name: string;
  path: string;
  branch?: string;
  isMain: boolean;
  portOffset?: number;
  createdAt: string;
  setupRanAt?: string;
  setupExitCode?: number;
  setupLogPath?: string;
}

const MAIN_WORKTREE_NAME = "main";

async function ensureHome() {
  await fs.mkdir(orchestratorHome(), { recursive: true });
}

async function readRegistry(): Promise<Worktree[]> {
  try {
    const content = await fs.readFile(worktreesRegistryFile(), "utf-8");
    return JSON.parse(content) as Worktree[];
  } catch {
    return [];
  }
}

async function writeRegistry(worktrees: Worktree[]): Promise<void> {
  await ensureHome();
  await fs.writeFile(
    worktreesRegistryFile(),
    JSON.stringify(worktrees, null, 2)
  );
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
 * Ensure a project has a main worktree row. Returns the registry after
 * lazy-creating the row if it was missing.
 */
async function ensureMainInRegistry(
  project: Project,
  registry: Worktree[]
): Promise<{ registry: Worktree[]; main: Worktree; created: boolean }> {
  const existing = registry.find(
    (w) => w.projectId === project.id && w.isMain
  );
  if (existing) return { registry, main: existing, created: false };

  const main = buildMainWorktree(project);
  const next = [...registry, main];
  await writeRegistry(next);
  return { registry: next, main, created: true };
}

export async function ensureMainWorktree(project: Project): Promise<Worktree> {
  const registry = await readRegistry();
  const { main } = await ensureMainInRegistry(project, registry);
  return main;
}

export async function getProjectWorktrees(
  projectId: string
): Promise<Worktree[]> {
  const project = await getProject(projectId);
  if (!project) return [];
  const registry = await readRegistry();
  const { registry: next } = await ensureMainInRegistry(project, registry);
  return next.filter((w) => w.projectId === projectId);
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

export async function addWorktree(
  worktree: Omit<Worktree, "id" | "createdAt"> & { id?: string }
): Promise<Worktree> {
  const registry = await readRegistry();
  const record: Worktree = {
    id: worktree.id ?? uuidv4(),
    createdAt: new Date().toISOString(),
    ...worktree,
  };
  registry.push(record);
  await writeRegistry(registry);
  return record;
}

export async function updateWorktree(
  worktreeId: string,
  patch: Partial<Worktree>
): Promise<Worktree | null> {
  const registry = await readRegistry();
  const idx = registry.findIndex((w) => w.id === worktreeId);
  if (idx === -1) return null;
  const updated: Worktree = { ...registry[idx], ...patch, id: registry[idx].id };
  registry[idx] = updated;
  await writeRegistry(registry);
  return updated;
}

export async function removeWorktree(worktreeId: string): Promise<boolean> {
  const registry = await readRegistry();
  const next = registry.filter((w) => w.id !== worktreeId);
  if (next.length === registry.length) return false;
  await writeRegistry(next);
  return true;
}

/**
 * Gap between consecutive worktree port offsets. Projects often run several
 * services on consecutive ports (e.g. 5000 and 5001), so a stride of 1 would
 * let one worktree's higher port collide with the next worktree's base port.
 * A stride of 3 leaves room between worktrees; projects that need more are
 * responsible for picking free ports at runtime.
 */
export const PORT_OFFSET_STRIDE = 3;

/** Monotonic per-project port offset: max existing + stride, starting at stride. */
export async function nextPortOffset(projectId: string): Promise<number> {
  const registry = await readRegistry();
  const used = registry
    .filter((w) => w.projectId === projectId && typeof w.portOffset === "number")
    .map((w) => w.portOffset as number);
  if (used.length === 0) return PORT_OFFSET_STRIDE;
  return Math.max(...used) + PORT_OFFSET_STRIDE;
}

export function isMainWorktreeName(name: string): boolean {
  return name === MAIN_WORKTREE_NAME;
}

export const WORKTREE_NAME_REGEX = /^[a-z0-9][a-z0-9._-]*$/;
export const WORKTREE_NAME_MAX_LENGTH = 64;
