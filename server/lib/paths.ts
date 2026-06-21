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

// --- Agents ---

export function agentSettingsFile(): string {
  return path.join(orchestratorHome(), "agents.json");
}

// --- Integrations ---

/** Non-secret connection registry (names, modes, config). */
export function integrationsFile(): string {
  return path.join(orchestratorHome(), "integrations.json");
}

/** Encrypted-at-rest store for connection secrets (tokens, passwords, keys). */
export function integrationSecretsFile(): string {
  return path.join(orchestratorHome(), "integration-secrets.json");
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

// --- Session Focus ---

/**
 * Directory holding per-session focus sidecars. Controller-owned
 * focus-queue state lives here, keyed by the provider-generated
 * (globally unique) session id, rather than on the agent-owned
 * `.coding-agent/sessions/<id>.json` file the agent rewrites on
 * every save (issue #139).
 */
export function sessionFocusDir(): string {
  return path.join(orchestratorHome(), "focus");
}

/** Per-session focus sidecar, keyed by the session id. */
export function sessionFocusFile(sessionId: string): string {
  return path.join(sessionFocusDir(), `${sessionId}.json`);
}

// --- Terminal Tabs ---

export function terminalTabsRegistryFile(): string {
  return path.join(orchestratorHome(), "terminal-tabs.json");
}

// --- Session Message Queues ---

/** Directory holding per-session enqueued-message files. */
export function sessionQueuesDir(): string {
  return path.join(orchestratorHome(), "queues");
}

/** Per-session queue file, keyed by the provider-generated session id. */
export function sessionQueueFile(sessionId: string): string {
  return path.join(sessionQueuesDir(), `${sessionId}.json`);
}
