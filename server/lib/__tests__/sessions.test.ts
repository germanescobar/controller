import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveSession,
  getSession,
  pinSessionIfNeeded,
  saveSession,
  updateSessionFocus,
  type SessionState,
} from "../sessions.js";

function withTempProject(run: (projectPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sessions-"));
  return run(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: overrides.id ?? "session-1",
    workingDirectory: "/tmp/proj",
    model: "test-model",
    messages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

test("updateSessionFocus pin sets focusPinnedAt and clears focusDoneAt", async () => {
  await withTempProject(async (projectPath) => {
    await saveSession(projectPath, makeSession({ focusDoneAt: "2026-01-01T00:00:00.000Z" }));
    const updated = await updateSessionFocus(projectPath, "session-1", "pin");
    assert.ok(updated, "session should be returned");
    assert.ok(updated?.focusPinnedAt, "focusPinnedAt should be set");
    assert.equal(updated?.focusDoneAt, undefined, "focusDoneAt should be cleared");
  });
});

test("updateSessionFocus pin is idempotent and preserves userUnpinned override", async () => {
  await withTempProject(async (projectPath) => {
    // First, user explicitly unpins.
    await saveSession(projectPath, makeSession({ userUnpinned: true }));
    // An explicit pin always wins (user is consciously overriding the unpin).
    const updated = await updateSessionFocus(projectPath, "session-1", "pin");
    assert.ok(updated?.focusPinnedAt, "focusPinnedAt should be set");
    assert.equal(updated?.userUnpinned, undefined, "userUnpinned should be cleared by explicit pin");
  });
});

test("updateSessionFocus unpin clears focusPinnedAt and sets userUnpinned", async () => {
  await withTempProject(async (projectPath) => {
    await saveSession(
      projectPath,
      makeSession({ focusPinnedAt: "2026-01-01T00:00:00.000Z" })
    );
    const updated = await updateSessionFocus(projectPath, "session-1", "unpin");
    assert.equal(updated?.focusPinnedAt, undefined, "focusPinnedAt should be cleared");
    assert.equal(updated?.userUnpinned, true, "userUnpinned should be set");
  });
});

test("updateSessionFocus done clears focusPinnedAt, sets focusDoneAt, and drops userUnpinned", async () => {
  await withTempProject(async (projectPath) => {
    await saveSession(
      projectPath,
      makeSession({
        focusPinnedAt: "2026-01-01T00:00:00.000Z",
        userUnpinned: true,
      })
    );
    const updated = await updateSessionFocus(projectPath, "session-1", "done");
    assert.equal(updated?.focusPinnedAt, undefined, "focusPinnedAt should be cleared");
    assert.ok(updated?.focusDoneAt, "focusDoneAt should be set");
    assert.equal(updated?.userUnpinned, undefined, "userUnpinned should be dropped");
  });
});

test("updateSessionFocus returns null for unknown session", async () => {
  await withTempProject(async (projectPath) => {
    const updated = await updateSessionFocus(projectPath, "does-not-exist", "pin");
    assert.equal(updated, null);
  });
});

test("pinSessionIfNeeded pins a session that has no pin and no userUnpinned flag", async () => {
  await withTempProject(async (projectPath) => {
    await saveSession(projectPath, makeSession());
    const updated = await pinSessionIfNeeded(projectPath, "session-1");
    assert.ok(updated?.focusPinnedAt, "focusPinnedAt should be set");
    // Round-trip through the file to make sure we persisted.
    const fromDisk = await getSession(projectPath, "session-1");
    assert.ok(fromDisk?.focusPinnedAt, "focusPinnedAt should be persisted");
  });
});

test("pinSessionIfNeeded is a no-op for an already-pinned session", async () => {
  await withTempProject(async (projectPath) => {
    const originalPin = "2026-01-01T00:00:00.000Z";
    await saveSession(
      projectPath,
      makeSession({ focusPinnedAt: originalPin })
    );
    const updated = await pinSessionIfNeeded(projectPath, "session-1");
    assert.equal(updated?.focusPinnedAt, originalPin, "focusPinnedAt should be unchanged");
  });
});

test("pinSessionIfNeeded respects userUnpinned flag and does not re-pin", async () => {
  await withTempProject(async (projectPath) => {
    await saveSession(projectPath, makeSession({ userUnpinned: true }));
    const updated = await pinSessionIfNeeded(projectPath, "session-1");
    assert.equal(updated?.focusPinnedAt, undefined, "focusPinnedAt should NOT be set");
    assert.equal(updated?.userUnpinned, true, "userUnpinned should be preserved");
  });
});

test("pinSessionIfNeeded is a no-op for archived sessions", async () => {
  await withTempProject(async (projectPath) => {
    await saveSession(
      projectPath,
      makeSession({ status: "archived", userUnpinned: true })
    );
    const updated = await pinSessionIfNeeded(projectPath, "session-1");
    assert.equal(updated?.focusPinnedAt, undefined, "archived sessions should not be pinned");
  });
});

test("pinSessionIfNeeded returns null for unknown session", async () => {
  await withTempProject(async (projectPath) => {
    const updated = await pinSessionIfNeeded(projectPath, "does-not-exist");
    assert.equal(updated, null);
  });
});

test("archiveSession clears userUnpinned so a rehydrated session gets a clean slate", async () => {
  await withTempProject(async (projectPath) => {
    await saveSession(
      projectPath,
      makeSession({
        focusPinnedAt: "2026-01-01T00:00:00.000Z",
        userUnpinned: true,
      })
    );
    const ok = await archiveSession(projectPath, "session-1");
    assert.equal(ok, true);
    const after = await getSession(projectPath, "session-1");
    assert.equal(after?.status, "archived");
    assert.equal(after?.userUnpinned, undefined, "userUnpinned should be cleared on archive");
  });
});
