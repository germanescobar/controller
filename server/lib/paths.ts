import os from "node:os";
import path from "node:path";

export function orchestratorHome(): string {
  return (
    process.env.CODING_ORCHESTRATOR_HOME ??
    path.join(os.homedir(), "coding-orchestrator")
  );
}

/** Ensure the orchestrator home directory exists. */
export async function ensureOrchestratorHome(): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(orchestratorHome(), { recursive: true });
}

// --- Projects ---

export function projectsFile(): string {
  return path.join(orchestratorHome(), "projects.json");
}

// --- API Keys ---

export function apiKeysFile(): string {
  return path.join(orchestratorHome(), "api-keys.json");
}

// --- Worktrees ---

export function worktreesRoot(): string {
  return path.join(orchestratorHome(), "worktrees");
}

export function projectWorktreesDir(projectId: string): string {
  return path.join(worktreesRoot(), projectId);
}

export function worktreePath(projectId: string, name: string): string {
  return path.join(projectWorktreesDir(projectId), name);
}

export function worktreesRegistryFile(): string {
  return path.join(orchestratorHome(), "worktrees.json");
}

// --- Terminal Tabs ---

export function terminalTabsRegistryFile(): string {
  return path.join(orchestratorHome(), "terminal-tabs.json");
}
