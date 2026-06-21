# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Changed

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
