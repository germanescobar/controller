import test from "node:test";
import assert from "node:assert/strict";
import type { Model } from "../api.ts";
import { modelProviderLabel } from "./model-labels.ts";

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: "provider/some-model",
    name: "Some Model",
    provider: "provider",
    size: "",
    ...overrides,
  };
}

test("modelProviderLabel prefers the structured group when present", () => {
  // `group` is the human-readable label reported by `anita models --json`
  // (e.g. "Ollama Cloud", "Local"); it always wins over the id prefix.
  const m = model({ group: "Ollama Cloud", provider: "ollama-cloud" });
  assert.equal(modelProviderLabel(m), "Ollama Cloud");
});

test("modelProviderLabel falls back to a title-cased provider id", () => {
  // No `group` field — common for ollama fallback, codex, claude, etc.
  const m = model({ provider: "ollama-cloud" });
  assert.equal(modelProviderLabel(m), "Ollama Cloud");
});

test("modelProviderLabel title-cases underscore-separated provider ids", () => {
  const m = model({ provider: "open_router" });
  assert.equal(modelProviderLabel(m), "Open Router");
});

test("modelProviderLabel handles a single-segment provider id", () => {
  const m = model({ provider: "groq" });
  assert.equal(modelProviderLabel(m), "Groq");
});

test("modelProviderLabel returns empty string when no provider can be derived", () => {
  assert.equal(modelProviderLabel(undefined), "");
  assert.equal(modelProviderLabel(model({ provider: "", group: undefined })), "");
});

test("modelProviderLabel returns empty string for an undefined model", () => {
  assert.equal(modelProviderLabel(undefined), "");
});