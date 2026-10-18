import test from "node:test";
import assert from "node:assert/strict";
import { parseFollowUpMarker } from "./follow-up-markers.ts";
import { escapeFollowUpMarkerLabel } from "../../../shared/follow-up-markers.ts";

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

test("escaped brackets and backslashes survive monitor labels", () => {
  const label = "CI [primary] \\ watcher";
  const text = `[/monitor: ${escapeFollowUpMarkerLabel(label)}] [CI] passed`;
  assert.deepEqual(parseFollowUpMarker(text), {
    kind: "monitor", label, content: "[CI] passed", sourceUri: null,
  });
});

test("bracketed parent title retains the source link", () => {
  const label = "Coordinator [CI]";
  const uri = "controller://project/p/worktree/w/session/s";
  assert.deepEqual(parseFollowUpMarker(`[/from: ${escapeFollowUpMarkerLabel(label)}] ${uri} ping`), {
    kind: "from", label, content: "ping", sourceUri: uri,
  });
  assert.deepEqual(parseFollowUpMarker(`[/from: Coordinator ] Notes] ${uri} ping`), {
    kind: "from", label: "Coordinator ] Notes", content: "ping", sourceUri: uri,
  });
});
