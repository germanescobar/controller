/*
 * Installs the app-managed `browser` skill for each agent (issue #109).
 *
 * The skill teaches Ada, Codex, and Claude how to drive the visible preview
 * pane via the `controller-browser` CLI. We write the same SKILL.md into each
 * provider's user skills home on startup. Files we don't own (no managed
 * marker) are left untouched so user edits are never clobbered.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MANAGED_MARKER = "<!-- managed-by: coding-orchestrator (issue #109) -->";

const SKILL_BODY = `---
name: browser
description: Drive the visible in-app preview browser to open pages, read the rendered DOM, and click or type — use it to verify UI/web work instead of guessing.
---

${MANAGED_MARKER}

# Browser

You can control the visible preview pane in the orchestrator with the preview
browser CLI. Use it to verify front-end and web work: open a localhost dev
server or a project HTML file, read what actually rendered, and interact with
the page. The user sees everything you do in the Preview tab.

Invoke the CLI by its absolute install path — it is not on your PATH. The path
is \`~/coding-orchestrator/bin/controller-browser\` (expand \`~\` to your home
directory):

## Commands

- \`~/coding-orchestrator/bin/controller-browser open <url>\` — open a URL in the
  preview pane. Accepts \`localhost:PORT\`, a full \`http(s)://\` URL, or a
  project-relative file path (e.g. \`./dist/index.html\`).
- \`~/coding-orchestrator/bin/controller-browser snapshot [selector]\` — print a
  text snapshot of the current page (title, URL, and visible text). Pass a CSS
  selector to scope it to a subtree. Read this to confirm what rendered.
- \`~/coding-orchestrator/bin/controller-browser click <selector>\` — click the
  element matching a CSS selector.
- \`~/coding-orchestrator/bin/controller-browser type <selector> <text> [--submit]\`
  — type text into a field. Add \`--submit\` to submit its form.

## How to use it

1. \`open\` the page you want to inspect.
2. \`snapshot\` to read the rendered result.
3. \`click\` / \`type\` to interact, then \`snapshot\` again to confirm the effect.

## Notes

- Run the commands from your normal shell; the pane is selected automatically
  from your working directory.
- Allowed targets: localhost and project-local files by default, plus web URLs.
- If a command reports that no preview pane is connected, ask the user to open
  the Preview tab for this session, then retry.
`;

interface ProviderSkillHome {
  id: string;
  dir: string;
}

function codexSkillsHome(): string {
  const override = process.env.CODEX_HOME?.trim();
  const home = override
    ? override.replace(/^~(?=$|\/)/, os.homedir())
    : path.join(os.homedir(), ".codex");
  return path.join(home, "skills");
}

function providerHomes(): ProviderSkillHome[] {
  return [
    { id: "ada", dir: path.join(os.homedir(), ".ada", "skills") },
    { id: "codex", dir: codexSkillsHome() },
    { id: "claude", dir: path.join(os.homedir(), ".claude", "skills") },
  ];
}

/**
 * Write the managed browser skill into each provider's user skills home.
 * Idempotent: skips files that exist but aren't ours, and avoids rewriting
 * identical content.
 */
export async function installBrowserSkills(): Promise<void> {
  for (const { dir } of providerHomes()) {
    const skillFile = path.join(dir, "browser", "SKILL.md");
    let existing: string | null = null;
    try {
      existing = await fs.readFile(skillFile, "utf-8");
    } catch {
      existing = null;
    }

    if (existing !== null && !existing.includes(MANAGED_MARKER)) {
      // A user-authored skill with the same name takes precedence.
      continue;
    }
    if (existing === SKILL_BODY) continue;

    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(skillFile, SKILL_BODY, "utf-8");
  }
}
