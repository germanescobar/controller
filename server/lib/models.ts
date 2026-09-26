import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getApiKeyField,
  getApiKeyEnvVars,
  PROVIDERS,
} from "./api-keys.js";
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

/**
 * Cloudflare model fetcher.
 *
 * Two paths are possible:
 *
 * 1. Workers AI REST API at
 *    `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/models`
 *    when no AI gateway id is set. The response is OpenAI-compatible; we
 *    tag the resulting models with the "Cloudflare" group so the picker can
 *    keep them visually distinct from gateway-routed models.
 * 2. AI Gateway as a proxy in front of Workers AI (and other upstreams) at
 *    `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/...` —
 *    the gateway-advertised models list lives at
 *    `/v1/{account_id}/{gateway_id}/workers-ai/models`. Tag with the
 *    "Cloudflare Gateway" group so users can see they are routed through
 *    the gateway (which gives them unified logging, caching, rate limiting,
 *    and failover).
 *
 * Either path needs the API token; the gateway path additionally needs the
 * account id and the gateway id. Account id is also required for the direct
 * path. We never throw on missing fields — we just return an empty list and
 * the UI surfaces "no models yet" the same way the other providers do.
 */
async function fetchCloudflareModels(
  accountId: string | null,
  apiToken: string | null,
  aiGatewayId: string | null
): Promise<Model[]> {
  if (!apiToken) return [];
  if (aiGatewayId && accountId) {
    try {
      const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${aiGatewayId}/workers-ai/models`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      if (!response.ok) return [];
      const data = (await response.json()) as {
        result?: Array<{ id?: unknown; name?: unknown }>;
      };
      const rows = Array.isArray(data.result) ? data.result : [];
      return rows
        .filter(
          (m): m is { id: string; name?: string } =>
            !!m && typeof m === "object" && typeof m.id === "string" && m.id.length > 0
        )
        .map((m) => ({
          id: `cloudflare/${m.id}`,
          name: typeof m.name === "string" && m.name ? m.name : m.id,
          provider: "cloudflare",
          size: "",
          group: "Cloudflare Gateway",
        }));
    } catch {
      return [];
    }
  }
  if (!accountId) return [];
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/models`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      result?: Array<{ id?: unknown; name?: unknown }>;
    };
    const rows = Array.isArray(data.result) ? data.result : [];
    return rows
      .filter(
        (m): m is { id: string; name?: string } =>
          !!m && typeof m === "object" && typeof m.id === "string" && m.id.length > 0
      )
      .map((m) => ({
        id: `cloudflare/${m.id}`,
        name: typeof m.name === "string" && m.name ? m.name : m.id,
        provider: "cloudflare",
        size: "",
        group: "Cloudflare",
      }));
  } catch {
    return [];
  }
}

/**
 * Exported for tests. The dispatcher in `fetchAnitaFallbackModels` calls
 * this with the three Cloudflare fields; the export keeps the dispatcher
 * readable while letting tests target the routing logic in isolation.
 */
export const __test__fetchCloudflareModels = fetchCloudflareModels;

const STALE_CODEX_MODEL_IDS = new Set(["gpt-5.3-codex"]);

/**
 * Sort key for the Codex model picker. The single `default` model sorts to
 * the top; everything else preserves the caller's ordering via the stable
 * sort in `normalizeCodexModels` — we want the picker to read in the order
 * we list the models in `getCodexModels` (newest generation first, then
 * tier from flagship → balanced → fast).
 */
function getCodexModelPriority(model: Model): number {
  return model.size === "default" ? 0 : 1;
}

function normalizeCodexModels(models: Model[]): Model[] {
  return models
    .filter((model) => !STALE_CODEX_MODEL_IDS.has(model.id))
    .sort((a, b) => getCodexModelPriority(a) - getCodexModelPriority(b));
}

/** Well-known models available through Codex CLI (user authenticates separately). */
function getCodexModels(): Model[] {
  return normalizeCodexModels([
    { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "codex", size: "flagship" },
    { id: "gpt-6-sol", name: "GPT-6 Sol", provider: "codex", size: "default" },
    { id: "gpt-6-luna", name: "GPT-6 Luna", provider: "codex", size: "fast" },
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
    { id: "claude-opus-5-5", name: "Opus 5.5", provider: "claude", size: "default" },
    { id: "claude-opus-5", name: "Opus 5", provider: "claude", size: "" },
    { id: "claude-sonnet-5", name: "Sonnet 5", provider: "claude", size: "" },
    { id: "claude-fable-5", name: "Fable 5", provider: "claude", size: "" },
  ];
}

async function fetchAnitaFallbackModels(): Promise<Model[]> {
  const modelLists = await Promise.all([
    fetchOllamaModels(),
    ...PROVIDERS.map(async (p) => {
      if (p.id === "cloudflare") {
        const [accountId, apiToken, aiGatewayId] = await Promise.all([
          getApiKeyField("cloudflare", "accountId"),
          getApiKeyField("cloudflare", "apiToken"),
          getApiKeyField("cloudflare", "aiGatewayId"),
        ]);
        if (!apiToken) return [];
        return fetchCloudflareModels(accountId, apiToken, aiGatewayId);
      }
      // No other single-field provider ships a fetcher today. If a new
      // one is added, either special-case it like Cloudflare or wire a
      // `Record<providerId, fetcher>` map here.
      return [];
    }),
  ]);

  return modelLists.flat();
}

export async function fetchAnitaModels(): Promise<Model[]> {
  const anitaCliModels = await fetchAnitaCliModels();
  if (anitaCliModels.length > 0) return anitaCliModels;

  return fetchAnitaFallbackModels();
}
