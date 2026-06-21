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
import { controllerCliInstalledPath } from "./controller-cli.js";

export const MANAGED_MARKER =
  "<!-- managed-by: coding-orchestrator (issue #159) -->";

function buildIntegrationsSkillBody(cliPath: string): string {
  return `---
name: controller-integrations
description: Discover and use the third-party services the user connected in Controller (APIs, MCP servers, native CLIs) through a uniform gateway. Use whenever a task needs an external service — search for a capability, then call it. Credentials are injected by Controller; you never see or handle secrets.
---

${MANAGED_MARKER}

# Integrations

The user configures third-party connections in Controller's Settings →
Integrations. You reach them through the Controller CLI, invoked by its absolute
path (it is not on your PATH). Every command below is run as
\`${cliPath} integrations <command>\`.

This skill is managed by the Controller app (directory name
\`controller-integrations\`). It is hidden from the \`/\` picker — the agent
discovers the body through the filesystem location, not via a user-invoked
slash command.

Controller holds the credentials and injects them server-side when making the
call — there is no token for you to read, and you must never ask the user to
paste one into the chat. Authentication is set up in the UI.

## Discovery flow (work from broad to specific)

1. \`${cliPath} integrations list\` — the integrations enabled for this session,
   each tagged with how to use it: \`tools\` (schema-backed — OpenAPI/MCP;
   discover with \`tools\`/\`describe\`, then \`call\`), \`request\` (raw HTTP — use
   \`request\`), or \`cli\` (a native binary you invoke directly).
2. \`${cliPath} integrations search <query>\` — fuzzy-search tools across all
   connected integrations. Start here when you know the capability but not the
   service.
3. \`${cliPath} integrations tools <integration>\` — list one integration's
   tools.
4. \`${cliPath} integrations describe <integration> <tool>\` — one tool's
   parameters/schema.

Nothing loads until you ask, so prefer \`search\`/\`describe\` over dumping
everything.

## Using an integration

- \`${cliPath} integrations call <integration> <tool> --json '{"arg":"value"}'\`
  — for **schema-backed** backends (MCP tools, OpenAPI operations). Controller
  validates the arguments and makes the call.
- \`${cliPath} integrations request <integration> <METHOD> <path> [--query k=v]... [--header k=v]... [--data '<body>']\`
  — the **raw escape hatch** for generic REST/HTTP connections that have no
  schema. Controller only injects auth; you choose the method, path, and body.
- \`${cliPath} integrations status <integration>\` — whoami / health check.

Rule of thumb by \`kind\` (from \`list\`): a **\`tools\`** integration (OpenAPI or
MCP) is schema-backed — run \`tools\`/\`describe\` and \`call\`; don't hand-build
URLs. A **\`request\`** integration (GraphQL or raw HTTP) has no tool list — use
\`request\`. Always try discovery before falling back to \`request\`.

## GraphQL integrations

A \`graphql\` integration has no fixed tool list, so \`tools\`/\`call\` don't apply.
Send operations with \`request\`, POSTing to the endpoint (use an empty path):

\`\`\`
${cliPath} integrations request <integration> POST "" --data '{"query":"{ viewer { login } }"}'
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
name: controller-browser
description: Drive the visible in-app preview browser to open pages, read the rendered DOM, and click or type — use it to verify UI/web work instead of guessing.
---

${MANAGED_MARKER}

# Browser

You can control the visible preview pane in the orchestrator with the preview
browser CLI. Use it to verify front-end and web work: open a localhost dev
server or a project HTML file, read what actually rendered, and interact with
the page. The user sees everything you do in the Preview tab.

This skill is managed by the Controller app (directory name
\`controller-browser\`). It is hidden from the \`/\` picker — the agent
discovers the body through the filesystem location, not via a user-invoked
slash command.

Invoke the CLI by its absolute path — it is not on your PATH. Every command
below is run as \`${cliPath} browser <command>\`:

## Commands

- \`${cliPath} browser open <url>\` — open a URL in the preview pane. Accepts
  \`localhost:PORT\`, a full \`http(s)://\` URL, or a project-relative file path
  (e.g. \`./dist/index.html\`).
- \`${cliPath} browser snapshot [selector]\` — print a text snapshot of the
  current page (title, URL, and visible text). Pass a CSS selector to scope it
  to a subtree. Read this to confirm what rendered.
- \`${cliPath} browser click <selector>\` — click the element matching a CSS
  selector.
- \`${cliPath} browser type <selector> <text> [--submit]\` — type text into a
  field. Add \`--submit\` to submit its form.

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

This skill is managed by the Controller app (directory name
\`controller-scripts\`). It is hidden from the \`/\` picker — the agent
discovers the body through the filesystem location, not via a user-invoked
slash command.

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

Use \`PORT_OFFSET\` to give each worktree isolated ports. Controller uses a
stride of 3 to avoid collisions when a project needs consecutive ports. Each
project script must define its own base ports; Controller does not provide or
guess project-specific port defaults.

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
- Compute final ports from project-owned base ports and \`PORT_OFFSET\`.
- Launch the command that starts the project (e.g., \`npm run dev\`,
  \`pnpm dev\`, \`python manage.py runserver\`).
- \`run.sh\` is expected to stay running while the user is working.

## Port pattern

Use this snippet when the project has separate client and API ports:

\`\`\`bash
#!/bin/bash
set -e

CLIENT_BASE_PORT=5173
API_BASE_PORT=3000
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

function buildSearchSkillsBody(cliPath: string): string {
  return `---
name: controller-search-skills
description: Search and activate unified skills from the Controller catalog. Use when the user asks for a capability that might already be configured as a unified skill, or when you want to reuse an existing skill for the current turn.
---

${MANAGED_MARKER}

# Search Skills

This skill is managed by the Controller app (directory name
\`controller-search-skills\`). It is hidden from the \`/\` picker — the agent
discovers the body through the filesystem location, not via a user-invoked
slash command.

Controller hosts an app-owned catalog of unified skills in Settings → Skills.
These skills are available to every agent and take precedence over per-agent
skills with the same name. You can search the catalog and activate a skill so
its body is applied to your current turn, exactly as if the user had invoked it
with the \`/\` picker. You can also import skills the user has installed under a
per-agent location (e.g. \`~/.codex/skills/...\` or \`<project>/.anita/skills/...\`)
into the unified catalog so they take precedence by name.

Invoke the CLI by its absolute path — it is not on your PATH. Every command
below is run as \`${cliPath} skills <command>\`:

## Commands

- \`${cliPath} skills list\` — list every unified skill (name + description).
- \`${cliPath} skills search <query>\` — search unified skills by name or keyword.
- \`${cliPath} skills describe <name>\` — print the full SKILL.md body of a
  unified skill.
- \`${cliPath} skills activate <name>\` — activate a unified skill for the current
  turn. Controller will prepend the skill body to the user's message the same
  way the \`/\` picker does.
- \`${cliPath} skills import-discover\` — list per-agent skills that are eligible
  for import into the unified catalog (one entry per source \`SKILL.md\`, tagged
  with \`<provider>/<scope>\` and the project path for repo skills).
- \`${cliPath} skills import --provider <id> --source <path> [--scope <scope>] [--overwrite]\`
  — copy a single per-agent skill into the unified catalog. Use
  \`${cliPath} skills import --all\` to import every entry from
  \`import-discover\` in one go.

## How to use it

1. If you need a specific style or set of instructions, run \`search\` or
   \`list\` to see whether a matching unified skill already exists.
2. Use \`describe\` to read the full skill body before deciding to apply it.
3. Use \`activate\` to apply the skill to the current turn. The skill takes
   effect on the *next* user message you send.

## Promoting a per-agent skill to unified

When a per-agent skill is more important than the per-agent location it lives
in — for example, the user wants it to be available across every agent — run
\`import-discover\`, then import the entries you care about. Defaults: name
collisions with an existing unified skill are **skipped**; pass \`--overwrite\`
to replace. The server returns one status per skill (\`imported\` / \`skipped\` /
\`error\`) so you can show the user a clear summary.

## Notes

- Unified skills are managed by the user in Controller Settings → Skills.
- Activation is scoped to the current turn; it does not permanently change the
  session's behavior.
- Importing copies a per-agent \`SKILL.md\` into the unified catalog under
  \`~/coding-orchestrator/skills/\`. The original per-agent file is left in
  place; the unified copy takes precedence by name.
- If a command reports that no skill matches, you can still fall back to normal
  prompting.
`;
}

interface ManagedSkill {
  name: string;
  body: string;
}

function buildSkillCreatorSkillBody(cliPath: string): string {
  return `---
name: controller-skill-creator
description: Create a new unified skill in the Controller catalog by interviewing the user, drafting a SKILL.md, and writing it via the Controller CLI. Use when the user asks to build a new skill, document a recurring workflow, or turn a one-off conversation into a reusable skill.
---

${MANAGED_MARKER}

# Skill Creator

This skill is managed by the Controller app (directory name
\`controller-skill-creator\`). It is hidden from the \`/\` picker — the agent
discovers the body through the filesystem location, not via a user-invoked
slash command.

You help the user create a new unified skill in Controller's app-owned
catalog at \`~/coding-orchestrator/skills/<name>/SKILL.md\`. Skills created
here are available to every agent immediately and surface in the \`/\`
picker.

Use the Controller CLI to validate, write, and verify the skill:

\`\`\`
${cliPath} skills list
${cliPath} skills search <query>
${cliPath} skills create --name <name> --description <description> [--body <body> | --body-file <path>]
\`\`\`

The CLI is invoked by its absolute path — it is **not** on your PATH. Always
pass the full path shown above.

## Workflow

Follow these steps in order. Skip a step only when the user has already
provided the relevant information explicitly.

1. **Understand intent.** Ask clarifying questions until you can articulate
   what the skill should do, when the agent should reach for it, and what
   "good" looks like. Prefer concrete examples over abstractions.

2. **Check for collisions.** Run \`${cliPath} skills search <keyword>\` with
   a couple of queries that describe the proposed skill. If a near-match
   already exists, surface it and ask the user whether to refine the
   existing skill, pick a different name, or continue anyway.

3. **Draft the skill.** Write the three required fields:
   - \`name\` — lowercase, letters/digits/dots/dashes/underscores only, up
     to 64 characters. Recommend something the user can type as a
     \`/<name>\` invocation.
   - \`description\` — one sentence, up to 1024 characters, that tells the
     agent *when* to use the skill. The description is the trigger; make
     it concrete (\"Use when...\").
   - \`body\` — the markdown body that follows the frontmatter. Use the
     same tone as the other managed skills (sections, code blocks for
     commands, "When this skill applies", "Notes"). Bodies are written as
     guidance for the agent, not user-facing copy.

4. **Confirm with the user.** Show the proposed \`name\`, \`description\`,
   and a short summary of the body. Do not call \`create\` until the user
   explicitly approves.

5. **Write the skill.** Invoke:

   \`\`\`
   ${cliPath} skills create --name <name> --description <description> --body-file /tmp/skill-body.md
   \`\`\`

   Write the body to a temp file (or use \`--body\` for short skills) so
   you don't have to hand-craft frontmatter. The CLI validates the name
   and description and rejects duplicates.

6. **Verify.** Run \`${cliPath} skills describe <name>\` to confirm the
   file was written correctly, and \`${cliPath} skills search <keyword>\`
   to confirm it shows up in the catalog.

7. **Hand off.** Tell the user the new skill is available: it will appear
   in the \`/\` picker for any agent in any worktree, and they can edit or
   delete it from Settings → Skills.

## Handling errors

The \`create\` command returns a non-zero status and prints the validation
error to stderr when input is rejected. Common cases:

- **Duplicate name** — pick a different name and try again.
- **Invalid name** (contains spaces, slashes, or other forbidden chars;
  longer than 64 characters) — propose a corrected name and confirm.
- **Missing or too-long description** — rewrite the description so it
  fits the 1024-character limit and clearly describes the trigger.
- **Empty body** — ask the user to confirm what the skill should instruct
  the agent to do, then re-run \`create\`.

Never silently rewrite the user's input; surface the error and ask.

## Editing an existing skill

This skill creates *new* skills. To edit a skill the user already has,
point them at Settings → Skills, or use the \`update\` API
(\`PUT /api/unified-skills/<name>\`) directly. The CLI \`create\` command
fails on duplicate names so it cannot be used as an edit path.

## Notes

- Unified skills take precedence over per-agent skills with the same name,
  so creating a skill called \`browser\` would shadow the managed
  \`controller-browser\` skill. Confirm with the user before claiming a name
  that might collide with a built-in.
- The CLI writes to \`~/coding-orchestrator/skills/<name>/SKILL.md\`. Do
  not try to write the file directly — let the CLI perform validation.
- Skill activation (\`/name\`) prepends the body to the user's next
  message, so the body should read as instructions *to the agent*, not
  prose for the user.
`;
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
    { id: "anita", dir: path.join(os.homedir(), ".anita", "skills") },
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
  // The unified CLI is invoked as `<path> <surface> <command>`. Each builder
  // embeds its own surface in the rendered commands, so we always pass the
  // bare CLI path here.
  const cli = controllerCliInstalledPath();
  const skills: ManagedSkill[] = [
    { name: "controller-browser", body: buildBrowserSkillBody(cli) },
    { name: "controller-integrations", body: buildIntegrationsSkillBody(cli) },
    { name: "controller-scripts", body: CONTROLLER_SCRIPTS_SKILL_BODY },
    { name: "controller-search-skills", body: buildSearchSkillsBody(cli) },
    { name: "controller-skill-creator", body: buildSkillCreatorSkillBody(cli) },
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
