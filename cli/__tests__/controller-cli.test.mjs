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

test("runIntegrations POSTs to /api/integrations/<endpoint> and prints the result", async () => {
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
  assert.equal(calls[0].url, "http://controller.test/api/integrations/list");
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