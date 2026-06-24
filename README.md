# Coding Orchestrator

A web-based UI for managing and interacting with AI coding agents. It provides a chat-like interface to send prompts to coding agents (such as Anita, Codex, and Claude), stream their responses in real time, and organize work into projects and sessions.

## Features

- **Multi-provider support** — plug in different AI coding agents (Anita, Codex, Claude) and switch between them per session.
- **Project management** — register local project directories and manage them from a sidebar.
- **Session management** — create, resume, and archive coding sessions within each project. Sessions persist their event history to disk.
- **Real-time streaming** — agent output (text, reasoning, tool calls, tool results) is streamed to the browser via SSE.
- **Model selection** — choose which model to use for each session.
- **Slash-command skills** — type `/<skill-name>` in the chat input to activate an installed skill for Anita, Codex, or Claude. The orchestrator is the only source of truth for slash commands; it prepends the `SKILL.md` body at send time and turns off the agent CLIs' own slash-command paths so the two never compete.
- **API key management** — configure provider API keys through a settings dialog; keys are passed as environment variables to the agent process.
- **Responsive UI** — dark-themed interface with a collapsible sidebar that works on desktop and mobile.
- **Desktop shell** — optional Electron wrapper that runs the same UI and backend as the browser app.

## Architecture

```
client/          React + Vite frontend (Tailwind CSS, shadcn/ui)
electron/        Electron desktop shell
server/          Express API backend
  lib/
    agents.ts    Agent provider abstraction & Anita/Codex/Claude adapters
    sessions.ts  Session & event persistence (JSON/JSONL files)
    projects.ts  Project registry
    api-keys.ts  API key storage
  routes/
    sessions.ts  SSE streaming, session CRUD
    projects.ts  Project CRUD
    models.ts    Model listing
    api-keys.ts  API key CRUD
```

The server spawns agent CLIs as child processes, parses their JSON output streams, normalizes events into a common format (`AgentStreamEvent`), and forwards them to the client over SSE. Session state and events are stored as JSON/JSONL files inside each project's `.coding-agent/` directory.

Embedded terminal tabs are backed by deterministic `tmux` sessions. The Express server attaches browser WebSocket connections to those sessions, so commands started in a terminal can survive browser refreshes and backend hot reloads. Closing a terminal tab intentionally kills its associated `tmux` session.

Electron is an additional shell around the same app. In development it loads the Vite dev server. In packaged builds it starts the compiled Express backend locally and loads the built client from that backend, so browser and desktop modes keep the same API, SSE, and WebSocket contracts.

### State location

Controller keeps all of its runtime state (project list, API keys, worktrees, session transcripts, unified skill catalog, installed CLI) in a single **Controller home** directory, resolved in this order:

1. `CONTROLLER_HOME` — the canonical override. If set, everything lands under it.
2. Platform default:
   - **macOS** — `~/Library/Application Support/Controller/`
   - **Linux** — `$XDG_STATE_HOME/Controller/`, falling back to `~/.local/state/Controller/`
   - **Other** — `~/coding-orchestrator/` (legacy fallback; future work will add `%LOCALAPPDATA%` for Windows)

If you're upgrading from a pre-223 install that had state under `~/coding-orchestrator/`, move the directory to the new platform-appropriate home by hand before starting the new build:

```sh
# macOS
mv ~/coding-orchestrator ~/Library/Application\ Support/Controller

# Linux (with XDG_STATE_HOME set)
mv ~/coding-orchestrator "$XDG_STATE_HOME/Controller"

# Linux (without XDG_STATE_HOME)
mv ~/coding-orchestrator ~/.local/state/Controller
```

There is no automatic migration: the new build does not read or write the old path, so leaving state behind means the new build starts empty.

### macOS privacy prompts

macOS shows "Allow access to..." dialogs when a process reads `~/Desktop`, `~/Documents`, `~/Downloads`, or `~/Music`. Controller's *own* state lives under `~/Library/Application Support/Controller/`, which is exempt — that path never triggers TCC. Prompts you can still see in normal use:

| Trigger | First-time effect | How to reset |
|---|---|---|
| Add a project whose path lives under a protected folder (e.g. `~/Downloads/foo`) and then run a worktree or session on it | "Controller wants to access ~/Downloads" the first time the process reads inside the chosen path | System Settings → Privacy & Security → Files and Folders → Controller. Toggle off and on to re-prompt. |
| Use the **Browse…** button on the *Add a project* card while running inside the packaged Electron app | The native picker grants access implicitly; no separate prompt fires | n/a |
| Import a skill from a per-agent home (`~/.codex/skills/`, `~/.claude/skills/`, `~/.anita/skills/`) that's on a protected volume | Prompt for the agent's home folder | Same panel |

The prompts fire at most once per (process × folder) and persist across launches as long as the app's code signature is stable. For development builds the signature changes on every rebuild, which is the main reason a clean install shows the prompt more often than a packaged build does.

## Getting Started

### Prerequisites

- Node.js 20+
- `tmux` for persistent embedded terminals that survive backend restarts
- At least one supported coding agent CLI installed and on your `PATH`:
  - **Anita** (`anita`)
  - **Codex** (`codex`)
  - **Claude** (`claude`)

### Install & Run

```bash
npm install
npm run dev
```

This starts both the Express server (port 3100) and the Vite dev server concurrently.

The Vite dev server listens on port 4500 by default and proxies `/api` and `/ws/terminal` to the Express server. The server remains reachable from other devices when your network allows it, which supports mobile access through trusted LAN, VPN, or secure tunnel setups such as Tailscale.

### Electron Development

```bash
npm run dev:electron
```

This starts the existing Express and Vite dev servers, waits for the Vite URL, and opens the Electron shell at the same React UI. The development path skips the welcome screen described below.

### Package Electron

```bash
npm run package:electron
```

This creates a local current-OS Electron package under `release/`. The packaged app starts the local Express backend and loads the built client through it.

#### First-run welcome screen

The **packaged** build shows a one-time "Welcome to Controller" screen on first launch. Pick the port the local backend will run on (default `4500`; ports below `1024` are rejected), then click **Continue**. The chosen port is remembered in `localStorage`, so subsequent launches skip the welcome screen and go straight to the app on the saved port. If that port is taken on a later launch, the welcome screen reappears with a one-click suggestion for the next free port.

The same window shows a "Listening on port N" footer in the main app shell, with a popover that surfaces the local URL (with a Copy button) and a reminder to reach the app from your phone over a private network like Tailscale.

### Network Access

Coding Orchestrator can manage local paths, spawn agent CLIs, run terminal sessions, and store API keys. Treat the backend as privileged. For access from phones or other devices, prefer trusted networks, VPNs, or secure tunnels such as Tailscale. Do not expose the server directly to the public internet without adding an authentication layer.

## Usage

1. Open the app in your browser.
2. Create a project by pointing it at a local directory.
3. Start a new session, pick a provider and model, and type a prompt.
4. Watch the agent work in real time — you'll see its reasoning, tool calls, and text responses streamed into the chat.
5. Resume previous sessions from the sidebar.
