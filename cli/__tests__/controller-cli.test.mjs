/*
 * Smoke tests for the unified `controller` CLI (issue #178).
 *
 * The CLI is dependency-free on purpose so it can be copied into packaged
 * builds without a build step, which means tests have to reach into it via
 * `import()` + a file URL (no extension to resolve). We stub `globalThis.fetch`
 * to assert the dispatcher wires the parsed subcommand to the right
 * `/api/integrations/<endpoint>` route and passes `cwd` along so the gateway
 * can scope the lookup to the worktree.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const controllerUrl = pathToFileURL(path.join(repoRoot, "cli", "controller")).href;

/* Reload the CLI module to defeat `isMain` side-effects from a previous test. */
async function loadCli() {
  return import(`${controllerUrl}?t=${Date.now()}-${Math.random()}`);
}

test("runIntegrations is defined (regression for issue #178)", async () => {
  const cli = await loadCli();
  assert.equal(typeof cli.runIntegrations, "function");
});

test("parseIntegrations maps subcommands to gateway endpoints", async () => {
  const cli = await loadCli();
  assert.deepEqual(cli.parseIntegrations(["list"]), { action: "gateway", endpoint: "list", body: {} });
  assert.deepEqual(
    cli.parseIntegrations(["search", "openapi", "auth"]),
    { action: "gateway", endpoint: "search", body: { query: "openapi auth" } }
  );
  assert.deepEqual(
    cli.parseIntegrations(["call", "Trello", "createCard", "--json", '{"idList":"abc"}']),
    { action: "gateway", endpoint: "call", body: { integration: "Trello", tool: "createCard", args: { idList: "abc" } } }
  );
});

test("runIntegrations POSTs to /api/integrations/gateway/<endpoint> and prints the result", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      status: 200,
      json: async () => ({ connections: [{ name: "Trello", mode: "rest", kind: "request", summary: "ok" }] }),
    };
  };
  const originalCwd = process.cwd();
  const originalStdout = process.stdout.write.bind(process.stdout);
  const stdoutChunks = [];
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runIntegrations(["list"], "http://controller.test");
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
    process.chdir(originalCwd);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://controller.test/api/integrations/gateway/list");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.cwd, originalCwd);
  assert.deepEqual(stdoutChunks.join(""), "Trello  [rest/request]  ok\n");
});

test("runIntegrations surfaces server errors as a non-zero exit", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 400,
    json: async () => ({ error: "No enabled integration named \"Nope\"." }),
  });
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(() => cli.runIntegrations(["status", "Nope"], "http://controller.test"), /__exit__/);
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /No enabled integration named "Nope"\./);
});

// ---------------------------------------------------------------------------
// terminal CLI parser + dispatcher (issue #261)
// ---------------------------------------------------------------------------

test("parseTerminal maps list/run/snapshot/tail to action payloads", async () => {
  const cli = await loadCli();
  assert.deepEqual(cli.parseTerminal(["list"]), { action: "list", params: {} });
  // `run` keeps the command verbatim, joining everything after the id.
  assert.deepEqual(
    cli.parseTerminal(["run", "build", "npm", "run", "dev"]),
    { action: "run", params: { terminalId: "build", command: "npm run dev" } }
  );
  // `--lines` is parsed regardless of position and coerced to a number.
  assert.deepEqual(
    cli.parseTerminal(["snapshot", "build", "--lines", "50"]),
    { action: "snapshot", params: { terminalId: "build", lines: 50 } }
  );
  assert.deepEqual(
    cli.parseTerminal(["snapshot", "build"]),
    { action: "snapshot", params: { terminalId: "build" } }
  );
  assert.deepEqual(
    cli.parseTerminal(["tail", "build", "--follow"]),
    { action: "tail", params: { terminalId: "build", follow: true } }
  );
  assert.deepEqual(
    cli.parseTerminal(["tail", "build"]),
    { action: "tail", params: { terminalId: "build", follow: false } }
  );
});

test("parseTerminal requires a terminal id for run/snapshot/tail", async () => {
  const cli = await loadCli();
  for (const argv of [["run"], ["snapshot"], ["tail"], ["run", "build"]]) {
    const originalExit = process.exit;
    const originalStderr = process.stderr.write.bind(process.stderr);
    let exitCode = null;
    process.exit = (code) => {
      exitCode = code;
      throw new Error("__exit__");
    };
    process.stderr.write = () => true;
    try {
      await assert.rejects(async () => cli.parseTerminal(argv), /__exit__/);
    } finally {
      process.exit = originalExit;
      process.stderr.write = originalStderr;
    }
    assert.equal(exitCode, 1, `expected ${JSON.stringify(argv)} to fail`);
  }
});

test("runTerminal list POSTs to /api/terminal/command and prints one row per terminal", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      status: 200,
      json: async () => ({
        ok: true,
        projectId: "p1",
        worktreeId: "w1",
        terminals: [
          { id: "default", label: "default", attached: true },
          { id: "build", label: "build", attached: false },
        ],
      }),
    };
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runTerminal(["list"], "http://controller.test");
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://controller.test/api/terminal/command");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.action, "list");
  assert.equal(body.cwd, process.cwd());
  const out = stdoutChunks.join("");
  assert.match(out, /default {2}\[attached\]/);
  assert.match(out, /\bbuild\b/);
});

test("runTerminal surfaces a server error as a non-zero exit", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 404,
    json: async () => ({ ok: false, error: 'No terminal "build" is open in this worktree.' }),
  });
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      () => cli.runTerminal(["snapshot", "build"], "http://controller.test"),
      /__exit__/
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /No terminal "build" is open/);
});

// ---------------------------------------------------------------------------
// worktrees + sessions CLI parsers (issue #190)
// ---------------------------------------------------------------------------

test("parseWorktrees maps list/create/delete to the right actions", async () => {
  const cli = await loadCli();
  assert.deepEqual(
    cli.parseWorktrees(["list", "demo"]),
    { project: "demo", action: "list" }
  );
  assert.deepEqual(
    cli.parseWorktrees(["create", "demo", "--name", "issue-190", "--branch", "feat-190", "--base", "main"]),
    {
      project: "demo",
      action: "create",
      body: { name: "issue-190", branch: "feat-190", baseBranch: "main" },
    }
  );
  assert.deepEqual(
    cli.parseWorktrees(["delete", "demo", "wt-123"]),
    { project: "demo", action: "delete", worktreeId: "wt-123" }
  );
});

test("parseWorktrees create rejects an unknown flag (issue #306)", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () =>
        cli.parseWorktrees([
          "create",
          "demo",
          "--name",
          "wt-1",
          "--frobnicate",
          "yes",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /Unknown flag for worktrees create/);
  assert.match(stderrText, /--frobnicate/);
  assert.match(stderrText, /--name/);
});

// ---------------------------------------------------------------------------
// project resolution: cwd-based fallback (sessions struggled to find the
// project when they didn't know its name — this lets the CLI resolve the
// project that owns the agent's shell `cwd` instead of requiring an id/name).
// ---------------------------------------------------------------------------

test("parseWorktrees accepts a missing <project> (resolved later from cwd)", async () => {
  const cli = await loadCli();
  assert.deepEqual(
    cli.parseWorktrees(["list"]),
    { project: "", action: "list" }
  );
  // When the user skips the <project> positional, the next token (a
  // flag) is the parser's signal that the project was omitted. The
  // run path then resolves the project from cwd via `resolveProjectId`.
  assert.deepEqual(
    cli.parseWorktrees(["create", "--name", "issue-1"]),
    { project: "", action: "create", body: { name: "issue-1" } }
  );
  // Supplying a project explicitly still works exactly as before.
  assert.deepEqual(
    cli.parseWorktrees(["create", "demo", "--name", "issue-1"]),
    { project: "demo", action: "create", body: { name: "issue-1" } }
  );
});

test("parseSessions accepts a missing <project> (resolved later from cwd)", async () => {
  const cli = await loadCli();
  const parsed = cli.parseSessions([
    "start",
    "--worktree",
    "wt-123",
    "Implement the project-mgmt block",
  ]);
  assert.equal(parsed.project, "");
  assert.equal(parsed.action, "start");
  assert.equal(parsed.body.worktreeId, "wt-123");
  assert.equal(parsed.body.message, "Implement the project-mgmt block");
});

test("parseSchedules accepts a missing <project> on list and add", async () => {
  const cli = await loadCli();
  assert.equal(cli.parseSchedules(["list"]).project, "");
  assert.equal(cli.parseSchedules(["list", "--enabled-only"]).project, "");
  const add = cli.parseSchedules([
    "add",
    "--worktree",
    "wt-1",
    "--prompt",
    "morning health check",
    "--at",
    "2026-06-26T08:00:00.000Z",
  ]);
  assert.equal(add.project, "");
  assert.equal(add.action, "add");
});

// ---------------------------------------------------------------------------
// memory CLI parser (issue #350)
// ---------------------------------------------------------------------------

test("parseMemory maps list/read/write/pin to action payloads", async () => {
  const cli = await loadCli();
  // `list` defaults to global scope; --scope switches it.
  const list = cli.parseMemory(["list"]);
  assert.equal(list.action, "list");
  assert.equal(list.scope, "global");
  const listProject = cli.parseMemory(["list", "--scope", "project", "--include-pinned"]);
  assert.equal(listProject.scope, "project");
  assert.equal(listProject.includePinned, true);
  // --scope <projectId> passes the project id through.
  const listScoped = cli.parseMemory(["list", "--scope", "p-1"]);
  assert.equal(listScoped.scope, "project");
  assert.equal(listScoped.projectId, "p-1");
  // `read`/`write`/`pinned`/`pin` keep <scope> as a positional.
  const read = cli.parseMemory(["read", "global", "deploy-via-gh"]);
  assert.equal(read.action, "read");
  assert.equal(read.scope, "global");
  assert.equal(read.slug, "deploy-via-gh");
  const write = cli.parseMemory(["write", "global", "deploy-via-gh", "--content", "use GH action"]);
  assert.equal(write.action, "write");
  assert.equal(write.body.contentFlag, "use GH action");
  // `search` puts the query first; --scope is a flag (default global).
  const search = cli.parseMemory(["search", "deploy"]);
  assert.equal(search.action, "search");
  assert.equal(search.query, "deploy");
  const searchProject = cli.parseMemory(["search", "deploy", "--scope", "p-1", "--limit", "5"]);
  assert.equal(searchProject.scope, "project");
  assert.equal(searchProject.projectId, "p-1");
  assert.equal(searchProject.limit, 5);
  assert.equal(searchProject.query, "deploy");
  const pinned = cli.parseMemory(["pinned", "global"]);
  assert.equal(pinned.action, "pinned");
  const pin = cli.parseMemory(["pin", "global", "--content", "always-injected"]);
  assert.equal(pin.action, "pin");
  assert.equal(pin.body.contentFlag, "always-injected");
});

test("parseMemory rejects unknown scopes and missing slugs", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error("__exit__"); };
  process.stderr.write = () => true;
  try {
    await assert.rejects(async () => cli.parseMemory(["read", "weird", "slug"]), /__exit__/);
    assert.equal(exitCode, 1);
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  // Missing slug for read
  const originalExit2 = process.exit;
  const originalStderr2 = process.stderr.write.bind(process.stderr);
  let exitCode2 = null;
  process.exit = (code) => { exitCode2 = code; throw new Error("__exit__"); };
  process.stderr.write = () => true;
  try {
    await assert.rejects(async () => cli.parseMemory(["read", "global"]), /__exit__/);
    assert.equal(exitCode2, 1);
  } finally {
    process.exit = originalExit2;
    process.stderr.write = originalStderr2;
  }
});

test("parseMemory write requires --content or --content-file", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error("__exit__"); };
  process.stderr.write = () => true;
  try {
    await assert.rejects(
      async () => cli.parseMemory(["write", "global", "slug"]),
      /__exit__/
    );
    assert.equal(exitCode, 1);
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
});

test("runMemory list hits GET /api/memory with the scope/projectId params", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    // Project-scope calls resolve the projectId via cwd before hitting
    // /api/memory (PR review, P2). Stub the project list so the
    // resolver returns the same id the test passed in.
    if (u.includes("/api/projects")) {
      return { status: 200, json: async () => [{ id: "p-1", name: "p-1" }] };
    }
    captured = { url: u, init };
    return {
      status: 200,
      json: async () => ({ entries: [{ slug: "x", scope: "global", preview: "p", mtimeMs: 1 }] }),
    };
  };
  try {
    await cli.runMemory(["list", "--scope", "project", "--project", "p-1", "--include-pinned"], "http://controller.test");
    assert.match(captured.url, /\/api\/memory\?/);
    assert.match(captured.url, /scope=project/);
    assert.match(captured.url, /projectId=p-1/);
    assert.match(captured.url, /includePinned=1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runMemory write PUTs to /api/memory/<scope>/<slug>", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return { status: 200, json: async () => ({ ok: true }) };
  };
  try {
    await cli.runMemory(["write", "global", "deploy", "--content", "use GH"], "http://controller.test");
    assert.equal(captured.init.method, "PUT");
    assert.match(captured.url, /\/api\/memory\/global\/deploy/);
    const body = JSON.parse(captured.init.body);
    assert.equal(body.content, "use GH");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runMemory search GETs the search endpoint with the query", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return { status: 200, json: async () => ({ results: [] }) };
  };
  try {
    await cli.runMemory(["search", "deploy", "--limit", "5"], "http://controller.test");
    assert.match(captured.url, /\/api\/memory\/global\/search\?/);
    assert.match(captured.url, /query=deploy/);
    assert.match(captured.url, /limit=5/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseMemory accepts 'project' as a positional <scope> for read/write/pin/pinned (PR review, P1)", async () => {
  const cli = await loadCli();
  // The original code only allowed 'global' positionally; valid
  // project-scope calls (the documented form per the issue spec)
  // exited with "Unknown memory command" before making a request.
  const read = cli.parseMemory(["read", "project", "conventions", "--project", "p-1"]);
  assert.equal(read.action, "read");
  assert.equal(read.scope, "project");
  assert.equal(read.slug, "conventions");
  assert.equal(read.projectId, "p-1");

  const write = cli.parseMemory(["write", "project", "conventions", "--content", "x", "--project", "p-1"]);
  assert.equal(write.scope, "project");
  assert.equal(write.body.contentFlag, "x");

  const pinned = cli.parseMemory(["pinned", "project", "--project", "p-1"]);
  assert.equal(pinned.action, "pinned");
  assert.equal(pinned.scope, "project");

  const pin = cli.parseMemory(["pin", "project", "--content", "x", "--project", "p-1"]);
  assert.equal(pin.action, "pin");
  assert.equal(pin.scope, "project");
  assert.equal(pin.body.contentFlag, "x");
});

test("parseMemory accepts --content=- as a stdin sentinel (PR review, P2)", async () => {
  const cli = await loadCli();
  // `expandEqualsForm` should split `--content=-` into two tokens so
  // `flagValue` sees the literal `-` as the value, which `readMemoryContent`
  // then resolves from stdin (matches the `--scheme-secret=-` idiom).
  const write = cli.parseMemory([
    "write", "global", "long-note", "--content=-", "--project", "p-1",
  ]);
  assert.equal(write.body.contentFlag, "-");
  // `--content -` (space form) should also resolve to the stdin sentinel
  // so the documented form from the skill body works in both shapes.
  const writeSpace = cli.parseMemory([
    "write", "global", "long-note", "--content", "-", "--project", "p-1",
  ]);
  assert.equal(writeSpace.body.contentFlag, "-");
});

test("parseMemory accepts --content=- as a stdin sentinel (PR review, P2)", async () => {
  const cli = await loadCli();
  // `expandEqualsForm` should split `--content=-` into two tokens so
  // `flagValue` sees the literal `-` as the value, which `readMemoryContent`
  // then resolves from stdin (matches the `--scheme-secret=-` idiom).
  const write = cli.parseMemory([
    "write", "global", "long-note", "--content=-", "--project", "p-1",
  ]);
  assert.equal(write.body.contentFlag, "-");
  // `--content -` (space form) should also resolve to the stdin sentinel
  // so the documented form from the skill body works in both shapes.
  const writeSpace = cli.parseMemory([
    "write", "global", "long-note", "--content", "-", "--project", "p-1",
  ]);
  assert.equal(writeSpace.body.contentFlag, "-");
});

// (The end-to-end stdin read happens inside `readMemoryContent`, which
// reads from `process.stdin` directly. The Node test runner doesn't let
// us replace `process.stdin` with a stub Readable, so the unit-level
// coverage here is the parser-shape test above; the run-time branch
// is exercised by manual use of the `--content=-` form.)

test("runMemory resolves omitted --project from cwd for project-scope calls (PR review, P2)", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const fetchedUrls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    fetchedUrls.push(u);
    // First the cwd-based project lookup, then the project-scoped list.
    if (u.endsWith("/api/projects") || u.includes("/api/projects?cwd=")) {
      return { status: 200, json: async () => ({ project: { id: "cwd-1", name: "cwd" } }) };
    }
    return {
      status: 200,
      json: async () => ({ entries: [{ slug: "x", scope: "project", projectId: "cwd-1", preview: "p", mtimeMs: 1 }] }),
    };
  };
  try {
    // The user runs `controller memory list --scope project` with no
    // --project; the CLI should resolve the project from cwd and
    // send the request with that projectId.
    await cli.runMemory(["list", "--scope", "project"], "http://controller.test");
    assert.ok(
      fetchedUrls.some((u) => u.includes("/api/projects?cwd=")),
      "expected a cwd-based project lookup"
    );
    assert.ok(
      fetchedUrls.some((u) => u.includes("projectId=cwd-1")),
      "expected the resolved projectId to be sent on the /api/memory call"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveProjectId resolves <project> by id", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "http://controller.test/api/projects");
    return { status: 200, json: async () => [{ id: "proj-uuid-1", name: "demo" }] };
  };
  try {
    const id = await cli.resolveProjectId("http://controller.test", "proj-uuid-1");
    assert.equal(id, "proj-uuid-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveProjectId resolves <project> by name", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "http://controller.test/api/projects");
    return {
      status: 200,
      json: async () => [
        { id: "proj-uuid-1", name: "controller" },
        { id: "proj-uuid-2", name: "demo" },
      ],
    };
  };
  try {
    const id = await cli.resolveProjectId("http://controller.test", "demo");
    assert.equal(id, "proj-uuid-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveProjectByCwd hits /api/projects?cwd=<cwd> and unwraps the {project} envelope", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url) => {
    captured = String(url);
    return { status: 200, json: async () => ({ project: { id: "proj-uuid-1", name: "demo" } }) };
  };
  try {
    const project = await cli.resolveProjectByCwd("http://controller.test", "/tmp/worktrees/proj-uuid-1/main");
    assert.equal(project?.id, "proj-uuid-1");
    assert.equal(project?.name, "demo");
    // The query string is URL-encoded so spaces / special chars in the
    // path don't break the roundtrip.
    assert.match(captured, /\/api\/projects\?cwd=/);
    assert.ok(captured.includes("proj-uuid-1"), `expected cwd in url, got ${captured}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveProjectByCwd returns null when the server has no project for cwd", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ project: null }) });
  try {
    const project = await cli.resolveProjectByCwd("http://controller.test", "/tmp/orphan");
    assert.equal(project, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveProjectByCwd returns null on a network error (caller falls through to a clear error)", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  try {
    const project = await cli.resolveProjectByCwd("http://controller.test", "/tmp/whatever");
    assert.equal(project, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveProjectId falls back to cwd when no <project> is supplied", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalCwd = process.cwd();
  // chdir into a fake worktree dir so the resolved cwd is deterministic.
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ctrl-resolve-"));
  process.chdir(dir);
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/projects")) {
      // Bare list (no `?cwd=`) shouldn't be hit when no ref is supplied.
      return { status: 200, json: async () => [{ id: "should-not-use", name: "should-not-use" }] };
    }
    if (String(url).includes("/api/projects?cwd=")) {
      return { status: 200, json: async () => ({ project: { id: "proj-from-cwd", name: "FromCwd" } }) };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  try {
    const id = await cli.resolveProjectId("http://controller.test", "");
    assert.equal(id, "proj-from-cwd");
    // Only the cwd-based endpoint was hit — the bare project list is
    // skipped when there's no ref to match against.
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("/api/projects?cwd="), `expected cwd endpoint, got ${calls[0]}`);
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("resolveProjectId falls back to cwd when the supplied <project> doesn't match by id or name", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalCwd = process.cwd();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/projects")) {
      // The supplied ref "wrong-name" doesn't match by id or name; the
      // CLI should fall through to the cwd-based lookup.
      return {
        status: 200,
        json: async () => [
          { id: "proj-uuid-1", name: "controller" },
          { id: "proj-uuid-2", name: "demo" },
        ],
      };
    }
    if (String(url).includes("/api/projects?cwd=")) {
      return { status: 200, json: async () => ({ project: { id: "proj-uuid-2", name: "demo" } }) };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  try {
    const id = await cli.resolveProjectId("http://controller.test", "wrong-name");
    // The cwd-resolved project wins, even though the ref didn't match.
    // This is the whole point of the fallback — the orchestrator knows
    // what project the session is in, so an agent's typo'd name
    // shouldn't make `worktrees create` fail.
    assert.equal(id, "proj-uuid-2");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
  }
});

test("resolveProjectId errors with a clear message when no ref and cwd is not part of any project", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ project: null }) });
  try {
    await assert.rejects(
      async () => await cli.resolveProjectId("http://controller.test", ""),
      /__exit__/
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /Could not determine the current project from cwd/);
});

test("resolveProjectId errors with the cwd context when a ref was supplied but didn't match", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/projects")) {
      return {
        status: 200,
        json: async () => [{ id: "proj-uuid-1", name: "controller" }],
      };
    }
    return { status: 200, json: async () => ({ project: null }) };
  };
  try {
    await assert.rejects(
      async () => await cli.resolveProjectId("http://controller.test", "wrong-name"),
      /__exit__/
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /No project matches "wrong-name"/);
  // The error should mention the cwd so the agent understands both
  // halves of the failure (bad ref AND not part of any project).
  assert.ok(
    stderrText.includes(`cwd ${process.cwd()}`),
    `expected stderr to mention cwd ${process.cwd()}, got: ${stderrText}`
  );
});

test("runWorktrees list with no <project> resolves the project from cwd", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/api/projects?cwd=")) {
      return { status: 200, json: async () => ({ project: { id: "proj-from-cwd", name: "FromCwd" } }) };
    }
    if (String(url).endsWith("/api/projects/proj-from-cwd/worktrees")) {
      return {
        status: 200,
        json: async () => [
          { id: "wt-1", name: "main", branch: "main", isMain: true, path: "/tmp/wt/main" },
        ],
      };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runWorktrees(["list"], "http://controller.test");
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  // The cwd-based project lookup is the only project lookup, and the
  // worktree list hits the project id from that lookup.
  assert.ok(calls.some((c) => c.includes("/api/projects?cwd=")), "expected cwd lookup");
  assert.ok(calls.some((c) => c.endsWith("/api/projects/proj-from-cwd/worktrees")), "expected worktree list");
  assert.match(stdoutChunks.join(""), /wt-1  main  main  \[main\]/);
});

test("parseSessions maps start to a session-start payload, including the verbatim message text (issue #355)", async () => {
  const cli = await loadCli();
  // Issue #355: the message is a positional argument, not a `--message`
  // flag. Flags come after the positional in any order.
  const parsed = cli.parseSessions([
    "start",
    "demo",
    "Implement the project-mgmt block",
    "--worktree",
    "wt-123",
    "--provider",
    "codex",
    "--model",
    "gpt-5",
    "--mode",
    "plan",
    "--skill",
    "github-issues",
  ]);
  assert.equal(parsed.project, "demo");
  assert.equal(parsed.action, "start");
  assert.deepEqual(parsed.body, {
    worktreeId: "wt-123",
    message: "Implement the project-mgmt block",
    provider: "codex",
    model: "gpt-5",
    mode: "plan",
    skillName: "github-issues",
  });
});

test("parseSessions accepts the message positional in either order relative to the flags (issue #355)", async () => {
  const cli = await loadCli();
  // Form 1: flags first, message last.
  const flagsFirst = cli.parseSessions([
    "start",
    "demo",
    "--worktree",
    "wt-123",
    "look at issue 190 and implement the CLI surfaces",
  ]);
  assert.equal(flagsFirst.body.message, "look at issue 190 and implement the CLI surfaces");
  assert.equal(flagsFirst.body.worktreeId, "wt-123");
  // Form 2: message first, flags after. The positional scan matches by
  // position, not by being-last-among-flags.
  const messageFirst = cli.parseSessions([
    "start",
    "demo",
    "look at issue 190 and implement the CLI surfaces",
    "--worktree",
    "wt-123",
  ]);
  assert.equal(messageFirst.body.message, "look at issue 190 and implement the CLI surfaces");
  assert.equal(messageFirst.body.worktreeId, "wt-123");
});

test("parseSessions keeps --flag-like tokens literal in the message body (issue #355)", async () => {
  const cli = await loadCli();
  // The prompt is a positional argument, so `--json` / `--help` / etc.
  // inside it stay as part of the message text — no leading-dash
  // escaping needed.
  const parsed = cli.parseSessions([
    "start",
    "demo",
    "--worktree",
    "wt-123",
    "explain --help and run --json on the API",
  ]);
  assert.equal(parsed.body.message, "explain --help and run --json on the API");
  assert.equal(parsed.body.worktreeId, "wt-123");
});

test("parseSessions errors clearly when the message positional is missing (issue #355)", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () =>
        cli.parseSessions([
          "start",
          "demo",
          "--worktree",
          "wt-123",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /Missing message/);
});

test("parseSessions rejects --flag=value shorthand on sessions start (issue #355)", async () => {
  const cli = await loadCli();
  // The positional parser deliberately doesn't expand `--flag=value` —
  // the unknown-flag check should reject it, the same as before. This
  // closes the dual-syntax ambiguity class: only `--flag value` is
  // accepted, and only a single space separator.
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () =>
        cli.parseSessions([
          "start",
          "demo",
          "--worktree=wt-123",
          "hi",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /--worktree=wt-123/);
});

test("parseSessions rejects a stray trailing flag-pair after the message positional (issue #355)", async () => {
  // The new positional shape forbids a second positional: anything after
  // the message must be a `--flag value` pair. A bare `--provider` after
  // the message would be flagged as unknown — closing the issue's
  // "post-message flag guard" with a clearer error and the same
  // `Unknown flag` umbrella used elsewhere.
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    // Wrap in an async fn so the synchronous throw surfaces as a
    // rejection that `assert.rejects` can capture. Issue #355 forbids
    // a second positional: `--provider` after the message positional is
    // a bare token, not a flag pair, and gets rejected by the unknown-
    // flag guard.
    await assert.rejects(
      async () =>
        cli.parseSessions([
          "start",
          "demo",
          "--worktree",
          "wt-123",
          "hi",
          "--bogus",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  // The error must name the offending token so the caller can fix it.
  assert.match(stderrText, /Unknown flag for sessions start/);
  assert.match(stderrText, /--bogus/);
});

test("parseSessions rejects an unknown flag with a clear error listing valid flags (issue #306)", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () =>
        cli.parseSessions([
          "start",
          "--worktree",
          "wt-1",
          "--frobnicate",
          "yes",
          "hi",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /Unknown flag for sessions start/);
  assert.match(stderrText, /--frobnicate/);
  // The error must list the valid flags so the caller can fix the typo
  // without reading the source.
  assert.match(stderrText, /--provider/);
  assert.match(stderrText, /--agent/);
});

test("parseSessions accepts --agent as an alias of --provider (issue #306, #355)", async () => {
  const cli = await loadCli();
  const parsed = cli.parseSessions([
    "start",
    "--worktree",
    "wt-1",
    "--agent",
    "claude",
    "hi",
  ]);
  assert.equal(parsed.body.provider, "claude");
  assert.equal(parsed.body.worktreeId, "wt-1");
  assert.equal(parsed.body.message, "hi");
});

test("parseSessions accepts --agent and --provider when they agree (issue #306, #355)", async () => {
  const cli = await loadCli();
  const parsed = cli.parseSessions([
    "start",
    "--worktree",
    "wt-1",
    "--agent",
    "claude",
    "--provider",
    "claude",
    "hi",
  ]);
  assert.equal(parsed.body.provider, "claude");
});

test("parseSessions rejects --agent and --provider when they disagree (issue #306)", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () =>
        cli.parseSessions([
          "start",
          "--worktree",
          "wt-1",
          "--agent",
          "claude",
          "--provider",
          "codex",
          "hi",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /--provider/);
  assert.match(stderrText, /--agent/);
  assert.match(stderrText, /disagree/);
});

test("runWorktrees delete sends DELETE and reports success", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/projects")) {
      return {
        status: 200,
        json: async () => [{ id: "proj-uuid-2", name: "demo" }],
      };
    }
    if (
      String(url).endsWith("/api/projects/proj-uuid-2/worktrees/wt-123")
    ) {
      return {
        status: 200,
        // Empty body is a valid success shape for DELETE.
        text: async () => "",
      };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runWorktrees(["delete", "demo", "wt-123"], "http://controller.test");
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  const deleteCall = calls.find(
    (c) => c.url === "http://controller.test/api/projects/proj-uuid-2/worktrees/wt-123"
  );
  assert.ok(deleteCall, "expected a request to the worktree delete endpoint");
  // The server registers DELETE for this route; POST would 404.
  assert.equal(deleteCall.init.method, "DELETE");
  assert.match(stdoutChunks.join(""), /Deleted worktree\./);
});

test("runWorktrees list resolves project names to ids and prints one row per worktree", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/projects")) {
      return {
        status: 200,
        json: async () => [
          { id: "proj-uuid-1", name: "controller" },
          { id: "proj-uuid-2", name: "demo" },
        ],
      };
    }
    if (String(url).endsWith("/api/projects/proj-uuid-2/worktrees")) {
      return {
        status: 200,
        json: async () => [
          {
            id: "wt-1",
            name: "main",
            branch: "main",
            isMain: true,
            path: "/tmp/worktrees/proj-uuid-2/main",
            portOffset: 0,
          },
          {
            id: "wt-2",
            name: "issue-190",
            branch: "issue-190",
            isMain: false,
            path: "/tmp/worktrees/proj-uuid-2/issue-190",
            setupExitCode: 0,
          },
        ],
      };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runWorktrees(["list", "demo"], "http://controller.test");
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  // First call lists projects (to resolve name -> id), then the worktree list.
  assert.equal(calls[0].url, "http://controller.test/api/projects");
  assert.equal(calls[1].url, "http://controller.test/api/projects/proj-uuid-2/worktrees");
  const out = stdoutChunks.join("");
  assert.match(out, /wt-1  main  main  \[main\]/);
  assert.match(out, /wt-2  issue-190  issue-190  setup=ok/);
});

test("runSessions start POSTs to the new sessions endpoint and prints the URL", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/projects")) {
      return {
        status: 200,
        json: async () => [{ id: "proj-uuid-1", name: "controller" }],
      };
    }
    return {
      status: 200,
      json: async () => ({
        sessionId: "sess-xyz",
        url: "controller://project/proj-uuid-1/worktree/wt-1/session/sess-xyz",
      }),
    };
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runSessions(
      [
        "start",
        "controller",
        "--worktree",
        "wt-1",
        "work on issue 190",
      ],
      "http://controller.test"
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  const sessionCall = calls.find((c) => c.url.endsWith("/api/projects/proj-uuid-1/sessions"));
  assert.ok(sessionCall, "expected a POST to /api/projects/:projectId/sessions");
  const body = JSON.parse(sessionCall.init.body);
  assert.equal(body.cwd, process.cwd());
  assert.equal(body.worktreeId, "wt-1");
  assert.equal(body.message, "work on issue 190");
  const out = stdoutChunks.join("");
  assert.match(out, /Started session sess-xyz/);
  assert.match(out, /controller:\/\/project\/proj-uuid-1\/worktree\/wt-1\/session\/sess-xyz/);
});

// --- sessions wake (issue #339) ---

test("parseSessions wake builds a wake payload with --delay (issue #355)", async () => {
  const cli = await loadCli();
  // Issue #355: the message is a positional argument. It can come
  // before or after the wake-specific flags.
  const parsed = cli.parseSessions([
    "wake",
    "sess-abc",
    "--delay",
    "30s",
    "Check `gh pr checks 42`",
  ]);
  assert.equal(parsed.action, "wake");
  assert.equal(parsed.sessionId, "sess-abc");
  assert.equal(parsed.body.message, "Check `gh pr checks 42`");
  assert.equal(parsed.body.delay, "30s");
  assert.equal(parsed.body.runAtIso, undefined);
});

test("parseSessions wake accepts the message positional before or after the flags (issue #355)", async () => {
  const cli = await loadCli();
  // Form 1: flags first, message last.
  const flagsFirst = cli.parseSessions([
    "wake",
    "sess-abc",
    "--delay",
    "30s",
    "ring in the new year",
  ]);
  assert.equal(flagsFirst.body.message, "ring in the new year");
  assert.equal(flagsFirst.body.delay, "30s");
  // Form 2: message first, flags after.
  const messageFirst = cli.parseSessions([
    "wake",
    "sess-abc",
    "ring in the new year",
    "--delay",
    "30s",
  ]);
  assert.equal(messageFirst.body.message, "ring in the new year");
  assert.equal(messageFirst.body.delay, "30s");
});

test("parseSessions wake accepts --run-at and rejects combining --delay with --run-at (issue #355)", async () => {
  const cli = await loadCli();
  const parsed = cli.parseSessions([
    "wake",
    "sess-abc",
    "--run-at",
    "2026-12-31T23:59:59.000Z",
    "ring in the new year",
  ]);
  assert.equal(parsed.body.runAtIso, "2026-12-31T23:59:59.000Z");
  assert.equal(parsed.body.delay, undefined);

  // Mutually exclusive: a CLI user shouldn't be able to combine them.
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () =>
        cli.parseSessions([
          "wake",
          "sess-abc",
          "--delay",
          "30s",
          "--run-at",
          "2026-12-31T23:59:59.000Z",
          "x",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /--delay and --run-at are mutually exclusive/);
});

test("parseSessions wake requires sessionId (issue #355)", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () =>
        cli.parseSessions([
          "wake",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /sessions wake requires a sessionId/);
});

test("parseSessions wake errors clearly when the message positional is missing (issue #355)", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () =>
        cli.parseSessions([
          "wake",
          "sess-abc",
          "--delay",
          "30s",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /Missing message/);
});

test("parseSessions wake accepts --agent alias for --provider (issue #355)", async () => {
  const cli = await loadCli();
  const parsed = cli.parseSessions([
    "wake",
    "sess-abc",
    "--agent",
    "claude",
    "hi",
  ]);
  assert.equal(parsed.body.provider, "claude");
});

test("runSessions wake POSTs to the per-session wake endpoint", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    // `runSessions wake` resolves the project from cwd first (matching
    // the other actions), then posts to the per-session wake endpoint.
    // Stub both shapes so the action runs cleanly.
    if (String(url).includes("/api/projects?cwd=")) {
      return {
        status: 200,
        json: async () => ({ project: { id: "proj-from-cwd", name: "FromCwd" } }),
      };
    }
    return {
      status: 201,
      json: async () => ({
        message: {
          id: "wake-1",
          runAt: "2026-06-26T08:00:30.000Z",
        },
      }),
    };
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runSessions(
      [
        "wake",
        "sess-abc",
        "--delay",
        "30s",
        "Check CI",
      ],
      "http://controller.test"
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  const wakeCall = calls.find((c) =>
    c.url.endsWith("/api/sessions/sess-abc/wake")
  );
  assert.ok(wakeCall, "expected a POST to the per-session wake endpoint");
  assert.equal(wakeCall.init.method, "POST");
  const body = JSON.parse(wakeCall.init.body);
  assert.equal(body.message, "Check CI");
  assert.equal(body.delay, "30s");
  const out = stdoutChunks.join("");
  assert.match(out, /Enqueued wake wake-1/);
  assert.match(out, /runs at 2026-06-26T08:00:30.000Z/);
});

// --- sessions goal (issue #339) ---

test("parseGoal set builds a goal payload with --condition and --max-turns", async () => {
  const cli = await loadCli();
  const parsed = cli.parseGoal([
    "set",
    "sess-abc",
    "--condition",
    "all CI checks pass",
    "--max-turns",
    "5",
  ]);
  assert.equal(parsed.action, "set");
  assert.equal(parsed.sessionId, "sess-abc");
  assert.equal(parsed.body.action, "set");
  assert.equal(parsed.body.condition, "all CI checks pass");
  assert.equal(parsed.body.maxTurns, 5);
});

test("parseGoal set rejects a missing --condition", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () => cli.parseGoal(["set", "sess-abc", "--max-turns", "5"]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /requires --condition/);
});

test("parseGoal set rejects a non-positive --max-turns", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = () => true;
  try {
    await assert.rejects(
      async () =>
        cli.parseGoal([
          "set",
          "sess-abc",
          "--condition",
          "x",
          "--max-turns",
          "0",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
});

test("parseGoal clear builds an action=clear payload", async () => {
  const cli = await loadCli();
  const parsed = cli.parseGoal(["clear", "sess-abc"]);
  assert.equal(parsed.action, "clear");
  assert.equal(parsed.sessionId, "sess-abc");
  assert.equal(parsed.body.action, "clear");
});

test("parseGoal show reads via GET on the per-session goal endpoint", async () => {
  const cli = await loadCli();
  const parsed = cli.parseGoal(["show", "sess-abc"]);
  assert.equal(parsed.action, "show");
  assert.equal(parsed.sessionId, "sess-abc");
});

test("runGoal set PUTs the goal payload and prints the condition", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      status: 201,
      json: async () => ({
        goal: {
          sessionId: "sess-abc",
          condition: "all CI checks pass",
          maxTurns: 5,
          turnsEvaluated: 0,
          setAt: "2026-06-26T08:00:00.000Z",
        },
      }),
    };
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runGoal(
      ["set", "sess-abc", "--condition", "all CI checks pass", "--max-turns", "5"],
      "http://controller.test"
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  const setCall = calls.find((c) =>
    c.url.endsWith("/api/sessions/sess-abc/goal")
  );
  assert.ok(setCall, "expected a request to the goal endpoint");
  assert.equal(setCall.init.method, "PUT");
  const body = JSON.parse(setCall.init.body);
  assert.equal(body.action, "set");
  assert.equal(body.condition, "all CI checks pass");
  assert.equal(body.maxTurns, 5);
  const out = stdoutChunks.join("");
  assert.match(out, /Goal set/);
  assert.match(out, /all CI checks pass/);
});

test("runGoal clear PUTs an action=clear payload", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { status: 200, json: async () => ({ goal: null }) };
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runGoal(["clear", "sess-abc"], "http://controller.test");
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  const call = calls.find((c) =>
    c.url.endsWith("/api/sessions/sess-abc/goal")
  );
  assert.ok(call, "expected a request to the goal endpoint");
  assert.equal(call.init.method, "PUT");
  const body = JSON.parse(call.init.body);
  assert.equal(body.action, "clear");
  const out = stdoutChunks.join("");
  assert.match(out, /Goal cleared/);
});

test("runGoal show GETs the goal endpoint and prints the fields", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const stdoutChunks = [];
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({
      goal: {
        sessionId: "sess-abc",
        condition: "all checks pass",
        maxTurns: 5,
        turnsEvaluated: 2,
        lastReason: "still going",
        setAt: "2026-06-26T08:00:00.000Z",
      },
    }),
  });
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runGoal(["show", "sess-abc"], "http://controller.test");
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  const out = stdoutChunks.join("");
  assert.match(out, /condition="all checks pass"/);
  assert.match(out, /maxTurns=5/);
  assert.match(out, /turnsEvaluated=2/);
  assert.match(out, /lastReason="still going"/);
});

// --- sessions monitor (issue #339) ---

test("parseMonitor start builds a monitor payload", async () => {
  const cli = await loadCli();
  const parsed = cli.parseMonitor([
    "start",
    "sess-abc",
    "--description",
    "watch CI",
    "--command",
    "gh pr checks 42 --watch",
    "--timeout-ms",
    "60000",
  ]);
  assert.equal(parsed.action, "start");
  assert.equal(parsed.sessionId, "sess-abc");
  assert.equal(parsed.body.description, "watch CI");
  assert.equal(parsed.body.command, "gh pr checks 42 --watch");
  assert.equal(parsed.body.timeoutMs, 60000);
  assert.equal(parsed.body.persistent, undefined);
});

test("parseMonitor start accepts --persistent", async () => {
  const cli = await loadCli();
  const parsed = cli.parseMonitor([
    "start",
    "sess-abc",
    "--description",
    "long-lived watcher",
    "--command",
    "tail -f /tmp/log",
    "--persistent",
  ]);
  assert.equal(parsed.body.persistent, true);
});

test("parseMonitor start rejects missing description", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = () => true;
  try {
    await assert.rejects(
      async () =>
        cli.parseMonitor([
          "start",
          "sess-abc",
          "--command",
          "watch ci",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
});

test("runMonitor start POSTs to the per-session monitors endpoint", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      status: 201,
      json: async () => ({
        monitor: {
          id: "mon-1",
          sessionId: "sess-abc",
          description: "watch CI",
          command: "gh pr checks 42 --watch",
          lineCount: 0,
          persistent: false,
        },
      }),
    };
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runMonitor(
      [
        "start",
        "sess-abc",
        "--description",
        "watch CI",
        "--command",
        "gh pr checks 42 --watch",
      ],
      "http://controller.test"
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  const call = calls.find((c) =>
    c.url.endsWith("/api/sessions/sess-abc/monitors")
  );
  assert.ok(call, "expected a POST to the per-session monitors endpoint");
  assert.equal(call.init.method, "POST");
  const body = JSON.parse(call.init.body);
  assert.equal(body.description, "watch CI");
  assert.equal(body.command, "gh pr checks 42 --watch");
  const out = stdoutChunks.join("");
  assert.match(out, /Started monitor mon-1/);
  assert.match(out, /description="watch CI"/);
});

test("runMonitor list GETs the per-session monitors endpoint", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url) => {
    calls.push({ url: String(url) });
    return {
      status: 200,
      json: async () => ({
        monitors: [
          {
            id: "mon-1",
            sessionId: "sess-abc",
            description: "watch CI",
            command: "gh pr checks 42 --watch",
            lineCount: 3,
            persistent: false,
          },
        ],
      }),
    };
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runMonitor(["list", "sess-abc"], "http://controller.test");
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  const call = calls.find((c) =>
    c.url.endsWith("/api/sessions/sess-abc/monitors")
  );
  assert.ok(call, "expected a GET to the per-session monitors endpoint");
  const out = stdoutChunks.join("");
  assert.match(out, /mon-1/);
  assert.match(out, /lines=3/);
});

test("runMonitor stop DELETEs the monitor endpoint", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    // `deleteJson` reads `.text()` for the body — match the real
    // Response shape so the helper doesn't crash on a mock.
    return {
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => JSON.stringify({ ok: true }),
    };
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runMonitor(["stop", "mon-1"], "http://controller.test");
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  const call = calls.find((c) =>
    c.url.endsWith("/api/sessions/monitors/mon-1")
  );
  assert.ok(call, "expected a DELETE to the monitor endpoint");
  assert.equal(call.init.method, "DELETE");
  const out = stdoutChunks.join("");
  assert.match(out, /Monitor stopped/);
});

// --- schedules surface (issue #243) ---

test("presetToCron maps structured presets to cron (mirror of server)", async () => {
  const cli = await loadCli();
  assert.equal(cli.presetToCron({ every: "minute" }), "* * * * *");
  assert.equal(cli.presetToCron({ every: "weekday", atHour: 9 }), "0 9 * * 1-5");
  assert.equal(cli.presetToCron({ every: "day", atHour: 8, atMinute: 15 }), "15 8 * * *");
  assert.equal(cli.presetToCron({ onDay: 1, atHour: 7 }), "0 7 * * 1");
  assert.equal(cli.presetToCron({}), null);
});

test("parseSchedules add builds a one-shot payload from --at", async () => {
  const cli = await loadCli();
  const parsed = cli.parseSchedules([
    "add",
    "demo",
    "--worktree",
    "wt-1",
    "--prompt",
    "Run the morning health check",
    "--at",
    "2026-06-26T08:00:00.000Z",
  ]);
  assert.equal(parsed.action, "add");
  assert.deepEqual(parsed.body, {
    worktreeId: "wt-1",
    prompt: "Run the morning health check",
    runAt: "2026-06-26T08:00:00.000Z",
    createdBy: "cli",
  });
});

test("parseSchedules add derives cron from --every/--on-day and forwards an explicit --cron", async () => {
  const cli = await loadCli();
  const derived = cli.parseSchedules([
    "add",
    "demo",
    "--worktree",
    "wt-1",
    "--prompt",
    "standup",
    "--every",
    "weekday",
    "--timezone",
    "America/New_York",
  ]);
  assert.equal(derived.body.cron, "0 9 * * 1-5");
  assert.equal(derived.body.timezone, "America/New_York");

  const explicit = cli.parseSchedules([
    "add",
    "demo",
    "--worktree",
    "wt-1",
    "--prompt",
    "standup",
    "--cron",
    "0 6 * * *",
  ]);
  assert.equal(explicit.body.cron, "0 6 * * *");
});

test("parseSchedules add requires a trigger (--at or --cron/--every)", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () =>
        cli.parseSchedules(["add", "demo", "--worktree", "wt-1", "--prompt", "x"]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /requires --at .* or --cron/);
});

test("parseSchedules add rejects an unknown flag (issue #306)", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () =>
        cli.parseSchedules([
          "add",
          "demo",
          "--worktree",
          "wt-1",
          "--prompt",
          "x",
          "--frobnicate",
          "yes",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /Unknown flag for schedules add/);
  assert.match(stderrText, /--frobnicate/);
  assert.match(stderrText, /--provider/);
  assert.match(stderrText, /--agent/);
});

test("parseSchedules add accepts --agent as an alias of --provider (issue #306)", async () => {
  const cli = await loadCli();
  const parsed = cli.parseSchedules([
    "add",
    "demo",
    "--worktree",
    "wt-1",
    "--prompt",
    "do the thing",
    "--at",
    "2026-06-26T08:00:00.000Z",
    "--agent",
    "claude",
  ]);
  assert.equal(parsed.body.provider, "claude");
});

test("parseSchedules add rejects --agent and --provider when they disagree (issue #306)", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () =>
        cli.parseSchedules([
          "add",
          "demo",
          "--worktree",
          "wt-1",
          "--prompt",
          "x",
          "--at",
          "2026-06-26T08:00:00.000Z",
          "--agent",
          "claude",
          "--provider",
          "codex",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /disagree/);
});

test("parseSchedules list defaults to including disabled", async () => {
  const cli = await loadCli();
  assert.equal(cli.parseSchedules(["list", "demo"]).includeDisabled, true);
  assert.equal(cli.parseSchedules(["list", "demo", "--enabled-only"]).includeDisabled, false);
});

test("runSchedules add resolves the project and POSTs to the schedules endpoint", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/projects")) {
      return { status: 200, json: async () => [{ id: "proj-uuid-1", name: "demo" }] };
    }
    if (String(url).endsWith("/api/projects/proj-uuid-1/schedules")) {
      return {
        status: 201,
        json: async () => ({ id: "sched-1", nextRunAt: "2026-06-26T08:00:00.000Z" }),
      };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runSchedules(
      ["add", "demo", "--worktree", "wt-1", "--prompt", "hi", "--at", "2026-06-26T08:00:00.000Z"],
      "http://controller.test"
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  const postCall = calls.find(
    (c) => c.url === "http://controller.test/api/projects/proj-uuid-1/schedules" && c.init?.method === "POST"
  );
  assert.ok(postCall, "expected a POST to the schedules endpoint");
  const body = JSON.parse(postCall.init.body);
  assert.equal(body.worktreeId, "wt-1");
  assert.equal(body.runAt, "2026-06-26T08:00:00.000Z");
  assert.match(stdoutChunks.join(""), /Created schedule sched-1/);
});

// ---------------------------------------------------------------------------
// integrations create + list --all (issue #279)
// ---------------------------------------------------------------------------

test("parseIntegrations create builds a single-scheme registry payload with a Bearer header attachment", async () => {
  const cli = await loadCli();
  const parsed = cli.parseIntegrations([
    "create",
    "--name",
    "NotionCustom",
    "--transport-mode",
    "rest",
    "--transport-config",
    "baseUrl=https://api.notion.com/v1",
    "--transport-header",
    "Notion-Version=2026-03-11",
    "--scheme-acquisition",
    "static",
    "--scheme-attachment",
    "header:Authorization",
    "--scheme-attachment-prefix",
    "Bearer ",
    "--scheme-secret",
    "secret_xyz",
  ]);
  assert.equal(parsed.action, "create");
  assert.equal(parsed.body.name, "NotionCustom");
  assert.equal(parsed.body.transport.mode, "rest");
  assert.deepEqual(parsed.body.transport.config, { baseUrl: "https://api.notion.com/v1" });
  assert.deepEqual(parsed.body.transport.headers, { "Notion-Version": "2026-03-11" });
  assert.deepEqual(parsed.body.auth.schemes, [
    {
      acquisition: "static",
      attachment: { kind: "header", name: "Authorization", prefix: "Bearer " },
      secret: "secret_xyz",
    },
  ]);
  // `--enabled` is omitted so the server default (true) applies.
  assert.equal("enabled" in parsed.body, false);
});

test("parseIntegrations create supports a multi-scheme AND-set (Trello shape) and forwards --enabled", async () => {
  const cli = await loadCli();
  const parsed = cli.parseIntegrations([
    "create",
    "--name",
    "Trello",
    "--enabled",
    "false",
    "--transport-mode",
    "rest",
    "--transport-config",
    "baseUrl=https://api.trello.com/1",
    "--scheme-acquisition",
    "static",
    "--scheme-attachment",
    "query:key",
    "--scheme-secret",
    "APIKEY",
    "--scheme-acquisition",
    "static",
    "--scheme-attachment",
    "query:token",
    "--scheme-secret",
    "USERTOKEN",
  ]);
  assert.equal(parsed.action, "create");
  assert.equal(parsed.body.enabled, false);
  assert.equal(parsed.body.auth.schemes.length, 2);
  assert.deepEqual(parsed.body.auth.schemes[0], {
    acquisition: "static",
    attachment: { kind: "query", name: "key" },
    secret: "APIKEY",
  });
  assert.deepEqual(parsed.body.auth.schemes[1], {
    acquisition: "static",
    attachment: { kind: "query", name: "token" },
    secret: "USERTOKEN",
  });
});

test("parseIntegrations create rejects invalid transport modes and acquisitions with a clear error", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () =>
        cli.parseIntegrations([
          "create",
          "--name",
          "x",
          "--transport-mode",
          "websocket",
          "--scheme-acquisition",
          "static",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /--transport-mode must be one of/);
  assert.match(stderrText, /websocket/);

  // Reset and test the acquisition validator.
  stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () =>
        cli.parseIntegrations([
          "create",
          "--name",
          "x",
          "--transport-mode",
          "rest",
          "--scheme-acquisition",
          "magic",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /--scheme-acquisition must be one of/);
  assert.match(stderrText, /magic/);
});

test("parseIntegrations create rejects attachments for hmac/mtls/cloud and malformed attachment forms", async () => {
  const cli = await loadCli();
  for (const bad of [
    "--scheme-attachment", "header:Authorization",
    "--scheme-acquisition", "hmac",
  ]) void bad;
  const cases = [
    {
      // hmac is non-attachable.
      argv: [
        "create",
        "--name", "x", "--transport-mode", "rest",
        "--scheme-acquisition", "hmac",
        "--scheme-attachment", "header:Authorization",
      ],
      matches: /--scheme-attachment is not valid for acquisition "hmac"/,
    },
    {
      // missing colon
      argv: [
        "create", "--name", "x", "--transport-mode", "rest",
        "--scheme-acquisition", "static",
        "--scheme-attachment", "header",
      ],
      matches: /--scheme-attachment must be in the form <header\|query>:<name>/,
    },
    {
      // wrong kind
      argv: [
        "create", "--name", "x", "--transport-mode", "rest",
        "--scheme-acquisition", "static",
        "--scheme-attachment", "cookie:session",
      ],
      matches: /--scheme-attachment kind must be "header" or "query"/,
    },
  ];
  for (const { argv, matches } of cases) {
    const originalExit = process.exit;
    const originalStderr = process.stderr.write.bind(process.stderr);
    let exitCode = null;
    let stderrText = "";
    process.exit = (code) => {
      exitCode = code;
      throw new Error("__exit__");
    };
    process.stderr.write = (chunk) => {
      stderrText += String(chunk);
      return true;
    };
    try {
      await assert.rejects(
        async () => cli.parseIntegrations(argv),
        /__exit__/
      );
    } finally {
      process.exit = originalExit;
      process.stderr.write = originalStderr;
    }
    assert.equal(exitCode, 1, `expected ${JSON.stringify(argv)} to fail`);
    assert.match(stderrText, matches, `stderr did not match for ${JSON.stringify(argv)}: ${stderrText}`);
  }
});

test("parseIntegrations create marks --scheme-secret-file and stdin sources for async resolution", async () => {
  const cli = await loadCli();
  const parsed = cli.parseIntegrations([
    "create",
    "--name",
    "x",
    "--transport-mode",
    "rest",
    "--scheme-acquisition",
    "static",
    "--scheme-attachment",
    "header:Authorization",
    "--scheme-secret-file",
    "/tmp/secret.txt",
  ]);
  // The parser leaves a sentinel so the async run path can read the file
  // and patch the secret onto the body before the POST. The sentinel must
  // never reach the wire.
  assert.equal(parsed.body.auth.schemes[0].secret, "");
  assert.deepEqual(parsed.body.auth.schemes[0].__secretSource, {
    kind: "file",
    path: "/tmp/secret.txt",
  });

  const stdinParsed = cli.parseIntegrations([
    "create",
    "--name",
    "x",
    "--transport-mode",
    "rest",
    "--scheme-acquisition",
    "static",
    "--scheme-attachment",
    "header:Authorization",
    "--scheme-secret",
    "-",
  ]);
  assert.equal(stdinParsed.body.auth.schemes[0].secret, "");
  assert.deepEqual(stdinParsed.body.auth.schemes[0].__secretSource, { kind: "stdin" });

  // The shell hands us `--scheme-secret=-` as a single argv token. The
  // documented `echo "$TOKEN" | controller integrations create ...` idiom
  // (PR review from Codex on #281) only works if the parser accepts the
  // `=` form, not just the separate-token form.
  const stdinEquals = cli.parseIntegrations([
    "create",
    "--name", "x",
    "--transport-mode", "rest",
    "--scheme-acquisition=static",
    "--scheme-attachment=header:Authorization",
    "--scheme-secret=-",
  ]);
  assert.equal(stdinEquals.body.auth.schemes[0].secret, "");
  assert.deepEqual(stdinEquals.body.auth.schemes[0].__secretSource, { kind: "stdin" });
});

test("parseIntegrations create accepts --flag=value shorthand for all value flags", async () => {
  const cli = await loadCli();
  const parsed = cli.parseIntegrations([
    "create",
    "--name=myapi",
    "--enabled=false",
    "--transport-mode=rest",
    "--transport-config=baseUrl=https://api.example.com/v1",
    "--transport-header=Accept=application/json",
    "--scheme-acquisition=static",
    "--scheme-id=scheme-1",
    "--scheme-attachment=header:Authorization",
    "--scheme-attachment-prefix=Bearer ",
    "--scheme-config=clientId=abc",
    "--scheme-config=scope=read:all",
    "--scheme-secret=INLINE",
  ]);
  assert.equal(parsed.body.name, "myapi");
  assert.equal(parsed.body.enabled, false);
  assert.equal(parsed.body.transport.mode, "rest");
  assert.deepEqual(parsed.body.transport.config, { baseUrl: "https://api.example.com/v1" });
  assert.deepEqual(parsed.body.transport.headers, { Accept: "application/json" });
  const scheme = parsed.body.auth.schemes[0];
  assert.equal(scheme.id, "scheme-1");
  assert.equal(scheme.acquisition, "static");
  assert.deepEqual(scheme.attachment, { kind: "header", name: "Authorization", prefix: "Bearer " });
  assert.deepEqual(scheme.config, { clientId: "abc", scope: "read:all" });
  assert.equal(scheme.secret, "INLINE");
});

test("parseIntegrations create rejects --scheme-secret and --scheme-secret-file on the same block", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () =>
        cli.parseIntegrations([
          "create", "--name", "x", "--transport-mode", "rest",
          "--scheme-acquisition", "static",
          "--scheme-attachment", "header:Authorization",
          "--scheme-secret", "inline",
          "--scheme-secret-file", "/tmp/secret.txt",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /--scheme-secret and --scheme-secret-file are mutually exclusive/);
});

test("parseIntegrations list --all routes to the registry view, not the gateway", async () => {
  const cli = await loadCli();
  assert.deepEqual(cli.parseIntegrations(["list", "--all"]), {
    action: "registry-list",
    body: { json: false },
  });
  assert.deepEqual(cli.parseIntegrations(["list", "--all", "--json"]), {
    action: "registry-list",
    body: { json: true },
  });
});

test("runIntegrations create POSTs to /api/integrations/, strips secret sentinels, and prints id+name", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      status: 201,
      json: async () => ({
        id: "conn-abc",
        name: "Trello",
        enabled: true,
        transport: { mode: "rest" },
        auth: { schemes: [] },
      }),
    };
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runIntegrations(
      [
        "create",
        "--name", "Trello",
        "--transport-mode", "rest",
        "--scheme-acquisition", "static",
        "--scheme-attachment", "query:key",
        "--scheme-secret", "K",
      ],
      "http://controller.test"
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  assert.equal(calls.length, 1);
  // The registry route is `/api/integrations/`, not the gateway prefix.
  assert.equal(calls[0].url, "http://controller.test/api/integrations/");
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.cwd, process.cwd());
  assert.equal(body.name, "Trello");
  // Sentinel must not reach the wire.
  assert.equal("__secretSource" in body.auth.schemes[0], false);
  assert.equal(body.auth.schemes[0].secret, "K");
  assert.match(stdoutChunks.join(""), /Created integration Trello \(id=conn-abc\) \[mode=rest\]/);
});

test("runIntegrations create reads --scheme-secret-file and never includes the sentinel on the wire", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ctrl-cli-"));
  const secretPath = path.join(dir, "secret.txt");
  await fs.writeFile(secretPath, "TOP-SECRET\n", "utf-8");

  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      status: 201,
      json: async () => ({
        id: "conn-1",
        name: "x",
        enabled: true,
        transport: { mode: "rest" },
        auth: { schemes: [] },
      }),
    };
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runIntegrations(
      [
        "create",
        "--name", "x",
        "--transport-mode", "rest",
        "--scheme-acquisition", "static",
        "--scheme-attachment", "header:Authorization",
        "--scheme-secret-file", secretPath,
      ],
      "http://controller.test"
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
    await fs.rm(dir, { recursive: true, force: true });
  }
  const body = JSON.parse(calls[0].init.body);
  // Trailing newline stripped; sentinel stripped.
  assert.equal(body.auth.schemes[0].secret, "TOP-SECRET");
  assert.equal("__secretSource" in body.auth.schemes[0], false);
  // The file contents must never reach stdout/stderr via the CLI's writes.
  for (const chunk of stdoutChunks) {
    assert.ok(!chunk.includes("TOP-SECRET"), `secret leaked to stdout: ${chunk}`);
  }
});

test("runIntegrations create with --scheme-secret=- reads from stdin and never echoes the value", async () => {
  // Regression test for the PR review from Codex on #281: the
  // documented `echo "$TOKEN" | controller integrations create ...` form
  // only works if `--scheme-secret=-` is accepted as a single argv token
  // and the secret is read from stdin at submit time.
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);

  // Feed stdin a known value. `process.stdin` is a TTY in the test
  // runner, so we patch the readable factory with a one-shot stream.
  const { Readable } = await import("node:stream");
  const originalStdin = process.stdin;
  const fakeStdin = Readable.from(["FROM-STDIN\n"]);
  Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });

  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      status: 201,
      json: async () => ({
        id: "conn-1",
        name: "x",
        enabled: true,
        transport: { mode: "rest" },
        auth: { schemes: [] },
      }),
    };
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runIntegrations(
      [
        "create",
        "--name", "x",
        "--transport-mode", "rest",
        "--scheme-acquisition", "static",
        "--scheme-attachment", "header:Authorization",
        "--scheme-secret=-",
      ],
      "http://controller.test"
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
  }
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  // Trailing newline stripped; sentinel stripped.
  assert.equal(body.auth.schemes[0].secret, "FROM-STDIN");
  assert.equal("__secretSource" in body.auth.schemes[0], false);
  for (const chunk of stdoutChunks) {
    assert.ok(!chunk.includes("FROM-STDIN"), `secret leaked to stdout: ${chunk}`);
  }
});

test("runIntegrations list --all GETs the registry endpoint and prints full records", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      status: 200,
      json: async () => ([
        {
          id: "conn-1",
          name: "Notion",
          enabled: true,
          transport: { mode: "rest" },
          auth: { schemes: [{ id: "s1", acquisition: "static", hasSecret: true, config: {}, attachment: { kind: "header", name: "Authorization" } }] },
        },
        {
          id: "conn-2",
          name: "Disabled",
          enabled: false,
          transport: { mode: "cli" },
          auth: { schemes: [] },
        },
      ]),
    };
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runIntegrations(["list", "--all"], "http://controller.test");
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://controller.test/api/integrations/");
  // GET, not POST (the registry index is read-only).
  assert.equal(calls[0].init, undefined);
  const out = stdoutChunks.join("");
  assert.match(out, /conn-1  Notion  \[enabled\]  rest/);
  assert.match(out, /conn-2  Disabled  \[disabled\]  cli/);
  // Secret values must not appear (and the server never returns them anyway).
  assert.ok(!out.includes("secret"));
});

// ---------------------------------------------------------------------------
// `controller browser` parser (issue #323)
// ---------------------------------------------------------------------------

test("parseBrowser builds an open command without --insecure by default", async () => {
  const cli = await loadCli();
  assert.deepEqual(
    cli.parseBrowser(["open", "https://localhost:5050"]),
    { action: "open", params: { url: "https://localhost:5050", insecure: false } }
  );
});

test("parseBrowser extracts --insecure on open", async () => {
  const cli = await loadCli();
  assert.deepEqual(
    cli.parseBrowser(["open", "--insecure", "https://localhost:5050"]),
    { action: "open", params: { url: "https://localhost:5050", insecure: true } }
  );
});

test("parseBrowser accepts --insecure after the URL", async () => {
  const cli = await loadCli();
  assert.deepEqual(
    cli.parseBrowser(["open", "https://localhost:5050", "--insecure"]),
    { action: "open", params: { url: "https://localhost:5050", insecure: true } }
  );
});

test("parseBrowser snapshot / click / type still work", async () => {
  const cli = await loadCli();
  assert.deepEqual(
    cli.parseBrowser(["snapshot", "--a11y", "text=Cancel"]),
    { action: "snapshot", params: { selector: "text=Cancel", a11y: true } }
  );
  assert.deepEqual(
    cli.parseBrowser(["click", "ref=e3"]),
    { action: "click", params: { selector: "ref=e3" } }
  );
  assert.deepEqual(
    cli.parseBrowser(["type", "input[name=q]", "hello", "--submit"]),
    { action: "type", params: { selector: "input[name=q]", text: "hello", submit: true } }
  );
});

// --- sessions list (issue #353) ---

test("parseSessions list builds a list payload from the new flags", async () => {
  const cli = await loadCli();
  const parsed = cli.parseSessions([
    "list",
    "demo",
    "--worktree",
    "wt-1",
    "--parent",
    "sess-parent",
    "--provider",
    "codex",
    "--json",
    "--limit",
    "25",
  ]);
  assert.equal(parsed.project, "demo");
  assert.equal(parsed.action, "list");
  assert.deepEqual(parsed.body, {
    worktreeId: "wt-1",
    parentId: "sess-parent",
    provider: "codex",
    json: true,
    limit: 25,
  });
});

test("parseSessions list accepts a missing <project> (resolved from cwd)", async () => {
  const cli = await loadCli();
  const parsed = cli.parseSessions(["list"]);
  assert.equal(parsed.project, "");
  assert.equal(parsed.action, "list");
  // No flags supplied → body should be the empty shape so the dispatcher
  // can spread it without surprises.
  assert.deepEqual(parsed.body, {});
});

test("parseSessions list rejects an unknown flag with a clear error (issue #306)", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () => cli.parseSessions(["list", "--online"]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /Unknown flag for sessions list/);
  assert.match(stderrText, /--online/);
  // The error must list the valid flags so the caller can fix the typo
  // without reading the source.
  assert.match(stderrText, /--worktree/);
  assert.match(stderrText, /--parent/);
  assert.match(stderrText, /--json/);
});

test("parseSessions list rejects a non-positive --limit with a clear error", async () => {
  const cli = await loadCli();
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () => cli.parseSessions(["list", "--limit", "0"]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /--limit must be a positive integer/);
});

test("parseSessions start --parent self resolves via $CONTROLLER_SESSION_ID (issue #353, #355)", async () => {
  const cli = await loadCli();
  const savedEnv = process.env.CONTROLLER_SESSION_ID;
  process.env.CONTROLLER_SESSION_ID = "sess-self-42";
  try {
    const parsed = cli.parseSessions([
      "start",
      "--worktree",
      "wt-1",
      "--parent",
      "self",
      "spawn a child",
    ]);
    assert.equal(parsed.action, "start");
    assert.equal(parsed.body.parentId, "sess-self-42");
  } finally {
    if (savedEnv === undefined) delete process.env.CONTROLLER_SESSION_ID;
    else process.env.CONTROLLER_SESSION_ID = savedEnv;
  }
});

test("parseSessions start --parent self surfaces a clear error when CONTROLLER_SESSION_ID is unset (issue #353, #355)", async () => {
  const cli = await loadCli();
  const savedEnv = process.env.CONTROLLER_SESSION_ID;
  delete process.env.CONTROLLER_SESSION_ID;
  const originalExit = process.exit;
  const originalStderr = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  let stderrText = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (chunk) => {
    stderrText += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () =>
        cli.parseSessions([
          "start",
          "--worktree",
          "wt-1",
          "--parent",
          "self",
          "spawn a child",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
    if (savedEnv !== undefined) process.env.CONTROLLER_SESSION_ID = savedEnv;
  }
  assert.equal(exitCode, 1);
  assert.match(stderrText, /CONTROLLER_SESSION_ID/);
  assert.match(stderrText, /controller sessions list/);
});

test("parseSessions list --parent self resolves via $CONTROLLER_SESSION_ID (issue #353)", async () => {
  const cli = await loadCli();
  const savedEnv = process.env.CONTROLLER_SESSION_ID;
  process.env.CONTROLLER_SESSION_ID = "sess-self-99";
  try {
    const parsed = cli.parseSessions(["list", "--parent", "self"]);
    assert.equal(parsed.action, "list");
    assert.equal(parsed.body.parentId, "sess-self-99");
  } finally {
    if (savedEnv === undefined) delete process.env.CONTROLLER_SESSION_ID;
    else process.env.CONTROLLER_SESSION_ID = savedEnv;
  }
});

test("parseSessions start passes an explicit --parent through unchanged (issue #355)", async () => {
  // The `self` alias is the only string substitution on `--parent`;
  // any other value is forwarded verbatim so the server can use it
  // directly. This guards against a future refactor that tries to
  // resolve the value client-side (e.g. via `locateSessionById`).
  const cli = await loadCli();
  const parsed = cli.parseSessions([
    "start",
    "--worktree",
    "wt-1",
    "--parent",
    "sess-explicit",
    "hi",
  ]);
  assert.equal(parsed.body.parentId, "sess-explicit");
});

test("parseSessions start without --parent omits the body field (issue #355)", async () => {
  // The start POST endpoint distinguishes "no parent" (absent key) from
  // "parent is empty string" — make sure the CLI doesn't accidentally
  // send a parentId: "" when the flag is missing.
  const cli = await loadCli();
  const parsed = cli.parseSessions([
    "start",
    "--worktree",
    "wt-1",
    "hi",
  ]);
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed.body, "parentId"),
    false,
    "parentId should be absent when --parent is not provided"
  );
});

test("runSessions list GETs the per-worktree session list and prints one row per match (issue #353)", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/projects")) {
      return {
        status: 200,
        json: async () => [{ id: "proj-uuid-1", name: "controller" }],
      };
    }
    if (
      String(url).endsWith(
        "/api/projects/proj-uuid-1/sessions?worktreeId=wt-1"
      )
    ) {
      return {
        status: 200,
        json: async () => [
          {
            id: "sess-a",
            title: "Triage issue 190",
            provider: "codex",
            worktreeId: "wt-1",
            parentId: "sess-parent",
            lastActiveAt: "2026-09-13T10:00:00.000Z",
          },
          {
            id: "sess-b",
            title: "Review PR #42",
            provider: "claude",
            worktreeId: "wt-1",
            lastActiveAt: "2026-09-12T09:00:00.000Z",
          },
        ],
      };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runSessions(
      ["list", "controller", "--worktree", "wt-1"],
      "http://controller.test"
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  // The per-worktree list endpoint is hit directly because --worktree
  // is supplied (no need to walk every worktree).
  assert.ok(
    calls.some((c) =>
      c.endsWith("/api/projects/proj-uuid-1/sessions?worktreeId=wt-1")
    ),
    "expected a GET to the per-worktree sessions endpoint"
  );
  const out = stdoutChunks.join("");
  // Both rows print, one per line.
  assert.match(out, /sess-a\s+\[codex\]\s+Triage issue 190/);
  assert.match(out, /sess-b\s+\[claude\]\s+Review PR #42/);
  // The parent link is surfaced so a coordinator can see children at a glance.
  assert.match(out, /parent=sess-parent/);
});

test("runSessions list applies the --parent filter client-side (issue #353)", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const calls = [];
  const stdoutChunks = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/projects")) {
      return {
        status: 200,
        json: async () => [{ id: "proj-uuid-1", name: "controller" }],
      };
    }
    if (String(url).endsWith("/api/projects/proj-uuid-1/worktrees")) {
      return {
        status: 200,
        json: async () => [
          { id: "wt-1", name: "main", isMain: true },
          { id: "wt-2", name: "feature", isMain: false },
        ],
      };
    }
    if (String(url).includes("/api/projects/proj-uuid-1/sessions?worktreeId=")) {
      const worktreeId = new URL(url).searchParams.get("worktreeId");
      // The parent lives on the main worktree, the child on the feature
      // worktree — exactly the cross-worktree case #351's fix addressed.
      // The CLI must walk both and pick out the child by `parentId`.
      if (worktreeId === "wt-1") {
        return {
          status: 200,
          json: async () => [
            {
              id: "sess-parent",
              title: "Coordinator",
              provider: "codex",
              worktreeId: "wt-1",
              lastActiveAt: "2026-09-13T09:00:00.000Z",
            },
            {
              id: "sess-other-on-main",
              title: "Unrelated",
              provider: "claude",
              worktreeId: "wt-1",
              lastActiveAt: "2026-09-13T08:00:00.000Z",
            },
          ],
        };
      }
      if (worktreeId === "wt-2") {
        return {
          status: 200,
          json: async () => [
            {
              id: "sess-child",
              title: "Fix the bug",
              provider: "claude",
              worktreeId: "wt-2",
              parentId: "sess-parent",
              lastActiveAt: "2026-09-13T10:00:00.000Z",
            },
            {
              id: "sess-other-on-feature",
              title: "Another",
              provider: "codex",
              worktreeId: "wt-2",
              lastActiveAt: "2026-09-12T10:00:00.000Z",
            },
          ],
        };
      }
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runSessions(
      ["list", "controller", "--parent", "sess-parent"],
      "http://controller.test"
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  // Both worktrees are walked; the CLI does not assume a single
  // per-project session store.
  assert.ok(
    calls.some((c) => c.endsWith("/api/projects/proj-uuid-1/worktrees")),
    "expected a GET to the worktrees endpoint to enumerate them"
  );
  assert.ok(
    calls.some((c) =>
      c.endsWith("/api/projects/proj-uuid-1/sessions?worktreeId=wt-1")
    ),
    "expected a walk of the main worktree's sessions"
  );
  assert.ok(
    calls.some((c) =>
      c.endsWith("/api/projects/proj-uuid-1/sessions?worktreeId=wt-2")
    ),
    "expected a walk of the feature worktree's sessions"
  );
  const out = stdoutChunks.join("");
  // Only the child matches; the parent, the other-on-main, and the
  // other-on-feature are filtered out client-side. The child row
  // legitimately contains the parent's id in `parent=<id>` so we
  // assert on the formatted provider tags and titles, not the parent
  // id text appearing anywhere in the output.
  assert.match(out, /sess-child/);
  assert.match(out, /Fix the bug/);
  // The other sessions' titles should not appear (Coordinator = the
  // parent's title; Unrelated / Another = the other two siblings).
  assert.doesNotMatch(out, /Coordinator/);
  assert.doesNotMatch(out, /Unrelated/);
  assert.doesNotMatch(out, /Another/);
  // The parent's own id appears as a column value for the child, so
  // check that it does not appear in the row-leading id slot.
  assert.doesNotMatch(out, /^sess-parent /m);
  assert.doesNotMatch(out, /^sess-other-on-main /m);
  assert.doesNotMatch(out, /^sess-other-on-feature /m);
});

test("runSessions list applies the --provider filter client-side (issue #353)", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/projects")) {
      return {
        status: 200,
        json: async () => [{ id: "proj-uuid-1", name: "controller" }],
      };
    }
    if (String(url).endsWith("/api/projects/proj-uuid-1/worktrees")) {
      return {
        status: 200,
        json: async () => [{ id: "wt-1", name: "main", isMain: true }],
      };
    }
    if (String(url).includes("/api/projects/proj-uuid-1/sessions?worktreeId=")) {
      return {
        status: 200,
        json: async () => [
          {
            id: "sess-codex",
            title: "Codex session",
            provider: "codex",
            worktreeId: "wt-1",
            lastActiveAt: "2026-09-13T10:00:00.000Z",
          },
          {
            id: "sess-claude",
            title: "Claude session",
            provider: "claude",
            worktreeId: "wt-1",
            lastActiveAt: "2026-09-12T10:00:00.000Z",
          },
        ],
      };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  const stdoutChunks = [];
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runSessions(
      ["list", "controller", "--provider", "codex"],
      "http://controller.test"
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  const out = stdoutChunks.join("");
  assert.match(out, /sess-codex/);
  assert.doesNotMatch(out, /sess-claude/);
});

test("runSessions list --json emits NDJSON (issue #353)", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/projects")) {
      return {
        status: 200,
        json: async () => [{ id: "proj-uuid-1", name: "controller" }],
      };
    }
    if (String(url).endsWith("/api/projects/proj-uuid-1/worktrees")) {
      return {
        status: 200,
        json: async () => [{ id: "wt-1", name: "main", isMain: true }],
      };
    }
    if (String(url).includes("/api/projects/proj-uuid-1/sessions?worktreeId=")) {
      return {
        status: 200,
        json: async () => [
          {
            id: "sess-a",
            title: "First",
            provider: "codex",
            worktreeId: "wt-1",
            lastActiveAt: "2026-09-13T10:00:00.000Z",
          },
          {
            id: "sess-b",
            title: "Second",
            provider: "claude",
            worktreeId: "wt-1",
            lastActiveAt: "2026-09-12T10:00:00.000Z",
          },
        ],
      };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  const stdoutChunks = [];
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runSessions(
      ["list", "controller", "--json"],
      "http://controller.test"
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  const lines = stdoutChunks.join("").split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  const second = JSON.parse(lines[1]);
  assert.equal(first.id, "sess-a");
  assert.equal(first.title, "First");
  assert.equal(second.id, "sess-b");
  assert.equal(second.title, "Second");
});

test("runSessions list prints 'No sessions match.' for an empty filter result (issue #353)", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/projects")) {
      return {
        status: 200,
        json: async () => [{ id: "proj-uuid-1", name: "controller" }],
      };
    }
    if (String(url).endsWith("/api/projects/proj-uuid-1/worktrees")) {
      return {
        status: 200,
        json: async () => [{ id: "wt-1", name: "main", isMain: true }],
      };
    }
    if (String(url).includes("/api/projects/proj-uuid-1/sessions?worktreeId=")) {
      return { status: 200, json: async () => [] };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  const stdoutChunks = [];
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runSessions(
      ["list", "controller", "--parent", "no-children-here"],
      "http://controller.test"
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  assert.equal(stdoutChunks.join(""), "No sessions match.\n");
});

test("runSessions list --json emits nothing on an empty filter result (PR #354 review)", async () => {
  // The PR #354 review pointed out that the human-only `No sessions
  // match.` copy broke NDJSON pipelines on a legitimate zero-result
  // query — `jq` could not parse a string literal where it expected a
  // JSON object. `--json` mode must emit zero records (no stdout
  // writes at all) so consumers can iterate / count rows without
  // special-casing the empty case. Exit code is still 0 so a
  // zero-result query is not an error.
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalExit = process.exit;
  let exitCode = null;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/projects")) {
      return {
        status: 200,
        json: async () => [{ id: "proj-uuid-1", name: "controller" }],
      };
    }
    if (String(url).endsWith("/api/projects/proj-uuid-1/worktrees")) {
      return {
        status: 200,
        json: async () => [{ id: "wt-1", name: "main", isMain: true }],
      };
    }
    if (String(url).includes("/api/projects/proj-uuid-1/sessions?worktreeId=")) {
      return { status: 200, json: async () => [] };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  const stdoutChunks = [];
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  process.exit = (code) => {
    exitCode = code;
  };
  try {
    await cli.runSessions(
      ["list", "controller", "--parent", "no-children-here", "--json"],
      "http://controller.test"
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
    process.exit = originalExit;
  }
  // Empty output, no human-only copy mixed in. NDJSON consumers
  // (jq, wc -l, xargs) treat this as "zero rows" naturally.
  assert.equal(
    stdoutChunks.join(""),
    "",
    "an empty --json filter result must produce no stdout writes"
  );
  assert.notEqual(exitCode, 1, "an empty result is not an error");
});

test("runSessions list enforces --limit by truncating the result set (issue #353)", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write.bind(process.stdout);
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/projects")) {
      return {
        status: 200,
        json: async () => [{ id: "proj-uuid-1", name: "controller" }],
      };
    }
    if (String(url).endsWith("/api/projects/proj-uuid-1/worktrees")) {
      return {
        status: 200,
        json: async () => [{ id: "wt-1", name: "main", isMain: true }],
      };
    }
    if (String(url).includes("/api/projects/proj-uuid-1/sessions?worktreeId=")) {
      // Five rows; --limit 2 should keep the two most-recent.
      return {
        status: 200,
        json: async () => [
          { id: "sess-1", title: "1", provider: "codex", worktreeId: "wt-1", lastActiveAt: "2026-09-13T10:00:00.000Z" },
          { id: "sess-2", title: "2", provider: "codex", worktreeId: "wt-1", lastActiveAt: "2026-09-12T10:00:00.000Z" },
          { id: "sess-3", title: "3", provider: "codex", worktreeId: "wt-1", lastActiveAt: "2026-09-11T10:00:00.000Z" },
          { id: "sess-4", title: "4", provider: "codex", worktreeId: "wt-1", lastActiveAt: "2026-09-10T10:00:00.000Z" },
          { id: "sess-5", title: "5", provider: "codex", worktreeId: "wt-1", lastActiveAt: "2026-09-09T10:00:00.000Z" },
        ],
      };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  const stdoutChunks = [];
  process.stdout.write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  try {
    await cli.runSessions(
      ["list", "controller", "--limit", "2"],
      "http://controller.test"
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
  }
  const out = stdoutChunks.join("");
  assert.match(out, /sess-1/);
  assert.match(out, /sess-2/);
  assert.doesNotMatch(out, /sess-3/);
  assert.doesNotMatch(out, /sess-4/);
  assert.doesNotMatch(out, /sess-5/);
});

test("runSessions start forwards --parent on the POST body (issue #353)", async () => {
  const cli = await loadCli();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/projects")) {
      return {
        status: 200,
        json: async () => [{ id: "proj-uuid-1", name: "controller" }],
      };
    }
    return {
      status: 200,
      json: async () => ({
        sessionId: "sess-child",
        url: "controller://project/proj-uuid-1/worktree/wt-1/session/sess-child",
      }),
    };
  };
  try {
    await cli.runSessions(
      [
        "start",
        "controller",
        "--worktree",
        "wt-1",
        "--parent",
        "sess-parent",
        "spawn a child",
      ],
      "http://controller.test"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  const postCall = calls.find(
    (c) => c.url === "http://controller.test/api/projects/proj-uuid-1/sessions"
  );
  assert.ok(postCall, "expected a POST to the sessions endpoint");
  assert.equal(postCall.init.method, "POST");
  const body = JSON.parse(postCall.init.body);
  assert.equal(body.parentId, "sess-parent");
  assert.equal(body.worktreeId, "wt-1");
  assert.equal(body.message, "spawn a child");
});
