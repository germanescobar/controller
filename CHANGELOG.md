# Changelog

All notable changes to this project are documented here.

## [0.1.0] - 2026-06-25

The first public release of **Controller** (formerly Coding Orchestrator).
This is an early preview — expect rough edges.

> **Note (revised 2026-06-25):** the original `Controller-0.1.0-mac.zip`
> and `Controller-0.1.0-arm64.dmg` were replaced on the same release
> page with re-signed artifacts. The fix is the new
> `electron/resign-mac.mjs` post-build step, which `codesign --force
> --deep --sign -` the bundle after `electron-builder` finishes,
> producing a properly-formed ad-hoc signature.
>
> **Important caveat about Gatekeeper on modern macOS:** the macOS
> app is ad-hoc-signed and not notarized. On first launch, macOS may
> show "Controller" Not Opened with an "Apple could not verify..."
> warning. Open **System Settings → Privacy & Security**, scroll to
> **Security**, and click **Open Anyway** for Controller. After this
> first approval, Controller opens normally.

### Highlights

- **Multi-provider support** for the Anita, Codex, and Claude coding agent
  CLIs, with per-session model selection and provider-aware defaults.
- **Project & session management** with a sidebar UI, persistent on-disk
  transcripts (JSON/JSONL), archive/unarchive, and inline file diffs.
- **Real-time streaming** of agent output (text, reasoning, tool calls,
  tool results) over SSE.
- **Persistent embedded terminals** backed by `tmux` sessions that survive
  browser refreshes and backend restarts.
- **Slash-command skills** managed by the orchestrator, with a unified
  catalog sourced from each agent's skill home.
- **Worktrees & on-radar focus queue** (Controller Mode) for steering
  multiple parallel sessions from one window.
- **Desktop shell** that ships the same UI and backend as the browser app,
  including a first-run welcome screen for picking the local backend port.
- **App shell auto-refresh** on out-of-band worktree/session changes
  (CLI, second window, headless run).
- **macOS TCC hygiene**: state moved to
  `~/Library/Application Support/Controller/`, which is exempt from
  Files-and-Folders prompts (see the *State location* section of the
  README for the migration step from pre-223 installs).

### Downloads

- **macOS** — `Controller-0.1.0-arm64-mac.zip` and
  `Controller-0.1.0-arm64.dmg` (Apple Silicon). For Intel Macs, build
  from source (`npm run package:electron:dist`) or wait for v0.1.1,
  which will add an x64 build via CI.
- **Linux** — `Controller-0.1.0-arm64.AppImage` (aarch64). An x86_64
  AppImage is also targeted for v0.1.1.

The macOS build is **unsigned and unnotarized** for this release; a
follow-up will add Developer ID signing and notarization. Linux ships as
an AppImage — make it executable (`chmod +x Controller-0.1.0.AppImage`)
and run it; no install required.

### Known gaps

- **No Developer ID signing.** The macOS build is ad-hoc-signed and
  not notarized. On first launch, macOS may block it with an "Apple
  could not verify..." warning. Workaround: open **System Settings →
  Privacy & Security**, scroll to **Security**, and click **Open
  Anyway** for Controller. After this first approval, Controller opens
  normally.
- No auto-update channel.
- No Windows build (state-location path falls back to the legacy
  `~/coding-orchestrator/` directory on Windows; a native
  `%LOCALAPPDATA%` path is tracked as follow-up work).
- The `node-pty` prebuilds are pinned to the Electron version declared
  in `package.json` (`^42.3.0`); if you run against a different
  Electron you'll need to rebuild locally.

## [Unreleased]

- **Codex picker: GPT-6 family replaces GPT-5.6**. The fallback list in `server/lib/models.ts` now lists `gpt-6-astra` (flagship), `gpt-6-sol` (new default for new Code sessions, taking the slot the GPT-5.6 lineup reserved for Sol), and `gpt-6-luna` (fast / cost-efficient). The three GPT-5.6 entries — `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` — are removed; OpenAI did not release a GPT-6 tier in the "Terra / everyday work" slot, so the picker shrinks from four to three entries instead of carrying a dead tier. Names mirror the [OpenAI GPT-6 announcement](https://openai.com/index/gpt-6/), cross-checked against the live catalog on OpenRouter (canonical slugs `openai/gpt-6-astra-20260922`, `openai/gpt-6-sol-20260922`, `openai/gpt-6-luna-20260922`, all created the same day). As before, the fallback list is only consulted when `codexAppServerManager.listModels()` is unreachable — when Codex CLI is reachable, its live model list wins and any new tiers OpenAI ships beyond these three appear without a code change.
- **Branching a conversation no longer runs an agent (#382)**. Clicking the branch icon used to POST to a route that spawned a provider turn immediately — the new session opened with an empty agent reply already in it ("it sent a message"). That design existed only to give the new session id real provider backing: the session file's `id` *was* the provider's thread id, so a Controller-chosen UUID had nothing for `--resume` / `thread/resume` to target on the user's first real turn (PR review P1 from chatgpt-codex-connector on #381). `POST /api/projects/:projectId/sessions/branch` is rebuilt around a new `providerThreadId` field on the session file, which decouples the two ids: the route now answers synchronously with a Controller-chosen UUID, copies the source's events onto the new session, writes `unstarted: true`, and spawns nothing. Provider / model / mode are deliberately left unset so every composer picker is unlocked — choosing a different agent is the point of branching. The first turn the user types starts a *fresh* provider thread (no `--resume`) with the source transcript inlined into the prompt, and the provider's own thread id is captured as `providerThreadId`; every later turn resumes that id while the events file, the URL and the sidebar keep keying off the Controller UUID. Agent events are re-stamped with the Controller id before they reach the client so the chat view can't be swapped onto an id that has no events file. Removed along with the old design: the agent-spawning branch path, its `seedFromSessionId` / `seedTitle` stream plumbing and `seedBranchFromSource` helper, the `controller sessions branch` CLI verb, and the verb's entry in the agent preamble. Branching is web-only now. Branching is per-response, not per-conversation: the icon sits at the end of every assistant turn, and `upToEventId` cuts the copied transcript there, so branching from the third of ten responses yields a session containing three. A branch does not become a child of its source: `parentId` marks a coordinator-spawned child (#351 / #353) and drives `sessions children` plus the sidebar subtree, but a fork of a conversation is not work delegated by it, so branches stand on their own. The branch writes a `branch_marker` event the chat view renders as a "Branched from <source>" divider with a click-through link, not as a `user_message` — the user never typed it, so a chat bubble from them would be a lie, and the prompt builder would otherwise feed it to the agent as a turn. A branched session has exactly one transcript — its events file. The first-turn prompt is projected from those events at read time rather than from a mirrored copy on the session file, so a cut branch can't hand the agent turns the user cut off. (`session.messages` stays `[]`: it is a provider-owned field Anita writes on some paths, and Controller only ever passes it through.) The wire shape is `{ sourceSessionId, upToEventId?, worktreeId?, title? }` and the response is `{ sessionId, url }`.
- **New managed skill: `controller-sessions` (#368)**. Session *discovery* had no skill-layer home — `controller-worktrees` covers create-then-start, and the verb list in the agent preamble's `sessionsListIntro` is a reference, not a recipe. The new skill installs at `<controller-home>/skills/controller-sessions/SKILL.md` alongside the other managed skills (registration in the `<additional_skills>` block is automatic via `listUnifiedSkills`) and documents `sessions list` / `children` / `send` / `wake` / `goal set|show|clear` / `monitor start|list|stop` with worked examples, including the `--on-line` re-injection filter. It also writes down the four failure modes that cost real agents turns: resolve a bare UUID by running `worktrees list <project>` *before* `sessions list --worktree <id>`; `<project>` accepts a human name, not just a UUID; a bare `sessions list` is scoped to the project owning `pwd`, so another project needs an explicit `<project>`; and transcripts live at `${CONTROLLER_HOME}/projects/<basename>-<sha16>/events/<sessionId>.jsonl` (metadata under `sessions/`), where `<basename>` is the worktree's on-disk directory name, **not** its id. Per Codex review on #373, the body documents which verbs actually accept `self` (`start --parent` / `list --parent` / `send` / `children` / `branch`) versus the three that need an explicit session id (`wake` / `goal` / `monitor`, tracked in #375), and names the persisted parent field `parentId` — `parentSessionId` does not exist on disk.
- **Fix: managed-skill shell snippets double-quoted the CLI path**. `controllerCliShellPath()` already returns the install path wrapped in single quotes, but the `PROJECTS_JSON="$(dirname "$(dirname '<cli>')")"` snippets in `controller-worktrees` and `controller-memory` wrapped it again. The rendered `''/Users/…/Application Support/Controller/bin/controller''` collapses to an unquoted path and the shell splits it at the space, so the copy-paste recipe failed on every default macOS install. The snippets now interpolate the bare `cliPath`, and a new test asserts no managed body re-quotes it.

- **CLI: positional message argument for `sessions start` / `sessions wake` (#355)**. The `--message <text>` flag is gone — the message is now the second positional (after the optional `<project>` on `start`, or after the `<sessionId>` on `wake`). Flags come before or after the message in any order, and prompts that contain flag-like tokens (`"explain the --json flag"`) no longer need escaping. The previous "last-flag guard" plus the hand-curated `RESERVED_FLAGS` / `WAKE_RESERVED` arrays are removed; the parser walks argv once and the message is whichever bare token isn't a flag value. The `start` outer parser disambiguates `<project>` from `<message>` by counting the leading bare tokens (issue #355 PR review, P1): two leading bare tokens means the first is the project and the second is the message; one leading bare token is the message itself and the project falls back to cwd. Missing message errors read `"Missing message: the last positional argument is the prompt to send the agent"`. Prompts whose first characters look flag-like (`"--help me"`) can pass `--` to opt into the end-of-flags shape and have the rest of argv treated verbatim — the same convention `git`, `kubectl`, and `gh` use (issue #355 PR review, P2). The `--flag=value` shorthand is still rejected on the sessions surfaces (only space-separated `--flag value` is accepted), closing the dual-syntax ambiguity class. The agent preamble's worked examples and the `controller-worktrees` managed skill were updated to teach the new shape.

## [0.3.5] - 2026-08-19

### Fixed

- **Agent browser: `--insecure` cert bypass now works on subsequent navigations** (#323 follow-up). The Electron `setCertificateVerifyProc` proc is only honored if it's installed on the `controller-preview` session before any webview has navigated through it; once a webview has used the session, swapping the proc is a silent no-op and Chromium keeps using the default verifier. The old `controller:set-preview-cert-policy` IPC handler called `setCertificateVerifyProc` on every `--insecure` open, so the *first* `https://localhost:*` / `https://127.0.0.1:*` navigation after a fresh app start would bypass the cert, but a *subsequent* navigation (e.g. `https://localhost:5050/` after `https://127.0.0.1:5050/`) still hit `NET::ERR_CERT_AUTHORITY_INVALID` because the new proc was never installed. The fix installs the cert-verify proc exactly once — eagerly, in `attachPreviewPartitionGuards` at app startup, before any webview exists — and reads a module-level `previewCertBypassEnabled` flag inside the closure. The IPC handler is now a one-line flag flip, so the bypass is reliably in effect for every navigation (including the first one) and the previous "127.0.0.1 works, localhost doesn't" asymmetry is gone. The flag is off by default and reset between non-`--insecure` opens, so the bypass remains per-call and loopback-scoped.

- **Composer: paste images from the clipboard** (#314, #334). Cmd/Ctrl+V of a screenshot is now treated identically to a drop or file-picker selection. The new `onPaste` handler on the composer drop zone delegates to the existing `addComposerFiles`, which already enforces the file count, per-file and total size limits, the supported MIME types, and surfaces unsupported-type and over-limit errors via the existing `attachmentError` slot. Text-only pastes return an empty file list from the helper and fall through to the default browser behavior, so pasting prose still inserts into the textarea; mixed text + file pastes prefer the file, which matches the standard expectation when a screenshot tool places a text fallback on the clipboard. The `canAttachMore` gating matches the existing drop / file-picker paths, so paste is a no-op when the active provider/model doesn't support attachments. The wrapper also refocuses the textarea on click of its (otherwise non-focusable) padding so a Cmd/Ctrl+V that lands after the user clicked the drop zone's chrome actually reaches the handler — paste events fire on the focused element, not the element under the cursor. The clipboard-to-`File` conversion lives in `client/src/lib/clipboard-files.ts` as a pure helper so it can be unit-tested without a React renderer (eight tests cover image, multi-image, text-only, mixed, null/undefined clipboard, empty clipboard, `getAsFile()` returning null, and a `DataTransfer.files`-only fallback path).

- **Codex: handle steer requests during turn finalization** (#331). A "steer" — a user message sent while the provider is still streaming the prior turn — races with the in-flight finalization on the Codex adapter, and the previous code could double-emit the final response or drop the steered message. The adapter now serializes a steer against the finalization step so the new user message is delivered as one normal turn and the prior turn closes cleanly through the same `finalize` path. No new IPC, no provider-facing API change.

## [0.3.4] - 2026-08-03

### Added

- **Agent browser: `--insecure` flag on `controller browser open`** (#323). The agent can now opt into bypassing TLS-cert validation for the duration of a single navigation, scoped to localhost-shaped hosts (`localhost`, `127.0.0.1`, `[::1]`). Useful when a local dev server serves `https` with a self-signed certificate (mkcert not used, ad-hoc OpenSSL cert, embedded TLS terminator). The flag is rejected on external URLs by the server-side policy, so an agent cannot use it to talk to an arbitrary external host without cert validation. Implementation: new `controller:set-preview-cert-policy` IPC handler that calls `setCertificateVerifyProc` on the `controller-preview` Electron session. Addressed review feedback from PR #324: non-loopback requests now return `-3` (Electron's "use Chromium's default verification result" sentinel) instead of `-2`, so a legitimate HTTPS subresource loaded by an insecure-localhost page — a CDN script, font, or external API — is still checked and accepted.

## [0.3.3] - 2026-07-27

### Added

- **Codex: GPT-5.6 model family (Sol, Terra, Luna)** (#311). The Codex model picker now lists `gpt-5.6-sol` (new flagship, default for new Code sessions), `gpt-5.6-terra` (balanced), and `gpt-5.6-luna` (cost-efficient), alongside the existing 5.5 / 5.4 / 5.4-mini / 5.3 Codex Spark entries. Mirrors the [OpenAI GPT-5.6 announcement](https://openai.com/index/gpt-5-6/): Sol is the new flagship, Terra is positioned for everyday work, Luna is the fastest and most affordable tier. The fallback list in `server/lib/models.ts` is only used when the live `codexAppServerManager.listModels()` call is unavailable — when Codex CLI is reachable, the live list wins.
- **Files panel: toggle with `Cmd+B` and `Cmd+P` fuzzy file finder** (#313, #319). Two new shortcut actions are wired to the right-side Files panel: `filesPanelToggle` (default `Cmd+B`) opens the right panel on the files tab / closes it when it's already showing the file explorer — the same convention used by VS Code, Cursor, and Sublime — and `filesPanelSearch` (default `Cmd+P`) opens a fuzzy file finder overlay scoped to the active worktree. The picker reuses the existing fuzzy-search machinery with a worktree-rooted path resolver, surfaces matches ranked by recency and filename quality, and renders file previews on focus.
- **Composer: `@`-mention files to include them in the prompt context** (#312, #315). An `@`-triggered fuzzy file/directory picker in the chat composer mirrors the existing `/`-skill picker UX. Typing `@` opens a popover scoped to the active worktree, and selecting an entry adds a non-editable chip above the textarea. Mention chips render in the outgoing user message bubble on reload, and the resolved paths ride through to the backend on a new `mentions` query param so the agent sees the attached paths alongside the prompt text.

### Fixed

- **Terminal: pagers page inside Controller instead of launching an external `less`** (#317, fixes #317). `tmux` was keeping the pane locked to the attaching client's 80×24 size, so `git log`, `man`, and other pagers refused to open an interactive view and either launched an external `less` or scrolled the pane off-screen. tmux's `window-size` is now `latest` so the pane tracks the latest client-reported size, an explicit `-x/-y` to `new-session` starts the pane at a reasonable 200×50 instead of the attacher's 80×24, `LINES`/`COLUMNS` are stripped from the shell env so pagers fall back to `ioctl(TIOCGWINSZ)`, and a belt-and-suspenders `resize-window` runs on every client resize.
- **`useFileIndex`: stabilize `useSyncExternalStore` callbacks** (#320). The `subscribe` and `getSnapshot` closures passed to `useSyncExternalStore` were new arrow functions on every render, which made React re-run the subscribe effect on each re-render of `FileFinderDialog`. The previous subscribe's cleanup set status to `"cancelled"` and notified listeners, the new subscribe then saw `"cancelled"` and called `startWalk`, and the looped `notify()` calls churned the file index indefinitely. Both closures are now stable references (memoized via `useCallback`) so React only wires the subscription once.
- **Run script: fall back to `.coding-orchestrator/` when `.controller/` is empty** (#316). The Run button on the terminal panel was reporting "No run script configured" for projects whose `.controller/` directory existed but was empty, even when the legacy `.coding-orchestrator/run.sh` was on disk. `resolveNativeScriptDir` was checking `existsSync(.controller)` instead of whether the directory actually contained scripts, so the empty new-style directory always won the existence check and the legacy fallback was never reached. The fix requires the new-style directory to actually have at least one of `run.sh` / `setup.sh` / `archive.sh` before preferring it; a fresh project (neither directory exists) still resolves to `.controller/`, matching the existing docstring intent.
- **Codex: guard terminal tmux calls with timeouts** (#310). Wrapping `tmux list-sessions` / `new-session` / `kill-session` / `capture-pane` calls behind a deadline so a hung tmux server can't stall the terminal tab polling loop forever, and adding back-off to the 2 s `getTerminalTabs` poll after consecutive failures so a degraded tmux daemon doesn't pin a CPU.

## [0.3.2] - 2026-07-18

### Fixed

- **CLI: reject unknown flags; accept `--agent` as alias for `--provider`** (#307, fixes #306). The unified `controller` CLI silently accepted unknown `--…` flags because the parsers only read the flags they knew about. A typo like `--agent claude` instead of `--provider claude` was dropped on the floor and the CLI fell back to the default provider, so the user only noticed the mistake when the wrong agent ended up running on the worktree. A new `assertKnownFlags` helper now fails with a clear error naming the offending flag and listing the valid set; `parseSessions start`, `parseWorktrees create`, and `parseSchedules add` all call it with the flags they actually support. `--agent` is accepted as a forgiving alias of `--provider` in `parseSessions start` and `parseSchedules add` — if both are passed and disagree, the CLI fails loudly; if they agree, the value is used. `--provider` stays the canonical name in help text and skill examples, and the `USAGE` block now shows `[--provider|--agent codex|claude|anita]` so the alias is discoverable from `--help`. The check is scoped to the pre-`--message` slice of argv so natural prompts like `--message "explain --help"` keep working.

## [0.3.1] - 2026-07-14

> **macOS Gatekeeper:** the macOS build remains ad-hoc-signed and not
> notarized. On first launch, open **System Settings → Privacy & Security →
> Security** and click **Open Anyway** for Controller.

### Added

- **Settings: Schedules section** (#303). A new **Schedules** entry in the Settings page lets the user manage scheduled sessions without leaving the app. The section lists every project's schedules in one view (worktree, prompt preview, trigger type — one-shot or cron with timezone, next/last run, enabled state, source, last error inline), with a create form that mirrors the CLI, an enable/disable toggle, a delete with confirmation, and a runs drawer that deep-links to a session when a run has one. Server-side validation errors (bad cron / timezone) are surfaced inline. Editing existing schedules is intentionally not exposed — the server has no PUT route for it. The CLI remains the source of truth for the data model; this is a UI over the existing REST surface in `server/routes/schedules.ts`.
- **CLI: cwd-based project resolution for `worktrees` / `sessions` / `schedules`**. The `<project>` positional is now optional on `worktrees list`, `worktrees create`, `sessions start`, `schedules list`, and `schedules add` — the CLI resolves the project that owns the agent's shell `cwd` (longest-prefix match, falling back to a Controller-created worktree's owning project) when the positional is missing. A new `GET /api/projects?cwd=<absolutePath>` endpoint on the server returns `{ project: Project | null }` for the lookup. The bare `GET /api/projects` array shape is unchanged. When a `<project>` is supplied but doesn't match by id or name, the CLI also tries the cwd lookup and uses that match, so a typo'd name from inside a worktree no longer makes `worktrees create` fail. The error message includes the cwd and a "did you mean" hint when nothing resolves. The `controller-worktrees` and `controller-schedules` managed skills document the new behavior; the `controller worktrees create --name foo` and `controller sessions start --worktree <id> --message "..."` forms now work from any shell inside an onboarded project.

### Fixed

- **Terminals: kill tmux session on tab close** (#296). Closing a terminal tab while the WebSocket was still CONNECTING (or without ever opening one) left the underlying tmux session alive; the next 2s `getTerminalTabs` poll would re-discover it via `listTmuxTerminalIds` and re-add the tab. The PUT `/api/projects/:id/terminal-tabs` handler now calls `ptyManager.kill` unconditionally when `removeTerminalId` is set, and the kill path also cleans up the pre-rename `coding-orchestrator-` tmux prefix so legacy sessions don't re-merge. A client-side `pendingCloseRef` belt-and-suspenders delivers a close requested during CONNECTING as soon as the WS opens.
- **Terminals: kill legacy `coding-orchestrator-` tmux sessions on tab close** (#297). Follow-up to #296: the pre-rename `coding-orchestrator-` tmux sessions that some users still have on disk were not being reaped by the new `ptyManager.kill` path because their id format didn't match the post-rename prefix. The cleanup now also targets that legacy prefix so stale tabs from earlier installs don't keep re-materialising.
- **Terminal CLI: list / run / snapshot / tail reach tmux-only sessions** (#301). When the user closes a tab the WebSocket disconnect kills the node-pty via `ptyManager.detachIfIdle`, but the underlying tmux session stays alive so the user can re-attach. The agent's `controller terminal list` was gating on the in-memory PTY map and returning "no terminals" in worktrees the user clearly has tabs open in; the same gap made `run` / `snapshot` 404. The agent surface now agrees with the renderer's tmux-driven tab list: `list` uses `ptyManager.listLiveByPrefix` (PTY ∪ live tmux, scoped to the worktree prefix), the `run` / `snapshot` / `tail` gate uses `ptyManager.isLive`, `snapshot` falls back to `tmux capture-pane` for tmux-only sessions, and `tail` attaches a transient PTY via `getOrCreate` and cleans it up via `detachIfIdle` when the iteration ends.
- **Embedded terminal: copy mode state stuck** (#300). The embedded terminal could get stuck in copy mode after a selection (e.g. drag-to-select on Linux) until the user clicked back into the terminal and pressed a key. The component now tracks the active selection / copy mode state on the terminal instance and clears it deterministically when the user clicks elsewhere or the terminal re-mounts.
- **Tests: fix session lifecycle test flakes** (#299). A handful of `server/lib/__tests__/session*.test.ts` cases were racing the in-process SSE teardown and intermittently failing in CI. The fixtures now await the lifecycle event before asserting, and the cleanup hooks are ordered so the temp project is removed after the session is fully closed.

## [0.3.0] - 2026-07-05

### Added

- **Integrations: OAuth (dynamic / MCP) auth scheme** ([#280](https://github.com/germanescobar/controller/pull/280)). A new "OAuth (dynamic / MCP)" preset in the Add-scheme picker. Clicking **Connect** runs the full RFC 8414 + RFC 7591 + PKCE flow against the MCP server's authorization server: metadata discovery, dynamic client registration, a loopback browser-redirect callback, and token storage in the secret store. Subsequent agent runs attach the access token as a bearer; the scheme proactively refreshes on expiry and the UI shows a **Reconnect** action when re-auth is required.
- **CLI: `integrations create` and `integrations list --all`** ([#279](https://github.com/germanescobar/controller/pull/279)). Adds a `create` subcommand for adding integrations from the terminal and a `--all` flag on `list` that shows non-installed integrations.
- **Controller Mode: auto-advance after approval + structured-input submit** ([#277](https://github.com/germanescobar/controller/pull/277)). The on-radar focus queue now advances to the next session after an approval gate, and structured-input fields can be submitted as part of the same turn.
- **Cloudflare as an Anita model provider** ([#291](https://github.com/germanescobar/controller/pull/291)). Cloudflare-hosted models are now selectable as an Anita provider.
- **Restore Fable 5 to the Claude model list** ([#282](https://github.com/germanescobar/controller/pull/282)).

### Changed

- **Secret store: opt-in encryption, recovery on stale ciphertext** ([#280](https://github.com/germanescobar/controller/pull/280)). The at-rest store for integration secrets now defaults to the 0600 plaintext envelope; the encrypted envelope is used only when `CONTROLLER_ENCRYPT_SECRETS=1` is set. On any un-recoverable read the file is renamed to `integration-secrets.json.broken-<iso>` and the app returns an empty store.

### Removed

- **Groq model provider** ([#293](https://github.com/germanescobar/controller/pull/293)).

### Fixed

- **Dialog overflow on long, non-wrapping code blocks in SKILL.md** ([#290](https://github.com/germanescobar/controller/pull/290)). Skill dialogs now scroll cleanly when displayed source contains wide unbreakable lines.
- **Revert auto-advance toast copy from #284** ([#288](https://github.com/germanescobar/controller/pull/288)).

### Docs

- **Clarify `controller-worktrees` default behavior** ([#283](https://github.com/germanescobar/controller/pull/283)). The skill description now states the default is to create a worktree and start a session.

## [0.2.0] - 2026-06-28

The second preview release. Headline changes: the orchestrator's on-disk
state moved out of `$HOME` to platform-appropriate locations (a breaking
change for existing installs — see below), a public docs site, agent-facing
CLI surfaces for worktrees / sessions / terminals, per-agent auto-approval
controls, and the completion of the **Coding Orchestrator → Controller**
and **Ada → Anita** renames.

> **Upgrade note (breaking):** if you are coming from 0.1.0 (or any
> pre-#223 build) with state under `~/coding-orchestrator/`, move that
> directory to the new home **before** launching 0.2.0. The new build does
> not read or migrate the old path; leaving state behind starts the app
> empty. See *Changed → Move orchestrator state out of `$HOME`* below and
> the README's "State location" section for the exact `mv` per platform.

> **macOS Gatekeeper:** the macOS build remains ad-hoc-signed and not
> notarized. On first launch, open **System Settings → Privacy & Security →
> Security** and click **Open Anyway** for Controller.

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

- **Agent-controlled terminal surface** (`controller terminal` CLI +
  managed skill). Agents can list the user's open terminals, run a
  command in a specific tab, snapshot recent output, and tail new
  output without opening a fresh shell.

- **Per-agent auto-approval flags** (#258). Auto-approval behavior is
  now configurable per agent from the agent settings, alongside the
  simplified settings rows (#273).

- **Schedule future sessions with optional repeat** (#245). Queue a
  session to run later, once at a specific time or on a recurring
  schedule.

- **`run.sh` support in the project form** (#238). Projects can declare
  a per-worktree run script from the project settings form.

- **Clickable internal `controller://` links.** Transcripts can link to
  other conversations and resolve them inside the app.

- **Persist chat composer drafts across navigation** (#253), including
  the selected agent and run options (#275), and **persist run env in
  terminal sessions** (#274), so in-progress input and per-session
  configuration survive navigation and refreshes.

- **Render Anita manual-approval prompts in the UI** (#270). Manual tool
  approvals requested by Anita are now surfaced as interactive prompts.

- **Refresh button in the source-tab file explorer.**

- **Public docs site on GitHub Pages** (#246) with a sidebar help icon,
  completed with full user-guide and development sections (#256).

- **Customizable Controller Mode shortcuts** (#242). The Controller Mode
  focus-advance shortcuts are now modifier-based and user-customizable,
  with a live "stay / continue" chord shown on the focus-advance toast
  (#235).

### Changed

- **Move orchestrator state out of `$HOME` and reduce macOS TCC prompts** (#223).
  This is a **breaking change for existing installs**: the orchestrator's home
  directory moved to the platform-appropriate location:
  - **macOS:** `~/Library/Application Support/Controller/`
  - **Linux:** `$XDG_STATE_HOME/Controller/` (falls back to `~/.local/state/Controller/`)
  - **Other:** legacy `~/coding-orchestrator/` until a follow-up adds a native convention

  If you're upgrading from a pre-223 install with state under
  `~/coding-orchestrator/`, move that directory to the new location by hand
  before starting the new build (see the README's "State location" section
  for the exact `mv` per platform). The new build does not read or write
  the old path; leaving state behind means the new build starts empty.

  Env-var contract: `CONTROLLER_HOME` overrides the home for the current
  process. There is no `CODING_ORCHESTRATOR_HOME` alias — tests and dev
  shells set `CONTROLLER_HOME` directly. The CLI now also receives
  `CONTROLLER_HOME` in the env injected for spawned agents, and its
  `controller-runtime.json` lookup uses the platform-default home. Net
  effect: `~/coding-orchestrator/` is no longer created or read on macOS,
  and the new home is exempt from TCC prompts because it lives under
  `Application Support`.

  Dev-binary signature stability (the other half of why TCC consent
  doesn't stick across rebuilds) is deferred to a follow-up PR.

- **Finished the Coding Orchestrator → Controller rename** (#255). The
  product is now consistently named **Controller** across the UI,
  prompts, CLI, and docs.

- **Sidebar rename and Controller Mode prominence.** The sidebar's
  "In flight" section is now **On radar**, and the copy in the
  focus-queue empty state, the Controller Mode banner inside the
  session view, and the "Add/Remove from in-flight" tooltips on the
  radar pin buttons (header and mobile) all use the new "On radar"
  wording. The "New project" entry that used to sit at the top of
  the sidebar moved to a small **New** button on the right of the
  **Projects** label. Controller Mode now sits inline next to the
  **ON RADAR** label (only when the focus queue has items), showing
  a play icon and the "Controller Mode" label (the `F`/`E` keyboard
  hint was dropped to keep the button visually quiet), with an
  active blue/ringed state when on and a neutral hover state when
  off. The completion toast
  ("Session completed — A background session has finished. [View]")
  and the green-dot badge on completed sessions in the sidebar were
  removed; the `completedSessions` state and prop were deleted
  since nothing reads them anymore.

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

- **Send project env to tmux via a temp file** rather than inline in the
  `send-keys` line, so environment values with spaces or shell
  metacharacters reach terminal sessions intact.

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

- **Quote the macOS CLI path before rendering commands.** The agent preamble
  and the four managed skill bodies (browser, integrations, scripts,
  search-skills, skill-creator, worktrees) now interpolate the Controller
  CLI's install path wrapped in single quotes. On macOS the default home
  is `~/Library/Application Support/Controller/` which contains a literal
  space; without quoting, an agent that copies the documented "absolute
  path" command verbatim hits a shell split at the space before the CLI
  ever runs. The fix is in `controllerCliShellPath()` / `shellQuote()` in
  `server/lib/controller-cli.ts`; the raw path is still exported as
  `controllerCliInstalledPath()` for consumers that need the actual
  filesystem path.

- **`controller integrations …` no longer crashes with
  `ReferenceError: runIntegrations is not defined`** (#178). The unified
  CLI's dispatcher called a `runIntegrations` helper that was never
  defined, so every `list` / `search` / `tools` / `describe` / `call` /
  `request` / `status` subcommand threw before reaching the server. The
  dispatcher is now wired up to `parseIntegrations` and `printIntegrations`,
  mirroring the `browser` and `skills` surfaces, and POSTs to the
  `/api/integrations/gateway/<endpoint>` routes the server already
  exposes. A new smoke-test file (`cli/__tests__/controller-cli.test.mjs`)
  imports the CLI module, stubs `fetch`, and asserts the regression class
  is caught early.

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
  events in stream order.

- **Claude "Always allow" no longer hangs after approval.** Granting an
  "Always allow" tool approval to the Claude agent no longer leaves the
  run waiting; the approval resolves and the turn continues.

- **Codex: clear stale tool approvals after terminal runs.** Tool
  approvals left over from a previous terminal run are now cleared so
  they don't leak into the next run.

- **Exclude shared test files from the Electron TypeScript build** so
  `*.test.ts` files under `shared/` no longer break `build:electron-runtime`.

### Docs

- **Mention Conductor and Superset project support in the Overview** (#272).

- **Document the macOS Gatekeeper bypass** (and the Tahoe Gatekeeper
  dead-end / direct-binary launch workaround) for the ad-hoc-signed,
  un-notarized build.
