import fs from "node:fs/promises";
import { agentSettingsFile, ensureOrchestratorHome } from "./paths.js";
import { clearCommandResolverCache } from "./command-resolver.js";

export interface AgentSetting {
  /** Whether the user has enabled this agent in Settings. */
  enabled: boolean;
  /** Explicit absolute path to the CLI, overriding PATH resolution. */
  path: string | null;
}

type AgentSettingsStore = Record<string, AgentSetting>;

const DEFAULT_SETTING: AgentSetting = { enabled: true, path: null };

async function readStore(): Promise<AgentSettingsStore> {
  try {
    const content = await fs.readFile(agentSettingsFile(), "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return normalizeStore(parsed);
  } catch {
    return {};
  }
}

function normalizeStore(parsed: unknown): AgentSettingsStore {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const store: AgentSettingsStore = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    store[id] = normalizeSetting(value);
  }
  return store;
}

function normalizeSetting(value: unknown): AgentSetting {
  if (!value || typeof value !== "object") return { ...DEFAULT_SETTING };
  const raw = value as Record<string, unknown>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    path: typeof raw.path === "string" && raw.path.trim() ? raw.path.trim() : null,
  };
}

async function writeStore(store: AgentSettingsStore): Promise<void> {
  await ensureOrchestratorHome();
  await fs.writeFile(agentSettingsFile(), JSON.stringify(store, null, 2));
}

/** Settings for a single agent, falling back to the enabled-by-default value. */
export async function getAgentSetting(agentId: string): Promise<AgentSetting> {
  const store = await readStore();
  return store[agentId] ?? { ...DEFAULT_SETTING };
}

export async function getAgentSettings(): Promise<AgentSettingsStore> {
  return readStore();
}

export async function setAgentSetting(
  agentId: string,
  patch: Partial<AgentSetting>
): Promise<AgentSetting> {
  const store = await readStore();
  const current = store[agentId] ?? { ...DEFAULT_SETTING };
  const next: AgentSetting = {
    enabled: patch.enabled ?? current.enabled,
    path:
      patch.path === undefined
        ? current.path
        : patch.path && patch.path.trim()
          ? patch.path.trim()
          : null,
  };
  store[agentId] = next;
  await writeStore(store);
  // A changed path override invalidates any cached resolution/version.
  clearCommandResolverCache();
  return next;
}
