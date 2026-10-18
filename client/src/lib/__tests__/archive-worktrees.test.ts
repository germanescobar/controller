import test from "node:test";
import assert from "node:assert/strict";

/*
 * Tests for the dedicated archive view's API surface:
 *   • `fetchWorktrees(projectId, { includeRemoved: true })` opts
 *     in to the unfiltered registry.
 *   • `restoreWorktree` posts to the new `/restore` endpoint.
 *   • `purgeWorktree` deletes via the new `/purge` endpoint and
 *     treats 404 as a no-op (idempotent against a re-purge from
 *     a second tab).
 *
 * The same stub-`fetch` pattern as `delete-worktree.test.ts`: we
 * swap `globalThis.fetch` for the duration of the test so the
 * existing API client can be exercised without a real server.
 */

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function installFetchMock(
  handler: (call: FetchCall) => Response,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler({ url, init });
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ORIGINAL_BASE = process.env.CONTROLLER_BASE_URL;

test.after(() => {
  if (ORIGINAL_BASE === undefined) delete process.env.CONTROLLER_BASE_URL;
  else process.env.CONTROLLER_BASE_URL = ORIGINAL_BASE;
});

test("fetchWorktrees appends ?includeRemoved=1 when opted in", async () => {
  const mock = installFetchMock(() =>
    jsonResponse(200, [{ id: "wt-1", presence: "removed" }]),
  );
  try {
    const { fetchWorktrees } = await import("../../api.ts");
    const rows = await fetchWorktrees("proj-1", { includeRemoved: true });
    assert.equal(mock.calls.length, 1);
    assert.match(mock.calls[0].url, /[?&]includeRemoved=1(\b|&|$)/);
    assert.equal(rows.length, 1);
  } finally {
    mock.restore();
  }
});

test("fetchWorktrees omits the includeRemoved flag by default", async () => {
  const mock = installFetchMock(() => jsonResponse(200, []));
  try {
    const { fetchWorktrees } = await import("../../api.ts");
    await fetchWorktrees("proj-1");
    assert.equal(mock.calls.length, 1);
    assert.ok(
      !mock.calls[0].url.includes("includeRemoved="),
      `default fetch should not opt in: ${mock.calls[0].url}`,
    );
  } finally {
    mock.restore();
  }
});

test("restoreWorktree posts to the new /restore endpoint and returns the worktree", async () => {
  const mock = installFetchMock(() =>
    jsonResponse(200, {
      worktree: { id: "wt-1", name: "issue-1", presence: "active" },
    }),
  );
  try {
    const { restoreWorktree } = await import("../../api.ts");
    const restored = await restoreWorktree("proj-1", "wt-1");
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].init?.method, "POST");
    assert.match(
      mock.calls[0].url,
      /\/api\/projects\/proj-1\/worktrees\/wt-1\/restore$/,
    );
    assert.equal(restored.id, "wt-1");
    assert.equal(restored.presence, "active");
  } finally {
    mock.restore();
  }
});

test("restoreWorktree surfaces the server error message on 409", async () => {
  const mock = installFetchMock(() =>
    jsonResponse(409, { error: "worktree is not archived; nothing to restore" }),
  );
  try {
    const { restoreWorktree } = await import("../../api.ts");
    await assert.rejects(
      restoreWorktree("proj-1", "wt-1"),
      /not archived/,
    );
  } finally {
    mock.restore();
  }
});

test("purgeWorktree issues a DELETE to the /purge endpoint", async () => {
  const mock = installFetchMock(() => jsonResponse(200, { ok: true }));
  try {
    const { purgeWorktree } = await import("../../api.ts");
    await purgeWorktree("proj-1", "wt-1");
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].init?.method, "DELETE");
    assert.match(
      mock.calls[0].url,
      /\/api\/projects\/proj-1\/worktrees\/wt-1\/purge$/,
    );
  } finally {
    mock.restore();
  }
});

test("purgeWorktree treats 404 as a no-op (idempotent against concurrent purges)", async () => {
  const mock = installFetchMock(() =>
    jsonResponse(404, { error: "Worktree not found" }),
  );
  try {
    const { purgeWorktree } = await import("../../api.ts");
    // Should not throw — the second-tab race is a normal occurrence
    // and the UI should stop showing its spinner.
    await purgeWorktree("proj-1", "wt-1");
  } finally {
    mock.restore();
  }
});

test("purgeWorktree surfaces the server error message on 400 (main worktree)", async () => {
  const mock = installFetchMock(() =>
    jsonResponse(400, { error: "cannot purge the main worktree" }),
  );
  try {
    const { purgeWorktree } = await import("../../api.ts");
    await assert.rejects(
      purgeWorktree("proj-1", "wt-main"),
      /cannot purge the main worktree/,
    );
  } finally {
    mock.restore();
  }
});
