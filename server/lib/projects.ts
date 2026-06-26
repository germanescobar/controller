import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { projectsFile, ensureOrchestratorHome } from "./paths.js";
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

export async function getProject(id: string): Promise<Project | null> {
  const record = (await readRecords()).find((p) => p.id === id);
  return record ? hydrate(record) : null;
}

export async function addProject(
  name: string,
  projectPath: string,
  setupCommands?: string,
  runCommands?: string
): Promise<Project> {
  await ensureOrchestratorHome();
  const records = await readRecords();
  const record: ProjectRecord = {
    id: uuidv4(),
    name,
    path: projectPath,
    createdAt: new Date().toISOString(),
  };
  records.push(record);
  await writeRecords(records);
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
  const records = await readRecords();
  const idx = records.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  if (patch.name !== undefined) records[idx].name = patch.name;
  await ensureOrchestratorHome();
  await writeRecords(records);
  if (patch.setupCommands !== undefined) {
    await syncScript(records[idx].path, "setup.sh", patch.setupCommands);
  }
  if (patch.runCommands !== undefined) {
    await syncScript(records[idx].path, "run.sh", patch.runCommands);
  }
  return hydrate(records[idx]);
}

export async function deleteProject(id: string): Promise<boolean> {
  const records = await readRecords();
  const filtered = records.filter((p) => p.id !== id);
  if (filtered.length === records.length) return false;
  await ensureOrchestratorHome();
  await writeRecords(filtered);
  return true;
}

/* Reads the persisted registry, tolerating a missing file. Older registries
 * may still carry `setupCommands`/`runCommands` keys; they are ignored since
 * the script files are authoritative and a later write drops them. */
async function readRecords(): Promise<ProjectRecord[]> {
  try {
    const content = await fs.readFile(projectsFile(), "utf-8");
    const parsed = JSON.parse(content) as ProjectRecord[];
    return parsed.map((p) => ({ id: p.id, name: p.name, path: p.path, createdAt: p.createdAt }));
  } catch {
    return [];
  }
}

async function writeRecords(records: ProjectRecord[]): Promise<void> {
  await fs.writeFile(projectsFile(), JSON.stringify(records, null, 2));
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
