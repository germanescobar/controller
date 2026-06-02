# Coding Orchestrator

A web-based UI for managing and interacting with AI coding agents. It provides a chat-like interface to send prompts to coding agents (such as Ada, Codex, and Claude), stream their responses in real time, and organize work into projects and sessions.

## Features

- **Multi-provider support** — plug in different AI coding agents (Ada, Codex, Claude) and switch between them per session.
- **Project management** — register local project directories and manage them from a sidebar.
- **Session management** — create, resume, and archive coding sessions within each project. Sessions persist their event history to disk.
- **Real-time streaming** — agent output (text, reasoning, tool calls, tool results) is streamed to the browser via SSE.
- **Model selection** — choose which model to use for each session.
- **API key management** — configure provider API keys through a settings dialog; keys are passed as environment variables to the agent process.
- **Responsive UI** — dark-themed interface with a collapsible sidebar that works on desktop and mobile.
- **Desktop shell** — optional Electron wrapper that runs the same UI and backend as the browser app.

## Architecture

```
client/          React + Vite frontend (Tailwind CSS, shadcn/ui)
electron/        Electron desktop shell
server/          Express API backend
  lib/
    agents.ts    Agent provider abstraction & Ada/Codex/Claude adapters
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

## Getting Started

### Prerequisites

- Node.js 20+
- `tmux` for persistent embedded terminals that survive backend restarts
- At least one supported coding agent CLI installed and on your `PATH`:
  - **Ada** (`ada`)
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

This starts the existing Express and Vite dev servers, waits for the Vite URL, and opens the Electron shell at the same React UI.

### Build

```bash
npm run build
```

The production build outputs the client, server, and Electron main process under `dist/`.

### Package Electron

```bash
npm run package:electron
```

This creates a local current-OS Electron package under `release/`. The packaged app starts the local Express backend and loads the built client through it.

### Network Access

Coding Orchestrator can manage local paths, spawn agent CLIs, run terminal sessions, and store API keys. Treat the backend as privileged. For access from phones or other devices, prefer trusted networks, VPNs, or secure tunnels such as Tailscale. Do not expose the server directly to the public internet without adding an authentication layer.

## Usage

1. Open the app in your browser.
2. Create a project by pointing it at a local directory.
3. Start a new session, pick a provider and model, and type a prompt.
4. Watch the agent work in real time — you'll see its reasoning, tool calls, and text responses streamed into the chat.
5. Resume previous sessions from the sidebar.
