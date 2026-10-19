import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { projectsFile } from "./paths.js";
import { readJsonRegistry, withLock, writeJsonRegistry } from "./json-registry.js";
import { resolveNativeScriptDir } from "./project-scripts.js";

export interface Project {
  id: string;
  name: string;
  path: string;
  /* Commands hydrated from the project's `<scriptDir>/setup.sh` on read. The
   * script file is the source of truth; this is not persisted in the
   * registry. */
  setupCommands?: string;
  /* Commands hydrated from the project's `<scriptDir>/run.sh` on read. */
  runCommands?: string;
  createdAt: string;
}

/* Shape persisted in `projects.json`. Script commands live in the project's
 * native `<scriptDir>/*.sh` files (which is what actually runs), so they are
 * deliberately not stored here — keeping them would let the registry drift
 * out of sync with the files on disk. */
interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

const SCRIPT_HEADER = "#!/bin/bash\nset -e\n\n";

export async function getProjects(): Promise<Project[]> {
  const records = await readRecords();
  return Promise.all(records.map(hydrate));
}

/** Read registered IDs without hydrating every project's script files. */
export async function getProjectIds(): Promise<string[]> {
  return (await readRecords()).map((record) => record.id);
}

export async function getProject(id: string): Promise<Project | null> {
  const record = (await readRecords()).find((p) => p.id === id);
  return record ? hydrate(record) : null;
}

/**
 * Find the project that owns the given filesystem path. The orchestrator
 * already thinks of a session as "pinned to a worktree, owned by a
 * project", and a session's shell is usually running in one of two
 * on-disk locations:
 *
 *   1. A Controller-created worktree under
 *      `orchestratorHome()/worktrees/<projectId>/<name>` — this is where
 *      `worktreePath()` (paths.ts) and `findWorktreeByPath` (worktrees.ts)
 *      know about.
 *   2. The project's `path` itself (i.e. the main worktree's root, or any
 *      other directory the user opened in the project).
 *
 * The function tries the worktree-aware lookup first and only falls back
 * to a `project.path` prefix match when no worktree owns the path. This
 * means a session running inside a Controller-created worktree — the
 * exact case the CLI's optional-`<project>` resolver was built for —
 * resolves to the right project. (Initial PR review from Codex on #298.)
 *
 * Returns `null` when no project owns the path. The `cwd` is resolved
 * before comparison so symlinks and `.`/`..` segments don't bypass the
 * prefix check.
 */
export async function findProjectByPath(targetPath: string): Promise<Project | null> {
  // Lazy import: `worktrees.ts` already imports from this module, so a
  // top-level static import would form a cycle. The helper is only
  // called from the cwd-based project lookup, so the dynamic import
  // overhead is one extra microtask on a code path that already does
  // disk I/O for the project list.
  const { findWorktreeByPath } = await import("./worktrees.js");
  const worktree = await findWorktreeByPath(targetPath);
  if (worktree) {
    return getProject(worktree.projectId);
  }
  const resolved = path.resolve(targetPath);
  const projects = await getProjects();
  let best: Project | null = null;
  let bestLen = -1;
  for (const project of projects) {
    if (!project.path) continue;
    const projectPath = path.resolve(project.path);
    const inside =
      resolved === projectPath ||
      resolved.startsWith(projectPath + path.sep);
    if (inside && projectPath.length > bestLen) {
      best = project;
      bestLen = projectPath.length;
    }
  }
  return best;
}

export async function addProject(
  name: string,
  projectPath: string,
  setupCommands?: string,
  runCommands?: string
): Promise<Project> {
  const record: ProjectRecord = {
    id: uuidv4(),
    name,
    path: projectPath,
    createdAt: new Date().toISOString(),
  };
  await withProjectRegistry(async (records) => {
    records.push(record);
  });
  // Only write supplied commands. A blank field on creation means "leave it
  // alone" — never the delete branch of syncScript, which would clobber a
  // script that already exists in an onboarded repo.
  if (setupCommands?.trim()) await syncScript(projectPath, "setup.sh", setupCommands);
  if (runCommands?.trim()) await syncScript(projectPath, "run.sh", runCommands);
  return hydrate(record);
}

export async function updateProject(
  id: string,
  patch: { name?: string; setupCommands?: string; runCommands?: string }
): Promise<Project | null> {
  const record = await withProjectRegistry(async (records) => {
    const found = records.find((p) => p.id === id);
    if (found && patch.name !== undefined) found.name = patch.name;
    return found ? { ...found } : null;
  });
  if (!record) return null;
  if (patch.setupCommands !== undefined) {
    await syncScript(record.path, "setup.sh", patch.setupCommands);
  }
  if (patch.runCommands !== undefined) {
    await syncScript(record.path, "run.sh", patch.runCommands);
  }
  return hydrate(record);
}

export async function deleteProject(id: string): Promise<boolean> {
  return withProjectRegistry(async (records) => {
    const idx = records.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    records.splice(idx, 1);
    return true;
  });
}

/* Runs a read-modify-write against `projects.json` while holding the
 * per-file registry lock (issue #454), so concurrent mutations can't drop
 * each other's records. `fn` mutates the loaded array in place and the
 * result is persisted atomically. */
async function withProjectRegistry<T>(
  fn: (records: ProjectRecord[]) => Promise<T>
): Promise<T> {
  const file = projectsFile();
  return withLock(file, async () => {
    const records = await readRecords();
    const result = await fn(records);
    await writeJsonRegistry(file, records);
    return result;
  });
}

/* Reads the persisted registry. Only a missing file yields `[]`; a corrupt
 * one falls back to `projects.json.bak` and otherwise throws
 * `RegistryParseError`, so a bad write can never be mistaken for "no
 * projects" and overwritten by the next mutation. */
async function readRecords(): Promise<ProjectRecord[]> {
  const file = projectsFile();
  const { value } = await readJsonRegistry<ProjectRecord[]>(file, {
    defaultValue: [],
    backup: `${file}.bak`,
    validate: validateRecords,
  });
  return value;
}

/* Older registries may still carry `setupCommands`/`runCommands` keys; they
 * are dropped since the script files are authoritative, and the next write
 * persists the stripped shape. Throws on a non-array so `readJsonRegistry`
 * reports it as corruption rather than an empty registry. */
function validateRecords(value: unknown): ProjectRecord[] {
  if (!Array.isArray(value)) throw new Error("projects registry is not an array");
  return (value as ProjectRecord[]).map((p) => ({
    id: p.id,
    name: p.name,
    path: p.path,
    createdAt: p.createdAt,
  }));
}

/* Builds the public `Project` by reading the commands back from the script
 * files on disk, so the create/edit form always reflects what will run. */
async function hydrate(record: ProjectRecord): Promise<Project> {
  return {
    ...record,
    setupCommands: await readScriptCommands(record.path, "setup.sh"),
    runCommands: await readScriptCommands(record.path, "run.sh"),
  };
}

/* Reads the project's native `<scriptDir>/<fileName>` and strips the generated
 * `#!/bin/bash` / `set -e` header so the form shows just the commands. Uses the
 * resolved script directory so an already-onboarded `.coding-orchestrator/`
 * repo still hydrates. Returns undefined when the script does not exist. */
async function readScriptCommands(
  projectPath: string,
  fileName: string
): Promise<string | undefined> {
  const scriptPath = path.join(resolveNativeScriptDir(projectPath), fileName);
  if (!existsSync(scriptPath)) return undefined;
  const content = await fs.readFile(scriptPath, "utf-8");
  const body = content.startsWith(SCRIPT_HEADER)
    ? content.slice(SCRIPT_HEADER.length)
    : content;
  return body.trimEnd();
}

/* Writes the project's native `<scriptDir>/<fileName>` script when commands are
 * provided, or removes it when the commands are empty. Writes to the resolved
 * script directory: `.controller/` for new projects, or the existing
 * `.coding-orchestrator/` directory for already-onboarded repos so editing
 * doesn't silently move their scripts. The empty-delete branch removes only the
 * file in that same directory. */
async function syncScript(
  projectPath: string,
  fileName: string,
  commands: string | undefined
): Promise<void> {
  const scriptPath = path.join(resolveNativeScriptDir(projectPath), fileName);
  if (commands?.trim()) {
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    const content = `${SCRIPT_HEADER}${commands.trimEnd()}\n`;
    await fs.writeFile(scriptPath, content, { mode: 0o755 });
  } else {
    await fs.rm(scriptPath, { force: true });
  }
}
