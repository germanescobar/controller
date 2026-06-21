/* Provider id normalization.
 *
 * The default coding agent was renamed from "Ada" to "Anita" (matching the
 * `anita` CLI). The canonical provider id is now "anita", but sessions,
 * agent settings, and API callers created before the rename may still carry
 * the legacy "ada" id. We resolve the legacy id to its canonical form on read
 * so existing state keeps working without a migration. */

/** Canonical id of the default agent provider. */
export const DEFAULT_PROVIDER_ID = "anita";

/** Legacy provider ids mapped to their canonical replacement. */
const LEGACY_PROVIDER_IDS: Record<string, string> = { ada: "anita" };

/**
 * Resolve a legacy provider id (e.g. "ada") to its canonical form. Unknown
 * and empty ids pass through unchanged so callers keep full control over
 * default-fill and validation.
 */
export function canonicalProviderId(id: string): string {
  return LEGACY_PROVIDER_IDS[id] ?? id;
}
