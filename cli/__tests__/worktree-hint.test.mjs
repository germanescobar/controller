/*
 * Issue #367: the CLI has to surface the server's `hint` field, not just
 * `error`. `sessions list --worktree <projectId>` used to print a bare
 * `Error: Worktree not found`, which told the agent nothing about the
 * mistake it had actually made.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const controllerUrl = pathToFileURL(path.join(repoRoot, "cli", "controller")).href;

async function loadCli() {
  return import(`${controllerUrl}?t=${Date.now()}-${Math.random()}`);
}

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";

/*
 * Run `fn` with `fetch`, `process.exit` and `process.stderr.write` stubbed.
 * `fail()` calls `process.exit(1)`, which would tear down the test runner,
 * so the stub throws a sentinel the caller unwinds to instead.
 */
async function captureFailure(routes, fn) {
  const realFetch = globalThis.fetch;
  const realExit = process.exit;
  const realWrite = process.stderr.write;
  const stderr = [];
  const sentinel = new Error("process.exit");
  globalThis.fetch = async (url) => {
    const route = new URL(url).pathname + (new URL(url).search ?? "");
    for (const [pattern, respond] of routes) {
      if (route.startsWith(pattern)) return respond(route);
    }
    throw new Error(`unexpected fetch: ${route}`);
  };
  process.exit = () => {
    throw sentinel;
  };
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } catch (error) {
    if (error !== sentinel) throw error;
  } finally {
    globalThis.fetch = realFetch;
    process.exit = realExit;
    process.stderr.write = realWrite;
  }
  return stderr.join("");
}

function jsonResponse(status, body) {
  return {
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("serverError appends the server hint to the error line", async () => {
  const cli = await loadCli();
  assert.equal(
    cli.serverError(
      { error: "Worktree not found", hint: "abc is a project id, not a worktree id." },
      "fallback"
    ),
    "Worktree not found. abc is a project id, not a worktree id."
  );
});

test("serverError is a no-op when the body carries no hint", async () => {
  const cli = await loadCli();
  assert.equal(cli.serverError({ error: "Worktree not found" }, "fallback"), "Worktree not found");
  assert.equal(cli.serverError(null, "fallback"), "fallback");
  assert.equal(cli.serverError({}, "fallback"), "fallback");
});

test("serverError does not double up sentence punctuation", async () => {
  const cli = await loadCli();
  assert.equal(cli.serverError({ error: "Nope.", hint: "Try harder." }, "f"), "Nope. Try harder.");
});

test("sessions list --worktree <projectId> prints the project-id hint", async () => {
  const cli = await loadCli();
  const hint =
    `${PROJECT_ID} is a project id, not a worktree id. ` +
    `Use 'controller worktrees list ${PROJECT_ID}' to discover worktree ids.`;
  const stderr = await captureFailure(
    [
      [
        "/api/projects",
        (route) =>
          route.includes("/sessions")
            ? jsonResponse(404, { error: "Worktree not found", hint })
            : jsonResponse(200, [{ id: PROJECT_ID, name: "demo", path: "/tmp/demo" }]),
      ],
    ],
    () => cli.runSessions(["list", PROJECT_ID, "--worktree", PROJECT_ID], "http://127.0.0.1:1")
  );
  assert.equal(stderr, `Error: Worktree not found. ${hint}\n`);
});

test("sessions list keeps the bare error when the server sends no hint", async () => {
  const cli = await loadCli();
  const stderr = await captureFailure(
    [
      [
        "/api/projects",
        (route) =>
          route.includes("/sessions")
            ? jsonResponse(404, { error: "Worktree not found" })
            : jsonResponse(200, [{ id: PROJECT_ID, name: "demo", path: "/tmp/demo" }]),
      ],
    ],
    () => cli.runSessions(["list", PROJECT_ID, "--worktree", "nope"], "http://127.0.0.1:1")
  );
  assert.equal(stderr, "Error: Worktree not found\n");
});
