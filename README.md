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

## Architecture

```
client/          React + Vite frontend (Tailwind CSS, shadcn/ui)
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

## Getting Started

### Prerequisites

- Node.js 20+
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

### Build

```bash
npm run build
```

## Usage

1. Open the app in your browser.
2. Create a project by pointing it at a local directory.
3. Start a new session, pick a provider and model, and type a prompt.
4. Watch the agent work in real time — you'll see its reasoning, tool calls, and text responses streamed into the chat.
5. Resume previous sessions from the sidebar.
