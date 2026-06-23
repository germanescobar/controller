import fs from "node:fs/promises";
import { agentSettingsFile, ensureOrchestratorHome } from "./paths.js";
import { clearCommandResolverCache } from "./command-resolver.js";
import { canonicalProviderId } from "./provider-id.js";

export interface AgentSetting {
  /** Whether the user has enabled this agent in Settings. */
  enabled: boolean;
  /** Explicit absolute path to the CLI, overriding PATH resolution. */
  path: string | null;
  /** Default model id the user wants pre-selected for new sessions. */
  defaultModel: string | null;
}

type AgentSettingsStore = Record<string, AgentSetting>;

const DEFAULT_SETTING: AgentSetting = { enabled: true, path: null, defaultModel: null };

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
    // Resolve legacy agent ids (e.g. "ada") to their canonical form so
    // settings saved before the Ada→Anita rename keep applying.
    store[canonicalProviderId(id)] = normalizeSetting(value);
  }
  return store;
}

function normalizeSetting(value: unknown): AgentSetting {
  if (!value || typeof value !== "object") return { ...DEFAULT_SETTING };
  const raw = value as Record<string, unknown>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    path: typeof raw.path === "string" && raw.path.trim() ? raw.path.trim() : null,
    defaultModel:
      typeof raw.defaultModel === "string" && raw.defaultModel.trim()
        ? raw.defaultModel.trim()
        : null,
  };
}

async function writeStore(store: AgentSettingsStore): Promise<void> {
  await ensureOrchestratorHome();
  await fs.writeFile(agentSettingsFile(), JSON.stringify(store, null, 2));
}

/** Settings for a single agent, falling back to the enabled-by-default value. */
export async function getAgentSetting(agentId: string): Promise<AgentSetting> {
  const store = await readStore();
  return store[canonicalProviderId(agentId)] ?? { ...DEFAULT_SETTING };
}

export async function getAgentSettings(): Promise<AgentSettingsStore> {
  return readStore();
}

export async function setAgentSetting(
  agentId: string,
  patch: Partial<AgentSetting>
): Promise<AgentSetting> {
  const id = canonicalProviderId(agentId);
  const store = await readStore();
  const current = store[id] ?? { ...DEFAULT_SETTING };
  const next: AgentSetting = {
    enabled: patch.enabled ?? current.enabled,
    path:
      patch.path === undefined
        ? current.path
        : patch.path && patch.path.trim()
          ? patch.path.trim()
          : null,
    defaultModel:
      patch.defaultModel === undefined
        ? current.defaultModel
        : patch.defaultModel && patch.defaultModel.trim()
          ? patch.defaultModel.trim()
          : null,
  };
  store[id] = next;
  await writeStore(store);
  // A changed path override invalidates any cached resolution/version.
  clearCommandResolverCache();
  return next;
}
