import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

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
 * (globally unique) session id, rather than on the
 * orchestrator-owned `.coding-agent/sessions/<id>.json` file. The
 * separation survives any future provider that re-introduces an
 * on-disk writer (it would silently drop unknown top-level
 * fields) and legacy resumed sessions the agent still
 * co-writes via the `.coding-agent/sessions/` fallback. See
 * #139 / #165.
 */
export function sessionFocusDir(): string {
  return path.join(orchestratorHome(), "focus");
}

/** Per-session focus sidecar, keyed by the session id. */
export function sessionFocusFile(sessionId: string): string {
  return path.join(sessionFocusDir(), `${sessionId}.json`);
}

// --- Session & Event Storage ---

/**
 * Per-project storage root for Controller-owned session, event, and
 * attachment files. Lives under the Controller home — NOT in the
 * project working tree.
 *
 * Controller previously stored these in `<project>/.coding-agent/`, but
 * that is exactly the directory the `anita` CLI falls back to for its
 * own session storage when no `.anita/sessions/` exists (see the CLI's
 * `resolveStorageBase`). With both processes writing
 * `.coding-agent/events/<sessionId>.jsonl`, every transcript event was
 * recorded twice — once in the CLI's native shape, once in
 * Controller's normalized shape. Owning a directory outside the project
 * tree removes the shared namespace entirely.
 *
 * Keyed by a hash of the absolute project path so each project/worktree
 * gets an isolated, stable directory and `getSessions` keeps returning
 * only that location's sessions.
 */
export function projectStoreDir(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  const key = createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  return path.join(orchestratorHome(), "projects", `${path.basename(resolved)}-${key}`);
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

// --- Unified Skills ---

/** Directory holding the app-owned unified skill catalog. */
export function unifiedSkillsDir(): string {
  return path.join(orchestratorHome(), "skills");
}

/** Per-skill directory under the unified catalog. */
export function unifiedSkillDir(skillName: string): string {
  return path.join(unifiedSkillsDir(), skillName);
}

/** Path to a unified skill's SKILL.md file. */
export function unifiedSkillFile(skillName: string): string {
  return path.join(unifiedSkillDir(skillName), "SKILL.md");
}
