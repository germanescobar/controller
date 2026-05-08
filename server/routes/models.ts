import { Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getApiKey, PROVIDERS } from "../lib/api-keys.js";
import { codexAppServerManager } from "../lib/codex-app-server.js";

const execFileAsync = promisify(execFile);

export const modelsRouter = Router();

export interface Model {
  id: string;
  name: string;
  provider: string;
  size: string;
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

async function fetchOpenAIModels(apiKey: string): Promise<Model[]> {
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      data: Array<{ id: string; owned_by?: string }>;
    };
    return data.data
      .filter((m) => m.id.startsWith("gpt-") || m.id.startsWith("o"))
      .map((m) => ({
        id: `openai/${m.id}`,
        name: m.id,
        provider: "openai",
        size: "",
      }));
  } catch {
    return [];
  }
}

const PROVIDER_FETCHERS: Record<
  string,
  (apiKey: string) => Promise<Model[]>
> = {
  groq: fetchGroqModels,
  openai: fetchOpenAIModels,
};

/** Well-known models available through Codex CLI (user authenticates separately). */
function getCodexModels(): Model[] {
  return [
    { id: "gpt-5.5", name: "GPT-5.5", provider: "codex", size: "latest" },
    { id: "gpt-5.4", name: "GPT-5.4", provider: "codex", size: "flagship" },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "codex", size: "fast" },
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", provider: "codex", size: "coding" },
    { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", provider: "codex", size: "real-time" },
    { id: "gpt-5.2", name: "GPT-5.2", provider: "codex", size: "" },
  ];
}

async function fetchCodexModels(): Promise<Model[]> {
  try {
    const models = await codexAppServerManager.listModels({});
    return models.map((model) => ({
      id: model.model || model.id,
      name: model.displayName || model.model || model.id,
      provider: "codex",
      size: model.isDefault ? "default" : "",
    }));
  } catch {
    return getCodexModels();
  }
}

modelsRouter.get("/", async (req, res) => {
  const agent = (req.query.agent as string) || "ada";

  if (agent === "codex") {
    res.json(await fetchCodexModels());
    return;
  }

  // Default: Ada models (ollama + configured API providers)
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

  res.json(modelLists.flat());
});
