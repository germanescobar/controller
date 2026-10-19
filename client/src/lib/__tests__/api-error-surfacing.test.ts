import test from "node:test";
import assert from "node:assert/strict";
import * as api from "../../api.ts";

/*
 * Issue #456: these helpers used to call `res.json()` without checking
 * `res.ok`, so a server `{ error }` body reached the UI typed as a
 * success value (e.g. `(await fetchWorktrees(id)).filter` throwing
 * `.filter is not a function` on a 404). Each one must now reject with
 * the server's error text on any 4xx/5xx.
 */

interface HelperCase {
  name: string;
  call: () => Promise<unknown>;
}

const CASES: HelperCase[] = [
  { name: "createProject", call: () => api.createProject("p", "/bad/path") },
  { name: "updateProject", call: () => api.updateProject("proj-1", { name: "p" }) },
  { name: "deleteProject", call: () => api.deleteProject("proj-1") },
  { name: "fetchSessions", call: () => api.fetchSessions("proj-1", "wt-1") },
  { name: "fetchWorktrees", call: () => api.fetchWorktrees("proj-1") },
  { name: "fetchBranches", call: () => api.fetchBranches("proj-1") },
  { name: "fetchGitDiff", call: () => api.fetchGitDiff("proj-1", "wt-1") },
  { name: "fetchBranchDiff", call: () => api.fetchBranchDiff("proj-1", "wt-1") },
  { name: "fetchPullRequest", call: () => api.fetchPullRequest("proj-1", "wt-1") },
  { name: "fetchAgents", call: () => api.fetchAgents() },
  { name: "fetchAgentProviders", call: () => api.fetchAgentProviders() },
  { name: "fetchModels", call: () => api.fetchModels("claude") },
  { name: "fetchProviders", call: () => api.fetchProviders() },
  { name: "fetchShortcutBindings", call: () => api.fetchShortcutBindings() },
  { name: "saveShortcutBindings", call: () => api.saveShortcutBindings({}) },
  { name: "resetShortcutBindings", call: () => api.resetShortcutBindings() },
  { name: "stopSession", call: () => api.stopSession("proj-1", "s-1", "wt-1") },
  { name: "steerSession", call: () => api.steerSession("proj-1", "s-1", "hi", "wt-1") },
  {
    name: "submitSessionUserInput",
    call: () => api.submitSessionUserInput("proj-1", "s-1", { q: "a" }, "wt-1"),
  },
  {
    name: "submitToolApproval",
    call: () => api.submitToolApproval("proj-1", "s-1", "req-1", "deny", "wt-1"),
  },
  {
    name: "dismissSessionUserInput",
    call: () => api.dismissSessionUserInput("proj-1", "s-1", "wt-1"),
  },
];

const STATUSES = [400, 404, 500];

function stubFetch(response: () => Response): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response()) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

for (const { name, call } of CASES) {
  for (const status of STATUSES) {
    test(`${name} rejects with the server error on ${status}`, async () => {
      const message = `${name} boom ${status}`;
      const restore = stubFetch(
        () =>
          new Response(JSON.stringify({ error: message }), {
            status,
            headers: { "content-type": "application/json" },
          }),
      );
      try {
        await assert.rejects(call(), { message });
      } finally {
        restore();
      }
    });
  }

  test(`${name} rejects with a plain-text server error`, async () => {
    const restore = stubFetch(() => new Response("upstream exploded", { status: 502 }));
    try {
      await assert.rejects(call(), { message: "upstream exploded" });
    } finally {
      restore();
    }
  });
}
