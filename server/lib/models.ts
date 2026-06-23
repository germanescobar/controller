import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getApiKey, getApiKeyEnvVars, PROVIDERS } from "./api-keys.js";
import { codexAppServerManager } from "./codex-app-server.js";
import { resolveAgentCommand } from "./agents.js";
import { childProcessEnv } from "./shell-env.js";

const execFileAsync = promisify(execFile);

export interface ModelCapabilities {
  images: boolean;
  files: boolean;
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  size: string;
  group?: string;
  contextWindowTokens?: number;
  capabilities?: ModelCapabilities;
}

interface AnitaModelCapabilities {
  attachments?: {
    images?: unknown;
    files?: unknown;
  };
}

interface AnitaModelEntry {
  label?: unknown;
  value?: unknown;
  group?: unknown;
  contextWindowTokens?: unknown;
  capabilities?: AnitaModelCapabilities;
}

interface AnitaModelsJson {
  models?: AnitaModelEntry[];
}

function normalizeModelSize(group: string | undefined): string {
  const normalized = (group ?? "").toLowerCase();
  if (normalized.includes("cloud")) return "cloud";
  if (normalized.includes("local")) return "local";
  return "";
}

function normalizeCapabilities(
  raw: AnitaModelCapabilities | undefined
): ModelCapabilities | undefined {
  const attachments = raw?.attachments;
  if (!attachments || typeof attachments !== "object") return undefined;
  const images = attachments.images === true;
  const files = attachments.files === true;
  if (!images && !files) return undefined;
  return { images, files };
}

function parseAnitaModelsJson(stdout: string): Model[] {
  let data: AnitaModelsJson;
  try {
    data = JSON.parse(stdout) as AnitaModelsJson;
  } catch {
    return [];
  }
  if (!Array.isArray(data.models)) return [];

  const models: Model[] = [];
  for (const entry of data.models) {
    const id = typeof entry.value === "string" ? entry.value.trim() : "";
    const name = typeof entry.label === "string" ? entry.label.trim() : "";
    if (!id) continue;
    const provider = id.split("/", 1)[0] || "";
    const group = typeof entry.group === "string" ? entry.group.trim() : "";
    const contextWindowTokens =
      typeof entry.contextWindowTokens === "number" && Number.isFinite(entry.contextWindowTokens)
        ? entry.contextWindowTokens
        : undefined;
    models.push({
      id,
      name: name || id,
      provider,
      size: normalizeModelSize(group),
      group: group || undefined,
      contextWindowTokens,
      capabilities: normalizeCapabilities(entry.capabilities),
    });
  }
  return models;
}

async function fetchAnitaCliModels(): Promise<Model[]> {
  try {
    const anitaCommand = await resolveAgentCommand("anita");
    const apiKeyEnv = await getApiKeyEnvVars();
    const { stdout } = await execFileAsync(anitaCommand, ["models", "--json"], {
      env: childProcessEnv(apiKeyEnv),
      timeout: 5000,
    });
    return parseAnitaModelsJson(stdout);
  } catch {
    return [];
  }
}

async function fetchOllamaModels(): Promise<Model[]> {
  try {
    const { stdout } = await execFileAsync("ollama", ["list"]);
    const lines = stdout.trim().split("\n").slice(1); // skip header
    return lines
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s{2,}/);
        const name = parts[0]?.trim() ?? "";
        const size = parts[2]?.trim() ?? "";
        return {
          id: `ollama/${name}`,
          name,
          provider: "ollama",
          size,
        };
      });
  } catch {
    return [];
  }
}

async function fetchGroqModels(apiKey: string): Promise<Model[]> {
  try {
    const response = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      data: Array<{ id: string; owned_by?: string; active?: boolean }>;
    };
    const NON_LLM_PATTERNS = [
      "whisper",
      "distil-whisper",
      "playai",
      "qwen2-audio",
      "orpheus",
      "prompt-guard",
      "safeguard",
      "compound",
    ];
    return data.data
      .filter((m) => !NON_LLM_PATTERNS.some((p) => m.id.includes(p)))
      .map((m) => ({
        id: `groq/${m.id}`,
        name: m.id,
        provider: "groq",
        size: "",
      }));
  } catch {
    return [];
  }
}

const PROVIDER_FETCHERS: Record<string, (apiKey: string) => Promise<Model[]>> = {
  groq: fetchGroqModels,
};

const STALE_CODEX_MODEL_IDS = new Set(["gpt-5.3-codex"]);

function getCodexModelPriority(model: Model): number {
  if (model.size === "default") return 0;
  if (model.id === "gpt-5.5") return 1;
  return 2;
}

function normalizeCodexModels(models: Model[]): Model[] {
  return models
    .filter((model) => !STALE_CODEX_MODEL_IDS.has(model.id))
    .sort((a, b) => getCodexModelPriority(a) - getCodexModelPriority(b));
}

/** Well-known models available through Codex CLI (user authenticates separately). */
function getCodexModels(): Model[] {
  return normalizeCodexModels([
    { id: "gpt-5.5", name: "GPT-5.5", provider: "codex", size: "default" },
    { id: "gpt-5.4", name: "GPT-5.4", provider: "codex", size: "flagship" },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "codex", size: "fast" },
    { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", provider: "codex", size: "real-time" },
  ]);
}

export async function fetchCodexModels(): Promise<Model[]> {
  try {
    const models = await codexAppServerManager.listModels({});
    return normalizeCodexModels(
      models.map((model) => ({
        id: model.model || model.id,
        name: model.displayName || model.model || model.id,
        provider: "codex",
        size: model.isDefault ? "default" : "",
      }))
    );
  } catch {
    return getCodexModels();
  }
}

/** Well-known Claude Code aliases (user authenticates separately through Claude CLI). */
export function getClaudeModels(): Model[] {
  return [
    { id: "claude-opus-4-8", name: "Opus 4.8", provider: "claude", size: "default" },
    { id: "claude-sonnet-4-6", name: "Sonnet 4.6", provider: "claude", size: "" },
  ];
}

async function fetchAnitaFallbackModels(): Promise<Model[]> {
  const modelLists = await Promise.all([
    fetchOllamaModels(),
    ...PROVIDERS.map(async (p) => {
      const key = await getApiKey(p.id);
      if (!key) return [];
      const fetcher = PROVIDER_FETCHERS[p.id];
      if (!fetcher) return [];
      return fetcher(key);
    }),
  ]);

  return modelLists.flat();
}

export async function fetchAnitaModels(): Promise<Model[]> {
  const anitaCliModels = await fetchAnitaCliModels();
  if (anitaCliModels.length > 0) return anitaCliModels;

  return fetchAnitaFallbackModels();
}
