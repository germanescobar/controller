/*
 * System preamble injected into every agent turn (issue #109).
 *
 * Always tells the agent it's running inside Controller. When the session's
 * Electron preview pane is connected, it also advertises the `controller-browser`
 * CLI and steers the agent away from its built-in browser/web tooling so all
 * browsing flows through the visible pane. The browser section is gated per turn
 * on whether a pane host is currently registered, which is a precise proxy for
 * "the user has this session open in the desktop app."
 */

export interface ControllerPreambleOptions {
  /** Whether a visible preview pane is connected for this session. */
  browserAvailable: boolean;
  /** Absolute path to the installed `controller-browser` CLI. */
  cliPath: string;
}

export function buildControllerPreamble({
  browserAvailable,
  cliPath,
}: ControllerPreambleOptions): string {
  const lines = [
    "You are running inside Controller, a desktop orchestrator for coding agents.",
  ];

  if (browserAvailable) {
    const bin = `"${cliPath}"`;
    lines.push(
      "",
      "A visible in-app preview browser is available. Use it — instead of any built-in web/browser automation — to open and verify local or preview pages. Invoke it by its absolute path (it is not on your PATH):",
      `- \`${bin} open <url>\` — localhost, a web URL, or a project file path`,
      `- \`${bin} snapshot [selector]\` — read the rendered page`,
      `- \`${bin} click <selector>\` — click an element`,
      `- \`${bin} type <selector> <text> [--submit]\` — fill a field`,
      "Run them from your shell; they drive the preview pane the user is watching."
    );
  }

  return lines.join("\n");
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
