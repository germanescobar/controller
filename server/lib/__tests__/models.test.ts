import test from "node:test";
import assert from "node:assert/strict";
import {
  __test__fetchCloudflareModels,
  getClaudeModels,
} from "../models.js";

/**
 * The Cloudflare model fetcher is the only behavior in `models.ts` that
 * carries issue-specific surface area (gateway id, account id, AI token).
 * Other fetchers (Ollama) are simple and well-covered by their own
 * callers. Tests focus on routing and shape so a future change to the
 * upstream URL or response wrapper is caught.
 */
test("returns an empty list when the API token is missing", async () => {
  const models = await __test__fetchCloudflareModels("acc-1", null, "gw-1");
  assert.deepEqual(models, []);
});

test("returns an empty list when account id is missing and no gateway id is set", async () => {
  const models = await __test__fetchCloudflareModels(null, "tok-1", null);
  assert.deepEqual(models, []);
});

test("uses the AI gateway when both gateway id and account id are set", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | null = null;
  let capturedHeaders: Record<string, string> | null = null;
  globalThis.fetch = (async (url, init) => {
    capturedUrl = String(url);
    capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
    return new Response(
      JSON.stringify({
        result: [
          { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const models = await __test__fetchCloudflareModels("acc-1", "tok-1", "gw-1");
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    assert.equal(models[0].group, "Cloudflare Gateway");
    assert.equal(models[0].provider, "cloudflare");
    assert.equal(
      capturedUrl,
      "https://gateway.ai.cloudflare.com/v1/acc-1/gw-1/workers-ai/models"
    );
    assert.equal(capturedHeaders?.Authorization, "Bearer tok-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to the Workers AI REST API when the gateway id is missing", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | null = null;
  globalThis.fetch = (async (url) => {
    capturedUrl = String(url);
    return new Response(
      JSON.stringify({
        result: [
          { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const models = await __test__fetchCloudflareModels("acc-1", "tok-1", null);
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    assert.equal(models[0].group, "Cloudflare");
    assert.equal(
      capturedUrl,
      "https://api.cloudflare.com/client/v4/accounts/acc-1/ai/v1/models"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns an empty list when the upstream responds with a non-OK status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 401 })) as typeof fetch;

  try {
    const models = await __test__fetchCloudflareModels("acc-1", "tok-1", "gw-1");
    assert.deepEqual(models, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns an empty list when the fetch itself throws", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;

  try {
    const models = await __test__fetchCloudflareModels("acc-1", "tok-1", "gw-1");
    assert.deepEqual(models, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to the model id when the upstream omits a name", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ result: [{ id: "@cf/anonymous/model" }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  try {
    const models = await __test__fetchCloudflareModels("acc-1", "tok-1", null);
    assert.equal(models.length, 1);
    assert.equal(models[0].name, "@cf/anonymous/model");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getClaudeModels lists the Claude 5.5 lineup first, then legacy pins", () => {
  const models = getClaudeModels();
  assert.deepEqual(
    models.map((m) => [m.id, m.name, m.size]),
    [
      ["claude-opus-5-5", "Opus 5.5", "default"],
      ["claude-sonnet-5-5", "Sonnet 5.5", ""],
      ["claude-haiku-5-5", "Haiku 5.5", ""],
      ["claude-fable-5-2", "Fable 5.2", ""],
      ["claude-opus-5", "Opus 5", ""],
      ["claude-sonnet-5", "Sonnet 5", ""],
      ["claude-fable-5", "Fable 5", ""],
    ],
  );
  assert.ok(models.every((m) => m.provider === "claude"));
  assert.equal(models.filter((m) => m.size === "default").length, 1);
});
