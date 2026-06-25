import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTROLLER_URI_PATTERN,
  parseControllerUri,
} from "./conversation-links.ts";

test("parseControllerUri parses the full form", () => {
  const target = parseControllerUri(
    "controller://project/8bb23e29/worktree/6a5b04bf/session/fa6b3db5"
  );
  assert.deepEqual(target, {
    projectId: "8bb23e29",
    worktreeId: "6a5b04bf",
    sessionId: "fa6b3db5",
  });
});

test("parseControllerUri parses the short form", () => {
  assert.deepEqual(parseControllerUri("controller://session/abc123"), {
    sessionId: "abc123",
  });
});

test("parseControllerUri accepts the plural short form", () => {
  assert.deepEqual(parseControllerUri("controller://sessions/abc123"), {
    sessionId: "abc123",
  });
});

test("parseControllerUri trims surrounding whitespace", () => {
  assert.deepEqual(parseControllerUri("  controller://session/abc123  "), {
    sessionId: "abc123",
  });
});

test("parseControllerUri rejects malformed and unrelated values", () => {
  assert.equal(parseControllerUri(""), null);
  assert.equal(parseControllerUri(undefined), null);
  assert.equal(parseControllerUri(null), null);
  assert.equal(parseControllerUri("https://example.com"), null);
  assert.equal(parseControllerUri("controller://"), null);
  assert.equal(parseControllerUri("controller://project/p/session/s"), null);
  assert.equal(
    parseControllerUri("controller://session/abc/extra"),
    null
  );
  // A URI embedded in surrounding text is not a standalone link.
  assert.equal(
    parseControllerUri("see controller://session/abc123 for details"),
    null
  );
});

test("CONTROLLER_URI_PATTERN finds URIs embedded in text", () => {
  const text =
    "Full controller://project/p1/worktree/w1/session/s1 and short controller://session/s2.";
  const matches = [...text.matchAll(CONTROLLER_URI_PATTERN)].map((m) => m[0]);
  assert.deepEqual(matches, [
    "controller://project/p1/worktree/w1/session/s1",
    "controller://session/s2",
  ]);
});
