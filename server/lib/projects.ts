import fs from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { projectsFile, ensureOrchestratorHome } from "./paths.js";

export interface Project {
  id: string;
  name: string;
  path: string;
  setupCommands?: string;
  createdAt: string;
}

async function writeSetupScript(projectPath: string, commands: string): Promise<void> {
  const dir = path.join(projectPath, ".coding-orchestrator");
  await fs.mkdir(dir, { recursive: true });
  const scriptPath = path.join(dir, "setup.sh");
  const content = `#!/bin/bash\nset -e\n\n${commands.trimEnd()}\n`;
  await fs.writeFile(scriptPath, content, { mode: 0o755 });
}

export async function getProjects(): Promise<Project[]> {
  try {
    const content = await fs.readFile(projectsFile(), "utf-8");
    return JSON.parse(content) as Project[];
  } catch {
    return [];
  }
}

export async function addProject(
  name: string,
  projectPath: string,
  setupCommands?: string
): Promise<Project> {
  await ensureOrchestratorHome();
  const projects = await getProjects();
  const project: Project = {
    id: uuidv4(),
    name,
    path: projectPath,
    setupCommands,
    createdAt: new Date().toISOString(),
  };
  projects.push(project);
  await fs.writeFile(projectsFile(), JSON.stringify(projects, null, 2));
  if (setupCommands?.trim()) {
    await writeSetupScript(projectPath, setupCommands);
  }
  return project;
}

export async function getProject(id: string): Promise<Project | null> {
  const projects = await getProjects();
  return projects.find((p) => p.id === id) ?? null;
}

export async function updateProject(
  id: string,
  patch: { name?: string; setupCommands?: string }
): Promise<Project | null> {
  const projects = await getProjects();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const updated: Project = { ...projects[idx], ...patch };
  projects[idx] = updated;
  await ensureOrchestratorHome();
  await fs.writeFile(projectsFile(), JSON.stringify(projects, null, 2));
  if (patch.setupCommands !== undefined) {
    if (patch.setupCommands.trim()) {
      await writeSetupScript(updated.path, patch.setupCommands);
    } else {
      // Remove setup.sh if commands cleared
      const scriptPath = path.join(updated.path, ".coding-orchestrator", "setup.sh");
      await fs.rm(scriptPath, { force: true });
    }
  }
  return updated;
}

export async function deleteProject(id: string): Promise<boolean> {
  const projects = await getProjects();
  const filtered = projects.filter((p) => p.id !== id);
  if (filtered.length === projects.length) return false;
  await ensureOrchestratorHome();
  await fs.writeFile(projectsFile(), JSON.stringify(filtered, null, 2));
  return true;
}
