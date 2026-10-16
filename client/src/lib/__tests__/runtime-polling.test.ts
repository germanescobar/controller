import test from "node:test";
import assert from "node:assert/strict";
import { fetchActiveRuntimes, fetchRuntimeSnapshot } from "../../api.ts";

test("concurrent runtime polls share one request and retry after it settles", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let resolveFirst: ((value: Response) => void) | undefined;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return Response.json({ sessions: [], persistedAttentionReady: true });
  };

  try {
    const first = fetchRuntimeSnapshot();
    assert.equal(fetchRuntimeSnapshot(), first);
    const active = fetchActiveRuntimes();
    assert.equal(calls, 1);
    resolveFirst?.(Response.json({ sessions: [], persistedAttentionReady: false }));
    assert.deepEqual(await first, { sessions: [], persistedAttentionReady: false });
    assert.deepEqual(await active, []);
    assert.deepEqual(await fetchRuntimeSnapshot(), {
      sessions: [],
      persistedAttentionReady: true,
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
