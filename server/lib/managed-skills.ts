/*
 * Installs app-managed skills for each agent.
 *
 * We write the bundled `SKILL.md` files into each provider's user skills home
 * on startup. Files we don't own (no managed marker) are left untouched so
 * user edits are never clobbered.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { browserCliInstalledPath } from "./browser-cli.js";
import { integrationCliInstalledPath } from "./integration-cli.js";

const MANAGED_MARKER = "<!-- managed-by: coding-orchestrator (issue #109) -->";

function buildIntegrationsSkillBody(cliPath: string): string {
  return `---
name: integrations
description: Discover and use the third-party services the user connected in Controller (APIs, MCP servers, native CLIs) through a uniform gateway. Use whenever a task needs an external service — search for a capability, then call it. Credentials are injected by Controller; you never see or handle secrets.
---

${MANAGED_MARKER}

# Integrations

The user configures third-party connections in Controller's Settings →
Integrations. You reach them through one gateway CLI, invoked by its absolute
install path (it is not on your PATH): \`${cliPath}\`.

Controller holds the credentials and injects them server-side when making the
call — there is no token for you to read, and you must never ask the user to
paste one into the chat. Authentication is set up in the UI.

## Discovery flow (work from broad to specific)

1. \`${cliPath} list\` — the integrations enabled for this session, each tagged
   with its kind: \`api\` (proxied HTTP), \`mcp\` (structured tools), or \`cli\`
   (a native binary you invoke directly).
2. \`${cliPath} search <query>\` — fuzzy-search tools across all connected
   integrations. Start here when you know the capability but not the service.
3. \`${cliPath} tools <integration>\` — list one integration's tools.
4. \`${cliPath} describe <integration> <tool>\` — one tool's parameters/schema.

Nothing loads until you ask, so prefer \`search\`/\`describe\` over dumping
everything.

## Using an integration

- \`${cliPath} call <integration> <tool> --json '{"arg":"value"}'\` — for
  **schema-backed** backends (MCP tools, OpenAPI operations). Controller
  validates the arguments and makes the call.
- \`${cliPath} request <integration> <METHOD> <path> [--query k=v]... [--header k=v]... [--data '<body>']\`
  — the **raw escape hatch** for generic REST/HTTP connections that have no
  schema. Controller only injects auth; you choose the method, path, and body.
- \`${cliPath} status <integration>\` — whoami / health check.

Rule of thumb: if \`tools\`/\`describe\` show the operation, use \`call\`; if the
integration is generic HTTP with no schema, use \`request\`.

## GraphQL integrations

A \`graphql\` integration has no fixed tool list, so \`tools\`/\`call\` don't apply.
Send operations with \`request\`, POSTing to the endpoint (use an empty path):

\`\`\`
${cliPath} request <integration> POST "" --data '{"query":"{ viewer { login } }"}'
\`\`\`

To learn the schema, POST a GraphQL introspection query the same way, then build
your real query from the result.

## CLI-native integrations

An integration tagged \`cli\` (e.g. \`gh\`, \`aws\`, \`gcloud\`) is **not** proxied.
Run \`status\` to confirm it is installed and authenticated, then invoke the real
binary directly in your shell — the gateway just points you at it.

## When authentication is missing or expired

\`call\`, \`request\`, and \`status\` may report **"Re-authentication needed"**.
That means the connection isn't authorized (or its token expired). You cannot
fix this yourself — tell the user to open Controller → Integrations and connect
the integration, then retry.
`;
}

function buildBrowserSkillBody(cliPath: string): string {
  return `---
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
is \`${cliPath}\`:

## Commands

- \`${cliPath} open <url>\` — open a URL in the preview pane. Accepts
  \`localhost:PORT\`, a full \`http(s)://\` URL, or a project-relative file path
  (e.g. \`./dist/index.html\`).
- \`${cliPath} snapshot [selector]\` — print a text snapshot of the current page
  (title, URL, and visible text). Pass a CSS selector to scope it to a subtree.
  Read this to confirm what rendered.
- \`${cliPath} click <selector>\` — click the element matching a CSS selector.
- \`${cliPath} type <selector> <text> [--submit]\` — type text into a field. Add
  \`--submit\` to submit its form.

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
}

const CONTROLLER_SCRIPTS_SKILL_BODY = `---
name: controller-scripts
description: Create and update the Controller coding orchestrator's per-project .coding-orchestrator/setup.sh and .coding-orchestrator/run.sh scripts. Use whenever a project needs to configure how worktrees install dependencies, set up ports or environment variables, and start local development services. Also use when the user asks for setup/run scripts, dev server configuration per worktree, PORT_OFFSET handling, or migrating conductor.json/.superset script configs into native Controller scripts.
---

${MANAGED_MARKER}

# Controller Scripts

Controller resolves native scripts from the project's root
\`.coding-orchestrator/\` directory:

- \`setup.sh\` — runs once when a new worktree is created. Install dependencies,
  generate config files, run migrations, or copy secrets here.
- \`run.sh\` — runs when the user clicks **Run**. Start dev servers,
  background workers, or any process needed for the project.

Controller copies that script directory into each worktree on creation, so edits
must be made at the project/source path (\`$SOURCE_PATH/.coding-orchestrator/\`),
not inside an individual worktree.

Controller also supports \`archive.sh\` (run before a worktree is deleted) and
fallback configs such as \`conductor.json\` or \`.superset/config.json\`, but
prefer native \`.coding-orchestrator\` scripts.

## When this skill applies

- A project needs a \`setup.sh\` or \`run.sh\`.
- Existing scripts are broken, missing, or use wrong ports/env vars.
- The user asks to migrate from \`conductor.json\` or \`.superset\` configs.
- The user asks how to configure dev servers per worktree (port offsets,
  env files, etc.).

## Environment available to scripts

Controller exports these variables before running the scripts:

| Variable | Meaning |
| --- | --- |
| \`WORKTREE_PATH\` | Absolute path to the worktree where the script runs |
| \`SOURCE_PATH\` | Absolute path to the project's main/source directory |
| \`WORKTREE_NAME\` | Name of the worktree (e.g., \`main\`, \`issue-123\`) |
| \`BRANCH\` | Git branch checked out in the worktree |
| \`PROJECT_ID\` | Controller project UUID |
| \`PORT_OFFSET\` | Numeric offset for this worktree (0 for main, then 3, 6, ...) |
| \`CLIENT_BASE_PORT\` | Base port for the client/Vite dev server (default 4500) |
| \`API_BASE_PORT\` | Base port for the API/backend server (default 3100) |

Use \`PORT_OFFSET\` to give each worktree isolated ports. Controller uses a
stride of 3 to avoid collisions when a project needs consecutive ports.

## Writing setup.sh

- Start with \`#!/bin/bash\` and \`set -e\`.
- Keep the script idempotent where possible: it may be re-run manually.
- Install dependencies (\`npm install\`, \`pnpm install\`,
  \`pip install -r requirements.txt\`, etc.).
- Generate local config files (\`.env.local\`, \`config/local.json\`, etc.)
  if the app needs them.
- Copy secrets from \`SOURCE_PATH\` only when necessary; prefer references to
  Controller-managed env vars.
- Avoid starting long-running services; \`setup.sh\` must finish and exit.

## Writing run.sh

- Start with \`#!/bin/bash\` and \`set -e\`.
- Export any environment variables that child processes need (dev servers read
  env, not just shell variables).
- Compute final ports from \`CLIENT_BASE_PORT\`, \`API_BASE_PORT\`, and
  \`PORT_OFFSET\`.
- Launch the command that starts the project (e.g., \`npm run dev\`,
  \`pnpm dev\`, \`python manage.py runserver\`).
- \`run.sh\` is expected to stay running while the user is working.

## Port pattern

Use this snippet when the project has separate client and API ports:

\`\`\`bash
#!/bin/bash
set -e

CLIENT_BASE_PORT="\${CLIENT_BASE_PORT:-4500}"
API_BASE_PORT="\${API_BASE_PORT:-3100}"
OFFSET="\${PORT_OFFSET:-0}"

if ! [[ "\$CLIENT_BASE_PORT" =~ ^[0-9]+$ ]]; then
  echo "CLIENT_BASE_PORT must be a number" >&2
  exit 1
fi
if ! [[ "\$API_BASE_PORT" =~ ^[0-9]+$ ]]; then
  echo "API_BASE_PORT must be a number" >&2
  exit 1
fi
if ! [[ "\$OFFSET" =~ ^[0-9]+$ ]]; then
  echo "PORT_OFFSET must be a number" >&2
  exit 1
fi

CLIENT_PORT=$((CLIENT_BASE_PORT + OFFSET))
API_PORT=$((API_BASE_PORT + OFFSET))
\`\`\`

In \`setup.sh\`, write these values to the local env file:

\`\`\`bash
cat > .env.local <<EOF
# Generated by .coding-orchestrator/setup.sh for this worktree.
PORT=\$API_PORT
API_PORT=\$API_PORT
VITE_API_PORT=\$API_PORT
VITE_DEV_SERVER_PORT=\$CLIENT_PORT
EOF
\`\`\`

In \`run.sh\`, export them before starting the app:

\`\`\`bash
export PORT="\$API_PORT"
export API_PORT="\$API_PORT"
export VITE_API_PORT="\$API_PORT"
export VITE_DEV_SERVER_PORT="\$CLIENT_PORT"

npm run dev
\`\`\`

## File paths and permissions

- Scripts live at \`$SOURCE_PATH/.coding-orchestrator/setup.sh\` and
  \`$SOURCE_PATH/.coding-orchestrator/run.sh\`. Controller copies them into each
  worktree on creation.
- Make scripts executable:
  \`chmod +x $SOURCE_PATH/.coding-orchestrator/setup.sh $SOURCE_PATH/.coding-orchestrator/run.sh\`.
- \`setup.sh\` and \`run.sh\` run from the worktree root (\`\$WORKTREE_PATH\`).

## Simple project template

For a Node/Vite + API project, in \`$SOURCE_PATH/.coding-orchestrator/\`:

\`setup.sh\`:

\`\`\`bash
#!/bin/bash
set -e

npm install
\`\`\`

\`run.sh\`:

\`\`\`bash
#!/bin/bash
set -e

npm run dev
\`\`\`

## How to update existing scripts

1. Read the current scripts at \`$SOURCE_PATH/.coding-orchestrator/\` and the
   project's \`package.json\` / startup commands.
2. Identify what env vars and ports the project actually needs.
3. Edit or recreate \`setup.sh\` and \`run.sh\` in the source project path.
4. Validate bash syntax:
   \`bash -n $SOURCE_PATH/.coding-orchestrator/setup.sh\` and
   \`bash -n $SOURCE_PATH/.coding-orchestrator/run.sh\`.
5. Run \`setup.sh\` manually in the worktree to confirm it finishes
   successfully.
6. Run \`run.sh\` via Controller's Run button or terminal to confirm services
   start.

## Fallback formats

If \`.coding-orchestrator/setup.sh\` or \`run.sh\` are missing, Controller reads,
in order:

1. \`conductor.json\` (\`scripts.setup\`, \`scripts.run\`, \`runScriptMode\`)
2. \`.superset/config.json\` (\`setup\`, \`run\`, \`teardown\`)

When migrating, translate those JSON commands into native shell scripts at
\`$SOURCE_PATH/.coding-orchestrator/\` and delete the fallback config files.
`;

interface ManagedSkill {
  name: string;
  body: string;
}

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
 * Write the managed skills into each provider's user skills home.
 * Idempotent: skips files that exist but aren't ours, and avoids rewriting
 * identical content.
 */
export async function installManagedSkills(): Promise<void> {
  const cliPath = browserCliInstalledPath();
  const skills: ManagedSkill[] = [
    { name: "browser", body: buildBrowserSkillBody(cliPath) },
    { name: "integrations", body: buildIntegrationsSkillBody(integrationCliInstalledPath()) },
    { name: "controller-scripts", body: CONTROLLER_SCRIPTS_SKILL_BODY },
  ];

  for (const { dir } of providerHomes()) {
    for (const skill of skills) {
      const skillFile = path.join(dir, skill.name, "SKILL.md");
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
      if (existing === skill.body) continue;

      await fs.mkdir(path.dirname(skillFile), { recursive: true });
      await fs.writeFile(skillFile, skill.body, "utf-8");
    }
  }
}

/** @deprecated Use {@link installManagedSkills} instead. */
export async function installBrowserSkills(): Promise<void> {
  return installManagedSkills();
}
