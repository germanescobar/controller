import test from "node:test";
import assert from "node:assert/strict";
import {
  groupSessionsByParent,
  isSubtreeExpandedByDefault,
} from "./parent-child.js";

test("groupSessionsByParent keeps root sessions (no parentId) at the top level", () => {
  const sessions = [
    { id: "a", parentId: null },
    { id: "b", parentId: null },
  ];
  const { roots, childrenByParent } = groupSessionsByParent(sessions);
  assert.deepEqual(roots.map((s) => s.id), ["a", "b"]);
  assert.equal(childrenByParent.size, 0);
});

test("groupSessionsByParent nests a child under its parent", () => {
  const sessions = [
    { id: "parent", parentId: null },
    { id: "child", parentId: "parent" },
  ];
  const { roots, childrenByParent } = groupSessionsByParent(sessions);
  assert.deepEqual(roots.map((s) => s.id), ["parent"]);
  const children = childrenByParent.get("parent");
  assert.ok(children, "expected children of `parent`");
  assert.deepEqual(children.map((c) => c.id), ["child"]);
});

test("groupSessionsByParent preserves input order within a parent bucket", () => {
  const sessions = [
    { id: "p", parentId: null },
    { id: "c1", parentId: "p" },
    { id: "c2", parentId: "p" },
    { id: "c3", parentId: "p" },
  ];
  const { childrenByParent } = groupSessionsByParent(sessions);
  const children = childrenByParent.get("p");
  assert.ok(children);
  assert.deepEqual(children.map((c) => c.id), ["c1", "c2", "c3"]);
});

test("groupSessionsByParent treats children of an unknown parent as roots", () => {
  // This is the orphan case: the parent was archived or never
  // existed in this snapshot. Hiding the child would be worse
  // than surfacing it as a top-level entry, so the function
  // promotes it to a root.
  const sessions = [
    { id: "a", parentId: null },
    { id: "b", parentId: "missing-parent" },
  ];
  const { roots, childrenByParent } = groupSessionsByParent(sessions);
  assert.deepEqual(roots.map((s) => s.id).sort(), ["a", "b"]);
  assert.equal(childrenByParent.size, 0);
});

test("groupSessionsByParent ignores malformed entries", () => {
  // The wire shape is a `parentId?: string | null`; the helper
  // must not crash on a non-string parentId. We promote the
  // entry to a root and move on.
  const sessions = [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { id: "a", parentId: 42 as any },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { id: "b", parentId: undefined as any },
  ];
  const { roots, childrenByParent } = groupSessionsByParent(sessions);
  assert.deepEqual(roots.map((s) => s.id).sort(), ["a", "b"]);
  assert.equal(childrenByParent.size, 0);
});

test("groupSessionsByParent supports multiple parents in the same input", () => {
  const sessions = [
    { id: "p1", parentId: null },
    { id: "p2", parentId: null },
    { id: "c1", parentId: "p1" },
    { id: "c2", parentId: "p2" },
    { id: "c3", parentId: "p1" },
  ];
  const { roots, childrenByParent } = groupSessionsByParent(sessions);
  assert.deepEqual(roots.map((s) => s.id).sort(), ["p1", "p2"]);
  assert.deepEqual(childrenByParent.get("p1")?.map((c) => c.id), ["c1", "c3"]);
  assert.deepEqual(childrenByParent.get("p2")?.map((c) => c.id), ["c2"]);
});

test("isSubtreeExpandedByDefault expands when any child is active", () => {
  const children = [{ status: "queued" }, { status: "active" }];
  assert.equal(isSubtreeExpandedByDefault(children), true);
});

test("isSubtreeExpandedByDefault collapses when no child is active", () => {
  const children = [{ status: "queued" }, { status: "completed" }];
  assert.equal(isSubtreeExpandedByDefault(children), false);
});

test("isSubtreeExpandedByDefault ignores archived children", () => {
  // An archived child doesn't count as "active" even if its
  // `status` field is still set to `active` (the server doesn't
  // always clear it on archive). The `archivedAt` check is the
  // canonical one.
  const children = [
    { status: "active", archivedAt: "2026-09-15T01:00:00.000Z" },
    { status: "queued" },
  ];
  assert.equal(isSubtreeExpandedByDefault(children), false);
});

test("isSubtreeExpandedByDefault returns false for an empty subtree", () => {
  assert.equal(isSubtreeExpandedByDefault([]), false);
});

test("isSubtreeExpandedByDefault defaults to false when status is missing", () => {
  // Legacy summaries / server before #351 don't carry a
  // `status` field. Match the pre-#351 behavior: parents start
  // collapsed. Operators can expand manually.
  const children = [{}, {}, {}];
  assert.equal(isSubtreeExpandedByDefault(children), false);
});
