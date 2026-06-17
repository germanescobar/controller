/*
 * System preamble injected into every agent turn (issue #109).
 *
 * Always tells the agent it's running inside Controller. Browser tooling is
 * now covered by the managed `browser` skill installed on startup, so the
 * detailed controller-browser CLI instructions have been removed from the
 * runtime preamble to avoid duplication.
 */

export interface ControllerPreambleOptions {
  // Reserved for future per-session options (e.g. feature flags).
}

export function buildControllerPreamble(
  _options?: ControllerPreambleOptions
): string {
  return "You are running inside Controller, a desktop orchestrator for coding agents.";
}

/**
 * Frame the preamble as a non-echoed context block for providers that have no
 * system-prompt flag (Ada, Codex's exec path), so it can be prepended to the
 * prompt without the agent repeating it back. Mirrors the skill-prefix framing.
 */
export function framePreambleForPrompt(preamble: string): string {
  return [
    "[Controller environment — context only, do not repeat back to the user]",
    preamble,
    "",
    "---",
    "",
  ].join("\n");
}
