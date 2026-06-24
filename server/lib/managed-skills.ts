/*
 * Installs Controller-managed skills into the unified skill catalog.
 *
 * The skills are written into the Controller home's `skills/<name>/SKILL.md`
 * directory (e.g. `~/Library/Application Support/Controller/skills/<name>/SKILL.md`
 * on macOS, `$XDG_STATE_HOME/Controller/skills/<name>/SKILL.md` on Linux; the
 * same place user-authored unified skills live) on startup. They are
 * surfaced to agents through the orchestrator's `/<name>` picker rather than
 * each provider's per-agent skills home — the agents themselves don't need
 * to see these skills natively, because they're only meaningful when the
 * user is working through Controller. Surfacing them via the unified
 * catalog also gives us a single ownership story: directory name in
 * `MANAGED_SKILL_DIRS` ⇒ owned by Controller, gets re-synchronized on every
 * startup. User-authored skills in the same parent are left strictly alone.
 *
 * Historical note: these used to be mirrored into each provider's user
 * skills home (`~/.claude/skills/controller-browser/`, etc.). That made them
 * visible to the agents without going through Controller, which conflicted
 * with their "Controller-only" semantics and confused agents that
 * mistakenly treated the controller-managed entries as the full skill
 * universe. They are now unified-catalog entries tagged with
 * `scope: "controller"` so the `/<name>` picker can show them with a clear
 * "controller" badge, grouped after user-authored unified skills.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { controllerCliInstalledPath } from "./controller-cli.js";
import { unifiedSkillDir } from "./paths.js";

/**
 * The directory names the orchestrator owns in the unified catalog. This is
 * the single source of truth used by both the install loop and the unified
 * catalog reader's scope detection — keep these two consumers in sync.
 */
export const MANAGED_SKILL_DIRS: readonly string[] = Object.freeze([
  "controller-browser",
  "controller-integrations",
  "controller-scripts",
  "controller-search-skills",
  "controller-skill-creator",
  "controller-worktrees",
]);

/** True when the given skill name (case-insensitive) is owned by the orchestrator. */
export function isManagedSkillName(name: string): boolean {
  return MANAGED_SKILL_DIRS.includes(name);
}

/**
 * Legacy alias. The previous design owned these skills by *directory name
 * inside a provider's user home* (e.g. `~/.claude/skills/controller-browser/`).
 * The new design owns them by *directory name inside the unified catalog*
 * under the Controller home (e.g.
 * `~/Library/Application Support/Controller/skills/controller-browser/`
 * on macOS). The two checks are equivalent today, but new code should
 * prefer {@link isManagedSkillName} for clarity.
 *
 * @deprecated Use {@link isManagedSkillName}.
 */
export function isManagedSkillDir(dirName: string): boolean {
  return isManagedSkillName(dirName);
}

/**
 * Build the documentary marker comment embedded in every shipped body.
 * Embedding the directory name keeps the comment useful for humans
 * (`grep`-ing for it surfaces the matching skill) without making the
 * comment an authoritative ownership signal — that's `MANAGED_SKILL_DIRS`.
 */
export function managedMarker(dirName: string): string {
  return `<!-- managed-by: coding-orchestrator (${dirName}) -->`;
}

function buildIntegrationsSkillBody(cliPath: string): string {
  return `---
name: controller-integrations
description: Discover and use the third-party services the user connected in Controller (APIs, MCP servers, native CLIs) through a uniform gateway. Use whenever a task needs an external service — search for a capability, then call it. Credentials are injected by Controller; you never see or handle secrets.
---

${managedMarker("controller-integrations")}

# Integrations

The user configures third-party connections in Controller's Settings →
Integrations. You reach them through the Controller CLI, invoked by its absolute
path (it is not on your PATH). Every command below is run as
\`${cliPath} integrations <command>\`.

This skill is managed by the Controller app (directory name
\`controller-integrations\`). It is surfaced in the \`/\` picker with the
\`controller\` tag alongside Controller's other built-in skills. Users invoke
it like any other skill: type \`/controller-integrations <query>\` or pick it
from the autocomplete.

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

${managedMarker("controller-browser")}

# Browser

You can control the visible preview pane in the orchestrator with the preview
browser CLI. Use it to verify front-end and web work: open a localhost dev
server or a project HTML file, read what actually rendered, and interact with
the page. The user sees everything you do in the Preview tab.

This skill is managed by the Controller app (directory name
\`controller-browser\`). It is surfaced in the \`/\` picker with the
\`controller\` tag alongside Controller's other built-in skills. Users invoke
it like any other skill: type \`/controller-browser <task>\` or pick it from
the autocomplete.

Invoke the CLI by its absolute path — it is not on your PATH. Every command
below is run as \`${cliPath} browser <command>\`:

## Commands

- \`${cliPath} browser open <url>\` — open a URL in the preview pane. Accepts
  \`localhost:PORT\`, a full \`http(s)://\` URL, or a project-relative file path
  (e.g. \`./dist/index.html\`).
- \`${cliPath} browser snapshot [--a11y] [selector]\` — print a snapshot of the
  current page. The default mode returns visible text plus an interactive-
  elements listing (each marked with a \`[ref=eN]\` id); pass \`--a11y\` to get
  a structured accessibility tree (role + accessible name + \`[ref=eN]\`)
  instead. Pass a CSS selector to scope the snapshot to a subtree.
- \`${cliPath} browser click <selector>\` — click an element.
- \`${cliPath} browser type <selector> <text> [--submit]\` — type text into a
  field. Add \`--submit\` to submit its form.

## Selectors for click / type

\`click\` and \`type\` accept a plain CSS selector, or a locator-style prefix
when the page's markup is outside your control. Engine prefixes:

- \`text=...\` — match by visible text (e.g. \`text=Cancel\`). Case-insensitive
  substring; prefers the most specific match.
- \`role=<role>[name="..."]\` — match by ARIA role, optionally filtered by
  accessible name (e.g. \`role=button[name="Submit"]\`). Implicit roles are
  honored (\`button\`, \`a[href]\`, \`input\`, etc.).
- \`label=...\` — match by associated \`<label>\` text or \`aria-label\`.
- \`placeholder=...\` — match a form field by its placeholder.
- \`ref=<id>\` — match the element the most recent \`snapshot\` recorded under
  that id (look for \`[ref=eN]\` markers in the snapshot output). The renderer
  holds a per-pane refs cache that \`open\` clears, so \`ref=\` is a shortcut
  for "the element I just read about" without re-deriving a selector.

CSS is still the default — a selector with no prefix is a plain
\`document.querySelector\`. Pick the prefix that matches the page's structure
and the durability you need; a \`text=\` or \`role=\` selector survives markup
changes that would break a positional CSS selector.

## How to use it

1. \`open\` the page you want to inspect.
2. \`snapshot\` to read the rendered result. On a third-party site you do not
   control, prefer \`snapshot --a11y\` so the output lists roles and accessible
   names you can target. The default mode is cheaper for pages you own and
   want to skim quickly.
3. Use the \`[ref=eN]\` markers from the snapshot to drive \`click\` / \`type\`
   without re-deriving a selector (e.g. \`click ref=e3\`). This is the most
   stable loop on a page whose DOM you do not control.
4. \`click\` / \`type\` to interact, then \`snapshot\` again to confirm the
   effect.

## Notes

- Run the commands from your normal shell; the pane is selected automatically
  from your working directory.
- Allowed targets: localhost and project-local files by default, plus web URLs.
- If a command reports that no preview pane is connected, ask the user to open
  the Preview tab for this session, then retry. The bridge waits up to a few
  seconds for a reconnecting pane before erroring, so a transient drop is
  usually safe to ignore — re-running the command is enough.
- \`ref=\` lookups return \`Stale ref\` if the page changed between the snapshot
  and the action. Re-run \`snapshot\` to refresh the refs.
`;
}

const CONTROLLER_SCRIPTS_SKILL_BODY = `---
name: controller-scripts
description: Create and update the Controller coding orchestrator's per-project .coding-orchestrator/setup.sh and .coding-orchestrator/run.sh scripts. Use whenever a project needs to configure how worktrees install dependencies, set up ports or environment variables, and start local development services. Also use when the user asks for setup/run scripts, dev server configuration per worktree, PORT_OFFSET handling, or migrating conductor.json/.superset script configs into native Controller scripts.
---

${managedMarker("controller-scripts")}

# Controller Scripts

This skill is managed by the Controller app (directory name
\`controller-scripts\`). It is surfaced in the \`/\` picker with the
\`controller\` tag alongside Controller's other built-in skills. Users invoke
it like any other skill: type \`/controller-scripts <task>\` or pick it from
the autocomplete.

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

function buildWorktreesSkillBody(cliPath: string): string {
  return `---
name: controller-worktrees
description: Worktree the current conversation and start an agent turn on the new worktree from the CLI, without going through the in-app picker. Use when the user asks to create a worktree, work on an issue in a fresh worktree, or kick off a turn on an existing worktree.
---

${managedMarker("controller-worktrees")}

# Worktrees

This skill is managed by the Controller app (directory name
\`controller-worktrees\`). It is surfaced in the \`/\` picker with the
\`controller\` tag alongside Controller's other built-in skills. Users invoke
it like any other skill: type \`/controller-worktrees <task>\` or pick it from
the autocomplete.

You can worktree the current conversation and start a turn on the new
worktree from the shell, without going through the in-app picker. Use it when
the user says "let's create a worktree and start working on issue X", or when
you want to scope a long task to an isolated branch without leaving the CLI.

Invoke the Controller CLI by its absolute path — it is not on your PATH.
Every command below is run as either \`${cliPath} worktrees <command>\` or
\`${cliPath} sessions <command>\`.

## Commands

- \`${cliPath} worktrees list <project>\` — list the worktrees on a project.
- \`${cliPath} worktrees create <project> --name <name> [--branch <branch>] [--base <baseBranch>]\` — create a new worktree. Streams the setup-script output as it runs; the new worktree's id is printed on success.
- \`${cliPath} worktrees delete <project> <worktreeId>\` — delete a worktree. The worktree must not have an active session.
- \`${cliPath} sessions start <project> --worktree <worktreeId> --message <text> [--provider codex|claude|anita] [--model <model>] [--mode default|plan] [--skill <name>]\` — kick off a new agent turn on a worktree and print the session URL.

## Picking a project

\`<project>\` accepts either the project's UUID or its human name. To find the
human name that matches the current working directory, read the orchestrator's
project list. The file lives next to the CLI at \`<controller-install>/projects.json\`,
so the path is derived from the CLI itself and follows the install if it
ever moves:

\`\`\`sh
PROJECTS_JSON="\$(dirname "\$(dirname '${cliPath}')")/projects.json"
jq -r --arg pwd "\$(pwd)" '.[] | select(.path == \$pwd) | .name' "\$PROJECTS_JSON"
\`\`\`

Match the entry whose \`path\` field equals the repo root (\`pwd\`), then pass
that name directly to the CLI — no UUID lookup needed.

## Workflow

End-to-end example for "worktree this conversation and start a turn on issue 42":

\`\`\`sh
# 1. Create the worktree (project name taken from the step above)
${cliPath} worktrees create "Coding Orchestrator" --name issue-42
# → Created worktree issue-42 (id=f1247ed6-3a1b-4c9d-b8e2-9f0a1c2d3e4f)

# 2. Start a session on the new worktree
${cliPath} sessions start "Coding Orchestrator" \\
  --worktree f1247ed6-3a1b-4c9d-b8e2-9f0a1c2d3e4f \\
  --provider claude \\
  --skill github-issues \\
  --message "Work on GitHub issue #42 in the germanescobar/controller repo"
# → Started session abc123 — controller://sessions/abc123
\`\`\`

Key ordering rules shown above:
- \`<project>\` is **positional** and comes immediately after the subcommand.
- All flags (\`--provider\`, \`--skill\`, etc.) come **before** \`--message\`.
- \`--message\` is always **last**; everything after it is treated as prompt text.

The second command prints \`Started session <id>\` and a \`controller://...\`
URL — open that URL in the Controller app to see the live transcript.

## Flags to remember

- \`--message\` must be **last** on the command line. Everything after it is
  the prompt text, verbatim. Putting another flag after \`--message\` will
  fail the parse with a clear error rather than silently corrupting the
  prompt.
- \`--provider\` accepts \`codex\`, \`claude\`, or \`anita\`. The session URL
  works regardless of provider; the transcript is rendered by the existing
  in-app event stream, so no client-side streaming changes are involved.
- \`--base <baseBranch>\` lets you branch off a non-default base (e.g.
  \`--base main\` or \`--base origin/main\`). The CLI resolves it against
  the project's remote when possible.

## Notes

- \`worktrees create\` runs the project's \`.coding-orchestrator/setup.sh\`
  inside the new worktree before printing the id. The setup script must
  finish before the worktree is usable; the CLI streams its output so a
  failure surfaces immediately.
- \`sessions start\` returns as soon as the agent reports its first
  \`run.started\` event. The session continues running independently; you do
  not need to keep the CLI open.
- The unified CLI is invoked by its absolute path. The bare \`controller\`
  command may not resolve on PATH inside your shell — copy the full path
  verbatim from this skill body.
- \`<worktreeId>\` is the UUID printed by \`worktrees create\` (e.g.
  \`f1247ed6-...\`), **not** the worktree directory path or branch name.

### Recovering from a failed \`sessions start\`

If \`sessions start\` returns \`Agent exited before reporting a sessionId\`, the
agent process died before the orchestrator could capture its session id. This
is provider-dependent and not a worktree problem. Recovery steps:

1. Retry the exact same \`sessions start\` command with \`--provider claude\` (or
   \`--provider anita\`) added explicitly. The default provider may be
   unavailable or broken in the current environment.
2. If the retry also fails, check whether the provider's CLI is installed and
   authenticated (e.g. \`claude --version\`).
3. The worktree itself is intact — you don't need to recreate it. Use the
   same \`<worktreeId>\` from the original \`worktrees create\` output.
`;
}

function buildSearchSkillsBody(cliPath: string): string {
  return `---
name: controller-search-skills
description: Search and activate unified skills from the Controller catalog. Use when the user asks for a capability that might already be configured as a unified skill, or when you want to reuse an existing skill for the current turn.
---

${managedMarker("controller-search-skills")}

# Search Skills

This skill is managed by the Controller app (directory name
\`controller-search-skills\`). It is surfaced in the \`/\` picker with the
\`controller\` tag alongside Controller's other built-in skills. Users invoke
it like any other skill: type \`/controller-search-skills <query>\` or pick it
from the autocomplete.

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
  with \`<provider>/<scope>\` and the project path for repo skills). App-owned
  skills (e.g. \`controller-browser\`) are hidden — they are already available
  to every agent via the disk provider and would only collide with themselves
  if imported.
- \`${cliPath} skills import --provider <id> --source <path> [--scope <scope>] [--overwrite]\`
  — copy a single per-agent skill into the unified catalog. Use
  \`${cliPath} skills import --all\` to import every entry from
  \`import-discover\` in one go. Imports of managed directories are refused
  with an error so a stale discovery result can't promote an app-owned skill
  into the catalog.

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
  the Controller home (e.g. \`~/Library/Application Support/Controller/skills/\`
  on macOS; the exact path is platform-dependent — see "State location" in
  the README). The original per-agent file is left in place; the unified
  copy takes precedence by name.
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

${managedMarker("controller-skill-creator")}

# Skill Creator

This skill is managed by the Controller app (directory name
\`controller-skill-creator\`). It is surfaced in the \`/\` picker with the
\`controller\` tag alongside Controller's other built-in skills. Users invoke
it like any other skill: type \`/controller-skill-creator <task>\` or pick it
from the autocomplete.

You help the user create a new unified skill in Controller's app-owned
catalog at the Controller home's \`skills/<name>/SKILL.md\` (e.g.
\`~/Library/Application Support/Controller/skills/<name>/SKILL.md\` on
macOS; the exact path is platform-dependent). Skills created here are
available to every agent immediately and surface in the \`/\` picker.

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
- The CLI writes to the Controller home's \`skills/<name>/SKILL.md\` (e.g.
  \`~/Library/Application Support/Controller/skills/<name>/SKILL.md\` on
  macOS). Do not try to write the file directly — let the CLI perform
  validation.
- Skill activation (\`/name\`) prepends the body to the user's next
  message, so the body should read as instructions *to the agent*, not
  prose for the user.
`;
}

/**
 * Write the managed skills into the unified skill catalog under the
 * Controller home (e.g. `~/Library/Application Support/Controller/skills/<name>/SKILL.md`
 * on macOS). Idempotent: rewrites every directory in `MANAGED_SKILL_DIRS`
 * (we own them) and skips any other directory the user might have dropped
 * into the same parent (we don't own those).
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
    { name: "controller-worktrees", body: buildWorktreesSkillBody(cli) },
  ];

  for (const skill of skills) {
    if (!isManagedSkillName(skill.name)) {
      // Defensive: every entry in `skills` should be in
      // `MANAGED_SKILL_DIRS`. Bail rather than risk clobbering an
      // unrelated user-authored file that happens to share a name.
      continue;
    }

    const skillDir = unifiedSkillDir(skill.name);
    const skillFile = path.join(skillDir, "SKILL.md");
    let existing: string | null = null;
    try {
      existing = await fs.readFile(skillFile, "utf-8");
    } catch {
      existing = null;
    }
    if (existing === skill.body) continue;

    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillFile, skill.body, "utf-8");
  }

  // One-time migration: older Controller installs mirrored the managed
  // skills into each provider's user skills home. After this change they
  // live in the unified catalog, so the per-agent copies are stale and
  // would just confuse each agent's native `/<name>` picker. Remove them.
  await removeLegacyPerAgentManagedSkills();
}

/**
 * Best-effort cleanup of stale `controller-*` skills in each provider's
 * user skills home. Older Controller releases mirrored the managed skills
 * into `~/.claude/skills/`, `~/.codex/skills/`, and `~/.anita/skills/`. The
 * current design keeps them in the unified catalog, so those per-agent
 * copies are obsolete. We delete any directory whose name is in
 * `MANAGED_SKILL_DIRS`; user-authored directories are never touched.
 *
 * Errors are swallowed — cleanup must never block startup.
 */
async function removeLegacyPerAgentManagedSkills(): Promise<void> {
  const homes: string[] = [
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".codex", "skills"),
    path.join(os.homedir(), ".anita", "skills"),
  ];
  for (const home of homes) {
    for (const name of MANAGED_SKILL_DIRS) {
      const dir = path.join(home, name);
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    }
  }
}

/** @deprecated Use {@link installManagedSkills} instead. */
export async function installBrowserSkills(): Promise<void> {
  return installManagedSkills();
}
