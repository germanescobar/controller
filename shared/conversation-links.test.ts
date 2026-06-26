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

test("parseControllerUri accepts the plural session segment", () => {
  assert.deepEqual(
    parseControllerUri(
      "controller://project/p1/worktree/w1/sessions/s1"
    ),
    { projectId: "p1", worktreeId: "w1", sessionId: "s1" }
  );
});

test("parseControllerUri trims surrounding whitespace", () => {
  assert.deepEqual(
    parseControllerUri(
      "  controller://project/p1/worktree/w1/session/s1  "
    ),
    { projectId: "p1", worktreeId: "w1", sessionId: "s1" }
  );
});

test("parseControllerUri rejects malformed and unrelated values", () => {
  assert.equal(parseControllerUri(""), null);
  assert.equal(parseControllerUri(undefined), null);
  assert.equal(parseControllerUri(null), null);
  assert.equal(parseControllerUri("https://example.com"), null);
  assert.equal(parseControllerUri("controller://"), null);
  // Short form is no longer supported — links must carry the full path.
  assert.equal(parseControllerUri("controller://session/abc123"), null);
  assert.equal(parseControllerUri("controller://project/p/session/s"), null);
  assert.equal(
    parseControllerUri(
      "controller://project/p/worktree/w/session/s/extra"
    ),
    null
  );
  // A URI embedded in surrounding text is not a standalone link.
  assert.equal(
    parseControllerUri(
      "see controller://project/p/worktree/w/session/s for details"
    ),
    null
  );
});

test("CONTROLLER_URI_PATTERN finds URIs embedded in text", () => {
  const text =
    "First controller://project/p1/worktree/w1/session/s1 and second controller://project/p2/worktree/w2/session/s2.";
  const matches = [...text.matchAll(CONTROLLER_URI_PATTERN)].map((m) => m[0]);
  assert.deepEqual(matches, [
    "controller://project/p1/worktree/w1/session/s1",
    "controller://project/p2/worktree/w2/session/s2",
  ]);
});
