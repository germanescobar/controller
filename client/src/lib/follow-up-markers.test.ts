import test from "node:test";
import assert from "node:assert/strict";
import { parseFollowUpMarker } from "./follow-up-markers.ts";

test("monitor marker becomes a label without losing its line", () => {
  assert.deepEqual(parseFollowUpMarker("[/monitor: CI watcher] [CI] passed"), {
    kind: "monitor", label: "CI watcher", content: "[CI] passed", sourceUri: null,
  });
});

test("cross-session marker keeps the source URI for navigation", () => {
  assert.deepEqual(parseFollowUpMarker("[/from: Coordinator] controller://project/p/worktree/w/session/s ping"), {
    kind: "from", label: "Coordinator", content: "ping", sourceUri: "controller://project/p/worktree/w/session/s",
  });
});

test("ordinary typed text stays untouched", () => {
  assert.equal(parseFollowUpMarker("Please check [/monitor: CI] in the log"), null);
});
