# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Fixed

- **Anita multi-turn transcripts now render in full** (#163). The orchestrator
  was skipping its own transcript persistence for Anita and relying on the
  `anita` CLI to write events into `.coding-agent/events/`. After the Ada→Anita
  rename the CLI's data dir moved to `.anita/`, so the orchestrator read back
  only its own `user_message`/`run_diff` events and the assistant text and tool
  calls never reached the UI on follow-up turns. The orchestrator now persists
  every provider's parsed transcript events itself — the same path already used
  for Codex and Claude — so Anita is no longer coupled to the CLI's on-disk
  storage location.

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
