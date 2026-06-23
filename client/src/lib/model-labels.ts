import type { Model } from "../api.ts";

/**
 * Human-readable provider label for a model. Anita models surface the
 * structured `group` (e.g., "Ollama Cloud", "Local") reported by
 * `anita models --json`; otherwise we fall back to the model id prefix
 * (`ollama-cloud`, `groq`, ...), which is always populated for models
 * returned by the API.
 *
 * Returns an empty string when no provider can be determined so callers
 * can decide whether to render the label at all.
 */
export function modelProviderLabel(model: Model | undefined): string {
  if (!model) return "";
  if (model.group) return model.group;
  if (!model.provider) return "";
  // Title-case the provider id so "ollama-cloud" reads as "Ollama Cloud".
  return model.provider
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}