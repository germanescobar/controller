import test from "node:test";
import assert from "node:assert/strict";
import { mergePathEntries } from "../shell-env.js";

test("mergePathEntries keeps existing entries first and appends new ones", () => {
  const merged = mergePathEntries("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin");
  assert.equal(merged, "/usr/bin:/bin:/opt/homebrew/bin");
});

test("mergePathEntries dedupes within and across inputs", () => {
  const merged = mergePathEntries("/a:/a:/b", "/b:/c:/c");
  assert.equal(merged, "/a:/b:/c");
});

test("mergePathEntries ignores empty segments", () => {
  const merged = mergePathEntries("/a::/b", ":/c:");
  assert.equal(merged, "/a:/b:/c");
});

test("mergePathEntries handles an empty current path", () => {
  const merged = mergePathEntries("", "/usr/local/bin:/usr/bin");
  assert.equal(merged, "/usr/local/bin:/usr/bin");
});
