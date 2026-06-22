/*
 * Selector engines for the agent-controlled preview browser (issue #170).
 *
 * The CLI and renderer accept the same opaque selector strings, with optional
 * engine prefixes: `text=`, `role=`, `label=`, `placeholder=`, `ref=`. A bare
 * selector (no prefix) is treated as CSS for backward compatibility with the
 * pre-#170 surface.
 *
 * The parser is pure and lives on both sides: the CLI uses it for help text
 * and validation, and the in-page script generated for the renderer embeds the
 * same engine dispatch so a `text=Cancel` from the agent resolves the same way
 * regardless of who sent it.
 */

export type SelectorEngine =
  | "css"
  | "text"
  | "role"
  | "label"
  | "placeholder"
  | "ref";

export interface ParsedSelector {
  engine: SelectorEngine;
  /**
   * Engine payload:
   * - `css`/`text`/`label`/`placeholder`/`ref`: the literal value after the
   *   `engine=` prefix.
   * - `role`: the role token (e.g. `button`).
   */
  value: string;
  /** `role=button[name="Submit"]` only: the accessible name filter. */
  name?: string;
}

/** All engines the protocol understands, in the order the parser tests them. */
const ENGINE_PREFIXES = [
  "text=",
  "role=",
  "label=",
  "placeholder=",
  "ref=",
] as const;

/**
 * Recognize an engine prefix without committing to a full parse. Used by the
 * CLI to validate input up front and by tests to assert the engine set stays
 * stable.
 */
export function isSelectorEnginePrefix(input: string): boolean {
  if (!input) return false;
  const lower = input.toLowerCase();
  return ENGINE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Parse a selector string into an engine + payload. Whitespace inside `value`
 * is preserved (the in-page matcher handles it), and `role=` accepts an
 * optional `[name="..."]` filter.
 */
export function parseSelector(input: string): ParsedSelector {
  if (input == null) return { engine: "css", value: "" };
  const raw = String(input);
  const lower = raw.toLowerCase();
  if (lower.startsWith("text=")) {
    return { engine: "text", value: raw.slice("text=".length) };
  }
  if (lower.startsWith("role=")) {
    const rest = raw.slice("role=".length);
    const nameMatch = /^(.+?)\[name=(["'])(.*?)\2\]\s*$/.exec(rest);
    if (nameMatch) {
      return { engine: "role", value: nameMatch[1].trim(), name: nameMatch[3] };
    }
    return { engine: "role", value: rest.trim() };
  }
  if (lower.startsWith("label=")) {
    return { engine: "label", value: raw.slice("label=".length) };
  }
  if (lower.startsWith("placeholder=")) {
    return { engine: "placeholder", value: raw.slice("placeholder=".length) };
  }
  if (lower.startsWith("ref=")) {
    return { engine: "ref", value: raw.slice("ref=".length) };
  }
  return { engine: "css", value: raw };
}
