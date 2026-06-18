/*
 * System preamble injected into every agent turn (issue #109).
 *
 * Always tells the agent it's running inside Controller. Browser tooling is
 * now covered by the managed `browser` skill installed on startup, so the
 * detailed controller-browser CLI instructions have been removed from the
 * runtime preamble to avoid duplication.
 *
 * Delivery is provider-aware (see `server/routes/sessions.ts`):
 *   - Ada: passed to the CLI via `--system-prompt`, so it lands in Ada's system
 *     prompt section and is never part of the chat transcript.
 *   - Codex / Claude: prepended to the user message (framed with
 *     `framePreambleForPrompt`), since those providers have no reliable
 *     system-prompt channel in their default modes today.
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
 * system-prompt flag today (Codex in default mode, Claude in default mode),
 * so it can be prepended to the user message without the agent repeating it
 * back. Ada receives the preamble via `--system-prompt` instead and does not
 * need this wrapper — see the call site in `server/routes/sessions.ts`.
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
