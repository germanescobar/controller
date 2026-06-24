import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

/*
 * Centralizes every Controller-owned path on disk.
 *
 * The orchestrator's home directory moved out of the user's `$HOME`
 * top level (issue #223). New resolution order:
 *
 *   1. `process.env.CONTROLLER_HOME`         — canonical override
 *   2. `process.env.CODING_ORCHESTRATOR_HOME`— deprecated alias; emits a
 *                                                one-line warning when read
 *   3. Platform default:
 *        macOS  → ~/Library/Application Support/Controller
 *        Linux  → ${XDG_STATE_HOME:-~/.local/state}/Controller
 *        other  → ~/coding-orchestrator        (legacy fallback)
 *
 * macOS's `Application Support` and Linux's `XDG_STATE_HOME` are the
 * platform-sanctioned homes for app state; neither triggers TCC prompts.
 * The legacy `~/coding-orchestrator` location is preserved on platforms
 * where we haven't adopted a native convention yet (Windows today), and
 * also as the migration *source* for existing installs — see
 * `migrateLegacyHomeIfNeeded`.
 */

const LEGACY_HOME_BASENAME = "coding-orchestrator";
const MIGRATION_MARKER = "migrated-from-legacy-home.json";

let didWarnDeprecatedEnvVar = false;

/**
 * Returns the Controller home directory.
 *
 * Resolution order:
 *   1. `CONTROLLER_HOME` env var (canonical, documented override).
 *   2. `CODING_ORCHESTRATOR_HOME` env var (deprecated alias; warned once).
 *   3. Platform default — see the module-level comment.
 */
export function orchestratorHome(): string {
  const canonical = process.env.CONTROLLER_HOME?.trim();
  if (canonical) return canonical;

  const deprecated = process.env.CODING_ORCHESTRATOR_HOME?.trim();
  if (deprecated) {
    if (!didWarnDeprecatedEnvVar) {
      didWarnDeprecatedEnvVar = true;
      console.warn(
        "CODING_ORCHESTRATOR_HOME is deprecated; use CONTROLLER_HOME instead. " +
          `Continuing with ${deprecated}.`,
      );
    }
    return deprecated;
  }

  return defaultHomeForPlatform();
}

/**
 * Platform-appropriate default home. macOS gets `Application Support`,
 * Linux follows `XDG_STATE_HOME`, everything else falls back to the
 * legacy top-level dot-less directory so the change is contained.
 */
export function defaultHomeForPlatform(): string {
  const platform = process.platform;
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Controller");
  }
  if (platform === "linux") {
    const xdgState = process.env.XDG_STATE_HOME?.trim();
    const base = xdgState && xdgState !== "" ? xdgState : path.join(os.homedir(), ".local", "state");
    return path.join(base, "Controller");
  }
  return path.join(os.homedir(), LEGACY_HOME_BASENAME);
}

/**
 * Legacy top-level home used before issue #223. Used as the migration
 * source for existing installs and as the runtime-file fallback for
 * already-installed CLI copies during the migration window.
 */
export function legacyOrchestratorHome(): string {
  return path.join(os.homedir(), LEGACY_HOME_BASENAME);
}

/** Ensure the orchestrator home directory exists. */
export async function ensureOrchestratorHome(): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(orchestratorHome(), { recursive: true });
}

// ---------------------------------------------------------------------------
// One-shot migration (issue #223).
//
// On startup the server moves state from the legacy `~/coding-orchestrator`
// path into the new platform-appropriate home. Idempotent: a marker file
// under the new home records that the move ran, so subsequent boots no-op.
// Atomic when source and destination live on the same volume (the common
// case); falls back to recursive copy + remove across volumes.
// ---------------------------------------------------------------------------

export interface MigrationResult {
  /** Whether a migration actually ran this invocation. */
  migrated: boolean;
  /** The legacy path that was the migration source (when migrated). */
  from?: string;
  /** The new home the state was moved to (when migrated). */
  to?: string;
  /** Reason migration was skipped, when `migrated === false`. */
  skippedReason?: "marker-exists" | "no-legacy" | "env-override-set" | "already-at-target";
}

export async function migrateLegacyHomeIfNeeded(): Promise<MigrationResult> {
  const fs = await import("node:fs/promises");

  // Respect explicit overrides — the operator (or a test) is pinning the
  // home; we don't second-guess them.
  if (
    process.env.CONTROLLER_HOME?.trim() ||
    process.env.CODING_ORCHESTRATOR_HOME?.trim()
  ) {
    return { migrated: false, skippedReason: "env-override-set" };
  }

  const target = orchestratorHome();
  const legacy = legacyOrchestratorHome();
  if (path.resolve(target) === path.resolve(legacy)) {
    return { migrated: false, skippedReason: "already-at-target" };
  }

  // Already migrated? Check the marker before touching disk.
  if (await hasMigrationMarker(fs, target)) {
    return { migrated: false, skippedReason: "marker-exists" };
  }

  let legacyStat;
  try {
    legacyStat = await fs.stat(legacy);
  } catch {
    return { migrated: false, skippedReason: "no-legacy" };
  }
  if (!legacyStat.isDirectory()) {
    return { migrated: false, skippedReason: "no-legacy" };
  }

  // Ensure the target's parent exists (e.g. `~/Library/Application Support/`
  // on macOS, `~/.local/state/` on Linux without `XDG_STATE_HOME`).
  await fs.mkdir(path.dirname(target), { recursive: true });

  // Try a same-volume rename first; fall back to recursive copy if the
  // legacy home lives on a different volume (e.g. an external drive).
  try {
    await fs.rename(legacy, target);
  } catch (renameErr: unknown) {
    const code = (renameErr as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") throw renameErr;
    await copyDirectoryRecursive(fs, legacy, target);
    await fs.rm(legacy, { recursive: true, force: true });
  }

  await fs.writeFile(
    path.join(target, MIGRATION_MARKER),
    JSON.stringify(
      {
        migratedFrom: legacy,
        migratedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );

  console.log(`migrated legacy orchestrator home from ${legacy} to ${target}`);
  return { migrated: true, from: legacy, to: target };
}

async function hasMigrationMarker(
  fs: typeof import("node:fs/promises"),
  dir: string,
): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, MIGRATION_MARKER));
    return true;
  } catch {
    return false;
  }
}

async function copyDirectoryRecursive(
  fs: typeof import("node:fs/promises"),
  src: string,
  dest: string,
): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(fs, from, to);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      await fs.copyFile(from, to);
    }
  }
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