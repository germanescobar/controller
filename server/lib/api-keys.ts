import fs from "node:fs/promises";
import { apiKeysFile, ensureOrchestratorHome } from "./paths.js";

export interface ProviderConfig {
  id: string;
  name: string;
  envVar: string;
}

export const PROVIDERS: ProviderConfig[] = [
  { id: "groq", name: "Groq", envVar: "GROQ_API_KEY" },
  { id: "ollama-cloud", name: "Ollama Cloud", envVar: "OLLAMA_API_KEY" },
  { id: "openrouter", name: "OpenRouter", envVar: "OPENROUTER_API_KEY" },
];

// Provider ids no longer supported. A stored key for any of these is pruned
// the next time the store is read so it stops being surfaced or injected.
const REMOVED_PROVIDER_IDS = ["openai"];

// Map of provider id -> API key
type ApiKeyStore = Record<string, string>;

async function readStore(): Promise<ApiKeyStore> {
  try {
    const content = await fs.readFile(apiKeysFile(), "utf-8");
    const store = JSON.parse(content) as ApiKeyStore;
    return pruneRemovedProviders(store);
  } catch {
    return {};
  }
}

/** Drop keys for removed providers, persisting the change when one is found. */
async function pruneRemovedProviders(store: ApiKeyStore): Promise<ApiKeyStore> {
  const hadRemoved = REMOVED_PROVIDER_IDS.some((id) => id in store);
  if (!hadRemoved) return store;
  for (const id of REMOVED_PROVIDER_IDS) {
    delete store[id];
  }
  await writeStore(store);
  return store;
}

async function writeStore(store: ApiKeyStore) {
  await ensureOrchestratorHome();
  await fs.writeFile(apiKeysFile(), JSON.stringify(store, null, 2));
}

export async function getApiKey(providerId: string): Promise<string | null> {
  const store = await readStore();
  return store[providerId] ?? null;
}

export async function setApiKey(
  providerId: string,
  key: string
): Promise<void> {
  const store = await readStore();
  store[providerId] = key;
  await writeStore(store);
}

export async function deleteApiKey(providerId: string): Promise<void> {
  const store = await readStore();
  delete store[providerId];
  await writeStore(store);
}

/** Returns provider IDs that have a key configured */
export async function getConfiguredProviders(): Promise<string[]> {
  const store = await readStore();
  return Object.keys(store).filter((k) => store[k]);
}

/** Build env vars object for all configured API keys */
export async function getApiKeyEnvVars(): Promise<Record<string, string>> {
  const store = await readStore();
  const env: Record<string, string> = {};
  for (const provider of PROVIDERS) {
    const key = store[provider.id];
    if (key) {
      env[provider.envVar] = key;
    }
  }
  return env;
}
