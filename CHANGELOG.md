# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Changed

- **Move orchestrator state out of `$HOME` and reduce macOS TCC prompts** (#223).
  The orchestrator's home directory now lives in the platform-appropriate
  location:
  - **macOS:** `~/Library/Application Support/Controller/`
  - **Linux:** `$XDG_STATE_HOME/Controller/` (falls back to `~/.local/state/Controller/`)
  - **Other:** legacy `~/coding-orchestrator/` until a follow-up adds a native convention

  A one-shot migration runs on first launch after the upgrade, moving any
  existing `~/coding-orchestrator/` directory into the new home in a
  single atomic `fs.rename` and writing a `migrated-from-legacy-home.json`
  marker so it never re-runs. The migration is silent on the client; the
  server logs the move once.

  New env-var contract: `CONTROLLER_HOME` is the canonical override
  (documented in the README). `CODING_ORCHESTRATOR_HOME` is kept as a
  deprecated alias; using it logs a one-line warning. The CLI now also
  receives `CONTROLLER_HOME` in the env injected for spawned agents, and
  its `controller-runtime.json` lookup checks the platform-default home
  before the legacy path. Net effect: `~/coding-orchestrator/` is no
  longer created or read on macOS, and the new home is exempt from TCC
  prompts because it lives under `Application Support`.

### Added

- **App shell auto-refresh on out-of-band changes** (#210). The app
  shell now subscribes to a project-scoped SSE stream at
  `GET /api/projects/:projectId/events` and the sidebar refreshes
  itself (with a 50ms debounce) when a worktree is added/removed,
  a session is added/removed, the focus queue changes, or a setup
  script finishes. Worktrees or sessions created via the
  `controller` CLI from another terminal (including by an agent in
  another session), by a second app window, or by a backgrounded
  headless run all show up in the running app without a manual
  refresh. Project-level events (`project_added/updated/removed`)
  are broadcast on every project's stream so the sidebar's project
  list refreshes when a *different* project is created, renamed,
  or removed out of band. The bus is an in-process `EventEmitter`
  (`server/lib/events.ts`), wired into the worktree create/delete/
  setup handlers, the session start/archive/focus handlers, and the
  project add/update/delete handlers. The existing per-session
  `EventSource` in `SessionView.tsx` is unchanged — the new stream
  is additive.

- **Browser CLI: locator-style selectors + accessibility snapshot** (#170).
  The `controller browser click`/`type` commands now accept a
  `selector=` prefix in addition to plain CSS: `text=...`,
  `role=<role>[name="..."]`, `label=...`, `placeholder=...`, and
  `ref=<id>`. The renderer resolves each prefix inside the guest page, so
  `click text=Cancel` works on any page that renders the literal text and
  `click role=button[name="Submit"]` matches buttons by accessible name.
  `ref=<id>` resolves to the CSS selector the most recent `snapshot`
  recorded under that id. `snapshot --a11y` emits a structured
  accessibility tree (role + accessible name + `[ref=eN]`) instead of
  the default visible-text view, so an agent can target an element on
  any page without hand-built CSS. Both snapshot modes emit refs; the
  default mode keeps the existing text + interactive-element listing
  with `[ref=eN]` appended, so backward compatibility is preserved.
  When the preview pane drops mid-session, the bridge now waits up to
  3s for the renderer to reconnect before rejecting, so a transient
  pane detach no longer aborts an in-flight agent command.

- **Worktree + session-start CLI surfaces** (#190). Two new top-level
  surfaces on the unified `controller` CLI let an agent manage its own
  worktrees and kick off new sessions without going through the in-app
  worktree picker:

  - `controller worktrees list <project>` wraps
    `GET /api/projects/:projectId/worktrees`.
  - `controller worktrees create <project> --name <name> [--branch <branch>] [--base <baseBranch>]`
    subscribes to the existing
    `POST /api/projects/:projectId/worktrees` SSE stream and prints the
    log output plus the new worktree's id and path; non-zero exit on
    a failed `git worktree add` or setup script.
  - `controller worktrees delete <project> <worktreeId>` wraps
    `DELETE /api/projects/:projectId/worktrees/:worktreeId`.
  - `controller sessions start <project> --worktree <worktreeId> --message <text>`
    (with optional `--provider`, `--model`, `--mode`, `--skill`) calls
    the new `POST /api/projects/:projectId/sessions` endpoint and prints
    `{ sessionId, url }` once the agent's first `run.started` event
    lands, so the caller can hand the sessionId to a human to follow
    along in the UI.

  `<project>` accepts either the project's id (UUID) or its human name;
  the CLI resolves names against `GET /api/projects` so the agent
  doesn't need to know the project's id to invoke the command. The new
  endpoint is a headless companion to the existing
  `GET /api/projects/:projectId/sessions/stream` SSE handler: it runs
  the same validation, skill-resolution, and persistence pipeline
  (session file + `user_message` event written before the agent spawns),
  and the UI subscribes to the existing
  `GET /api/projects/:projectId/sessions/:sessionId/events` endpoint to
  render the transcript live. The agent preamble now includes a
  project-management block that surfaces every new subcommand with the
  absolute CLI install path so the agent can copy/paste them verbatim.

### Fixed

- **`controller integrations …` no longer crashes with
  `ReferenceError: runIntegrations is not defined`** (#178). The unified
  CLI's dispatcher called a `runIntegrations` helper that was never
  defined, so every `list` / `search` / `tools` / `describe` / `call` /
  `request` / `status` subcommand threw before reaching the server. The
  dispatcher is now wired up to `parseIntegrations` and `printIntegrations`,
  mirroring the `browser` and `skills` surfaces, and POSTs to the
  `/api/integrations/gateway/<endpoint>` routes the server already
  exposes (caught in review — the gateway endpoints live under
  `/gateway/*`, not at the router root). Server-side errors are surfaced
  as a non-zero exit with the message from `result.error`, consistent
  with the other surfaces. A new smoke-test file
  (`cli/__tests__/controller-cli.test.mjs`) imports the CLI module,
  stubs `fetch`, and asserts the regression class is caught early.

### Changed

- **New worktrees now base off `origin/<branch>` by default** (#172).
  Creating a worktree from the orchestrator runs `git fetch origin <branch>`
  first and uses the freshly fetched remote tracking ref as the base, so a
  new worktree starts from the up-to-date remote tip even when the local
  branch is behind. If `origin/<branch>` does not exist after the fetch
  (or the fetch itself fails — offline, no `origin` configured, etc.) the
  handler falls back to the local ref, and ultimately to local HEAD, while
  emitting SSE `log` events explaining the fallback. The fetch and any
  fallback log lines stream through the existing `/worktrees` SSE
  channel. This is a behavior change for existing projects: worktrees
  created without an explicit `baseBranch` will now do a `git fetch` and
  base off `origin/<defaultBranch>` rather than the local HEAD.

- **Renamed controller-managed skills to a `controller-` prefix and hid them
  from the `/` picker** (#159). The five app-managed skills installed into
  each provider's user home on startup
  (`browser` → `controller-browser`,
  `integrations` → `controller-integrations`,
  `controller-scripts` (grandfathered — no double prefix),
  `search-skills` → `controller-search-skills`,
  `skill-creator` → `controller-skill-creator`) now live under
  `controller-`-prefixed directories, with matching `name:` frontmatter and
  `MANAGED_MARKER` (now references issue #159 so future renames can detect
  unowned files). The disk provider tags any `SKILL.md` carrying the
  marker with `scope: "managed"`, and the chat composer filters
  `scope: "managed"` entries out of the `/` autocomplete popover so users
  no longer see agent-facing skills mixed in with their own. The agent
  still discovers the body through the filesystem location, so a user who
  types `/controller-browser` manually and submits still gets the body
  prepended. Existing per-agent and unified skills are unaffected. **Note:**
  after upgrading, manually remove the old `~/.{anita,codex,claude}/skills/`
  directories named `browser`, `integrations`, `search-skills`, or
  `skill-creator` (or simply `rm -rf ~/.anita/skills/browser` etc.); they
  carry the previous marker comment and would otherwise be re-read as
  regular user-authored skills.

- **Switched managed-skill ownership detection from a versioned marker
  comment to the directory name** (#159 follow-up). The previous marker
  comment embedded an issue number (`issue #159`); bumping that number
  silently re-classified every leftover app-owned directory as
  user-authored, so `controller-scripts` (the grandfathered name from
  #173) reappeared in the `/` picker on machines upgraded across the
  rename. Ownership is now decided by a single source of truth —
  `MANAGED_SKILL_DIRS` in `server/lib/managed-skills.ts` — checked by
  the install loop, the disk provider's `scope: "managed"` detection,
  and the per-agent skill discovery used by the
  `controller skills import-discover` command (managed skills are now
  filtered out so they don't appear as import candidates). The marker
  comment is still embedded in each shipped body for documentation, but
  it now includes the directory name (e.g.
  `<!-- managed-by: coding-orchestrator (controller-scripts) -->`)
  and is not authoritative: a directory in `MANAGED_SKILL_DIRS` is
  always app-owned regardless of marker content, and the install loop
  will rewrite it on next server start. The import endpoint also
  refuses a `sourcePath` that points at a managed directory, so a
  cached or hand-rolled request can't promote an app-owned skill into
  the unified catalog. Users with leftover app-owned directories from
  before this change need no manual cleanup; the next server restart
  re-syncs them. The previous note about manually removing
  `~/.{anita,codex,claude}/skills/{browser, integrations, search-skills,
  skill-creator}` is no longer required for this purpose (it was a
  one-time follow-up to #173's rename).



### Changed

- **Updated session-file ownership comments to reflect post-#152 / #163
  reality** (#165). The Ada→Anita rename moved the `anita` CLI's session
  store to `.anita/sessions/`, so for new sessions the
  `.coding-agent/sessions/<id>.json` file is now Controller-owned only.
  The focus-field stripping in `saveSession` is still useful — legacy
  resumed sessions can still be co-written by the agent via the
  `.coding-agent/sessions/` fallback, and any future provider that
  re-introduces an on-disk writer would silently drop unknown top-level
  fields — but the comments at `server/lib/sessions.ts`, `focus-state.ts`,
  `paths.ts`, `routes/sessions.ts`, and the matching regression tests
  previously described the file as "agent-owned" and justified the
  stripping as "Anita's writer would erase our fields." That rationale
  is no longer the whole story; the comments now describe the real
  invariant (the on-disk file keeps a shape any provider can round-trip,
  and focus state lives in the Controller-owned sidecar).

### Fixed

- **Anita multi-turn transcripts now render in full** (#163). The orchestrator
  was skipping its own transcript persistence for Anita and relying on the
  `anita` CLI to write events into `.coding-agent/events/`. After the Ada→Anita
  rename the CLI's data dir moved to `.anita/`, so the orchestrator read back
  only its own `user_message`/`run_diff` events and the assistant text and tool
  calls never reached the UI on follow-up turns. The orchestrator now persists
  every provider's parsed transcript events itself — the same path already used
  for Codex and Claude — so Anita is no longer coupled to the CLI's on-disk
  storage location. Transcript writes are now serialized through the stream's
  processing chain so the persisted `.coding-agent/events/` JSONL always records
  events in stream order; previously fire-and-forget appends could let the OS
  reorder them and a reloaded transcript could show an assistant response ahead
  of the user turn that prompted it.

### Changed

- **Renamed the default agent from "Ada" to "Anita"** (#151) to match the
  `anita` CLI. This touches the agent display name, the spawned CLI command,
  user-facing labels, prompts, logs, and docs. The canonical provider id is now
  `anita`.

  **Backward compatibility:** the legacy `ada` provider id is still accepted on
  read. Existing sessions that persisted `provider: "ada"` (or omitted it),
  agent settings saved under the `ada` key, and API requests using
  `?provider=ada` continue to work — they resolve to `anita` automatically, so
  no migration is required. Skills are read from the canonical
  `~/.anita/skills` / `.anita/skills` locations, falling back to the legacy
  `~/.ada/skills` / `.ada/skills` locations when the new ones don't exist yet.
