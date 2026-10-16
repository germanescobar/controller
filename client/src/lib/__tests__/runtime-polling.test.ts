import test from "node:test";
import assert from "node:assert/strict";
import { fetchActiveRuntimes } from "../../api.ts";

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
    return Response.json({ sessions: [] });
  };

  try {
    const first = fetchActiveRuntimes();
    assert.equal(fetchActiveRuntimes(), first);
    assert.equal(calls, 1);
    resolveFirst?.(Response.json({ sessions: [] }));
    assert.deepEqual(await first, []);
    assert.deepEqual(await fetchActiveRuntimes(), []);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
