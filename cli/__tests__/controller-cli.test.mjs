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
  assert.deepEqual(cli.parseIntegrations(["list"]), { endpoint: "list", body: {} });
  assert.deepEqual(
    cli.parseIntegrations(["search", "openapi", "auth"]),
    { endpoint: "search", body: { query: "openapi auth" } }
  );
  assert.deepEqual(
    cli.parseIntegrations(["call", "Trello", "createCard", "--json", '{"idList":"abc"}']),
    { endpoint: "call", body: { integration: "Trello", tool: "createCard", args: { idList: "abc" } } }
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

test("parseSessions maps start to a session-start payload, including the verbatim --message text", async () => {
  const cli = await loadCli();
  const parsed = cli.parseSessions([
    "start",
    "demo",
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
    "--message",
    "Implement the project-mgmt block",
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

test("parseSessions treats the message as the rest of argv (whitespace + trailing args stay verbatim)", async () => {
  const cli = await loadCli();
  // Simulate the shell joining a quoted multi-word message plus an extra
  // trailing argument — `--message`'s value is everything after the flag.
  const parsed = cli.parseSessions([
    "start",
    "demo",
    "--worktree",
    "wt-123",
    "--message",
    "look at issue 190 and",
    "implement",
    "the CLI surfaces",
  ]);
  assert.equal(parsed.body.message, "look at issue 190 and implement the CLI surfaces");
});

test("parseSessions rejects a reserved flag that appears after --message", async () => {
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
    // rejection that `assert.rejects` can capture.
    await assert.rejects(
      async () =>
        cli.parseSessions([
          "start",
          "demo",
          "--worktree",
          "wt-123",
          "--message",
          "hi",
          "--provider",
          "anita",
        ]),
      /__exit__/
    );
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
  }
  assert.equal(exitCode, 1);
  // The error must name the offending flag so the caller can fix it.
  assert.match(stderrText, /--message must be the last flag/);
  assert.match(stderrText, /--provider/);
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
        "--message",
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
