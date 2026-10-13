import test from "node:test";
import assert from "node:assert/strict";
import {
  confirmNewEditsAfterAwait,
  editorWillUnmount,
  focusDestinationNeedsConfirmation,
} from "./dirty-navigation.ts";

test("dirty navigation guards only moves that unmount the editor", () => {
  const current = { page: "session", projectId: "project-a", worktreeId: "worktree-a", sessionId: "one" };
  assert.equal(editorWillUnmount(current, { ...current, sessionId: "two" }), false);
  assert.equal(editorWillUnmount(current, {
    page: "session", projectId: "project-a", worktreeId: "worktree-a",
  }), false); // Archiving clears the session id but preserves the editor's key.
  assert.equal(editorWillUnmount(current, { ...current, worktreeId: "worktree-b" }), true);
  assert.equal(editorWillUnmount(current, { page: "session", projectId: "project-b" }), true);
  assert.equal(editorWillUnmount(current, { page: "settings" }), true);
});

test("Mark Done skips the discard prompt for an empty queue or same worktree", () => {
  const current = { page: "session", projectId: "project-a", worktreeId: "worktree-a" };
  assert.equal(focusDestinationNeedsConfirmation(current), false);
  assert.equal(focusDestinationNeedsConfirmation(current, { ...current, sessionId: "two" }), false);
  assert.equal(focusDestinationNeedsConfirmation(current, {
    page: "session", projectId: "project-a", worktreeId: "worktree-b",
  }), true);
});

test("an async Mark Done cannot discard edits made after its first confirmation", async () => {
  let resolveRequest!: () => void;
  const request = new Promise<void>((resolve) => { resolveRequest = resolve; });
  let revision = 3;
  let dirty = true;
  let prompts = 0;
  const confirm = () => { prompts += 1; return false; };

  const approvedRevision = revision;
  const wasDirtyAtApproval = dirty;
  const pending = request.then(() => confirmNewEditsAfterAwait(
    approvedRevision, revision, wasDirtyAtApproval, dirty, confirm,
  ));
  revision += 1; // The user keeps typing while the request is pending.
  resolveRequest();
  assert.equal(await pending, false);
  assert.equal(prompts, 1);
});

test("an unchanged draft needs no second prompt after an async action", () => {
  let prompts = 0;
  assert.equal(confirmNewEditsAfterAwait(3, 3, true, true, () => {
    prompts += 1;
    return false;
  }), true);
  assert.equal(prompts, 0);
});

test("a draft that becomes dirty during an async action needs confirmation", () => {
  assert.equal(confirmNewEditsAfterAwait(3, 3, false, true, () => false), false);
  assert.equal(confirmNewEditsAfterAwait(3, 4, false, true, () => true), true);
  assert.equal(confirmNewEditsAfterAwait(3, 4, true, false, () => false), true);
});
