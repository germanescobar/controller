import fs from "node:fs/promises";
import path from "node:path";

export interface ProviderConfig {
  id: string;
  name: string;
  envVar: string;
}

export const PROVIDERS: ProviderConfig[] = [
  { id: "groq", name: "Groq", envVar: "GROQ_API_KEY" },
  { id: "ollama-cloud", name: "Ollama Cloud", envVar: "OLLAMA_API_KEY" },
  { id: "openai", name: "OpenAI", envVar: "OPENAI_API_KEY" },
];

// Map of provider id -> API key
type ApiKeyStore = Record<string, string>;

const DATA_DIR = path.join(process.cwd(), ".data");
const KEYS_FILE = path.join(DATA_DIR, "api-keys.json");

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readStore(): Promise<ApiKeyStore> {
  try {
    const content = await fs.readFile(KEYS_FILE, "utf-8");
    return JSON.parse(content) as ApiKeyStore;
  } catch {
    return {};
  }
}

async function writeStore(store: ApiKeyStore) {
  await ensureDataDir();
  await fs.writeFile(KEYS_FILE, JSON.stringify(store, null, 2));
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
