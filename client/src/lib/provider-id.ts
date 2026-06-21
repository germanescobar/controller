/* Provider id normalization (client mirror of `server/lib/provider-id.ts`).
 *
 * The default coding agent was renamed from "Ada" to "Anita". Sessions created
 * before the rename may still carry the legacy "ada" provider id, so we resolve
 * it to the canonical "anita" on read. */

/** Canonical id of the default agent provider. */
export const DEFAULT_PROVIDER_ID = "anita";

/** Legacy provider ids mapped to their canonical replacement. */
const LEGACY_PROVIDER_IDS: Record<string, string> = { ada: "anita" };

/**
 * Resolve a possibly-legacy/empty provider id to its canonical form. Empty or
 * missing ids resolve to the default provider so older sessions (which omit the
 * field) keep working.
 */
export function canonicalProviderId(id: string | null | undefined): string {
  if (!id) return DEFAULT_PROVIDER_ID;
  return LEGACY_PROVIDER_IDS[id] ?? id;
}
