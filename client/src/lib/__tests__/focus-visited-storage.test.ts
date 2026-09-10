import test from "node:test";
import assert from "node:assert/strict";
import {
  loadSavedVisitedAt,
  persistVisitedAt,
  VISITED_AT_STORAGE_KEY,
  VISITED_AT_TTL_MS,
} from "../focus-visited-storage.ts";

/**
 * Minimal in-memory Storage mock. The helpers only call getItem/setItem,
 * so we don't need the real thing. Throwing wrappers are used in the
 * "storage failure" tests to confirm the helpers don't propagate.
 */
function memoryStorage(
  initial: Record<string, string> = {},
  options: { throwOnGet?: boolean; throwOnSet?: boolean } = {},
): Pick<Storage, "getItem" | "setItem"> {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) {
      if (options.throwOnGet) throw new Error("blocked");
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key, value) {
      if (options.throwOnSet) throw new Error("quota");
      store.set(key, value);
    },
  };
}

test("loadSavedVisitedAt returns {} when no entry exists", () => {
  assert.deepEqual(loadSavedVisitedAt(memoryStorage()), {});
});

test("loadSavedVisitedAt returns {} when storage.getItem throws", () => {
  assert.deepEqual(
    loadSavedVisitedAt(memoryStorage({}, { throwOnGet: true })),
    {},
  );
});

test("loadSavedVisitedAt returns {} when the stored JSON is malformed", () => {
  const storage = memoryStorage({
    [VISITED_AT_STORAGE_KEY]: "not-json-at-all",
  });
  assert.deepEqual(loadSavedVisitedAt(storage), {});
});

test("loadSavedVisitedAt returns {} when the stored JSON is not an object", () => {
  // Array root: technically valid JSON but not the shape we expect.
  const storage = memoryStorage({
    [VISITED_AT_STORAGE_KEY]: JSON.stringify(["a", "b"]),
  });
  assert.deepEqual(loadSavedVisitedAt(storage), {});
});

test("loadSavedVisitedAt drops entries with non-string values", () => {
  const now = new Date().toISOString();
  const storage = memoryStorage({
    [VISITED_AT_STORAGE_KEY]: JSON.stringify({
      "valid-id": now,
      "number-id": 12345,
      "null-id": null,
      "object-id": { foo: "bar" },
    }),
  });
  assert.deepEqual(loadSavedVisitedAt(storage), { "valid-id": now });
});

test("loadSavedVisitedAt drops entries with malformed timestamp strings", () => {
  const storage = memoryStorage({
    [VISITED_AT_STORAGE_KEY]: JSON.stringify({
      "bad-id": "not-a-real-iso-string",
    }),
  });
  assert.deepEqual(loadSavedVisitedAt(storage), {});
});

test("loadSavedVisitedAt drops entries older than the TTL", () => {
  const now = Date.now();
  const recent = new Date(now - 60_000).toISOString(); // 1 min ago — fresh
  const stale = new Date(now - (VISITED_AT_TTL_MS + 60_000)).toISOString(); // > TTL — drop
  const storage = memoryStorage({
    [VISITED_AT_STORAGE_KEY]: JSON.stringify({
      "recent-id": recent,
      "stale-id": stale,
    }),
  });
  const result = loadSavedVisitedAt(storage);
  assert.ok("recent-id" in result);
  assert.ok(!("stale-id" in result));
});

test("loadSavedVisitedAt keeps entries right at the boundary of the TTL", () => {
  const cutoff = Date.now() - VISITED_AT_TTL_MS;
  const justInside = new Date(cutoff + 1_000).toISOString();
  const justOutside = new Date(cutoff - 1_000).toISOString();
  const storage = memoryStorage({
    [VISITED_AT_STORAGE_KEY]: JSON.stringify({
      "inside-id": justInside,
      "outside-id": justOutside,
    }),
  });
  const result = loadSavedVisitedAt(storage);
  assert.ok("inside-id" in result);
  assert.ok(!("outside-id" in result));
});

test("loadSavedVisitedAt preserves the original timestamp string verbatim", () => {
  // We store ISO strings on disk; reloads shouldn't re-stringify
  // them (a re-stringified timestamp with the same instant would be
  // considered a different value by the visit-effect's
  // `current[id] !== next` check). The hydration must pass through.
  const ts = "2026-09-04T03:18:42.123Z";
  const storage = memoryStorage({
    [VISITED_AT_STORAGE_KEY]: JSON.stringify({ "session-1": ts }),
  });
  const result = loadSavedVisitedAt(storage);
  assert.equal(result["session-1"], ts);
});

test("persistVisitedAt writes through to storage", () => {
  const storage = memoryStorage();
  persistVisitedAt(storage, { "session-1": "2026-09-04T03:18:42.123Z" });
  assert.deepEqual(
    JSON.parse(storage.getItem(VISITED_AT_STORAGE_KEY)!),
    { "session-1": "2026-09-04T03:18:42.123Z" },
  );
});

test("persistVisitedAt swallows quota errors", () => {
  // No exception should escape; the in-memory state still works
  // for the session. The next successful write will heal the
  // disk state.
  const storage = memoryStorage({}, { throwOnSet: true });
  assert.doesNotThrow(() =>
    persistVisitedAt(storage, { "session-1": "2026-09-04T03:18:42.123Z" }),
  );
});

test("round-trip: persist then load returns the same map", () => {
  const storage = memoryStorage();
  const sample = {
    "session-a": "2026-09-04T03:18:42.123Z",
    "session-b": "2026-09-04T04:00:00.000Z",
    "session-c": "2026-09-05T01:23:45.678Z",
  };
  persistVisitedAt(storage, sample);
  assert.deepEqual(loadSavedVisitedAt(storage), sample);
});
