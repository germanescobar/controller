import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveSession,
  getSession,
  getSessions,
  pinSessionIfNeeded,
  saveSession,
  updateSessionFocus,
  updateSessionTitle,
  type SessionState,
} from "../sessions.js";
import {
  buildSessionFocus,
  readSessionFocus,
  resolveSessionFocusState,
  writeSessionFocus,
  type SessionFocus,
} from "../focus-state.js";

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

function makeFocus(
  sessionId: string,
  overrides: Partial<SessionFocus> = {}
): SessionFocus {
  return {
    sessionId,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("updateSessionFocus pin sets focusPinnedAt and clears focusDoneAt", async () => {
  await withTempProject(async (projectPath) => {
    await saveSession(projectPath, makeSession());
    await writeSessionFocus(
      projectPath,
      makeFocus("session-1", { focusDoneAt: "2026-01-01T00:00:00.000Z" })
    );
    const updated = await updateSessionFocus(projectPath, "session-1", "pin");
    assert.ok(updated, "session should be returned");
    assert.ok(updated?.focusPinnedAt, "focusPinnedAt should be set");
    assert.equal(updated?.focusDoneAt, undefined, "focusDoneAt should be cleared");
  });
});

test("updateSessionFocus pin is idempotent and preserves userUnpinned override", async () => {
  await withTempProject(async (projectPath) => {
    // First, user explicitly unpins.
    await saveSession(projectPath, makeSession());
    await writeSessionFocus(
      projectPath,
      makeFocus("session-1", { userUnpinned: true })
    );
    // An explicit pin always wins (user is consciously overriding the unpin).
    const updated = await updateSessionFocus(projectPath, "session-1", "pin");
    assert.ok(updated?.focusPinnedAt, "focusPinnedAt should be set");
    assert.equal(updated?.userUnpinned, undefined, "userUnpinned should be cleared by explicit pin");
  });
});

test("updateSessionFocus unpin clears focusPinnedAt and sets userUnpinned", async () => {
  await withTempProject(async (projectPath) => {
    await saveSession(projectPath, makeSession());
    await writeSessionFocus(
      projectPath,
      makeFocus("session-1", { focusPinnedAt: "2026-01-01T00:00:00.000Z" })
    );
    const updated = await updateSessionFocus(projectPath, "session-1", "unpin");
    assert.equal(updated?.focusPinnedAt, undefined, "focusPinnedAt should be cleared");
    assert.equal(updated?.userUnpinned, true, "userUnpinned should be set");
  });
});

test("updateSessionFocus done clears focusPinnedAt, sets focusDoneAt, and drops userUnpinned", async () => {
  await withTempProject(async (projectPath) => {
    await saveSession(projectPath, makeSession());
    await writeSessionFocus(
      projectPath,
      makeFocus("session-1", {
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

test("updateSessionTitle sets a trimmed title", async () => {
  await withTempProject(async (projectPath) => {
    await saveSession(projectPath, makeSession());
    const updated = await updateSessionTitle(projectPath, "session-1", "  My title  ");
    assert.equal(updated?.title, "My title");
    const persisted = await getSession(projectPath, "session-1");
    assert.equal(persisted?.title, "My title");
  });
});

test("updateSessionTitle clears the title when given a blank string", async () => {
  await withTempProject(async (projectPath) => {
    await saveSession(projectPath, makeSession({ title: "Existing" }));
    const updated = await updateSessionTitle(projectPath, "session-1", "   ");
    assert.equal(updated?.title, undefined);
  });
});

test("updateSessionTitle returns null for unknown session", async () => {
  await withTempProject(async (projectPath) => {
    const updated = await updateSessionTitle(projectPath, "does-not-exist", "x");
    assert.equal(updated, null);
  });
});

test("updateSessionTitle does not poison the agent session file with focus fields", async () => {
  // The agent-owned `.coding-agent/sessions/<id>.json` file must
  // never carry focus fields: Ada's SessionStore.save() drops any
  // top-level field it doesn't know about, so a Controller-managed
  // field on that file would silently disappear on the next save.
  // This regression check is the post-issue-#139 invariant.
  await withTempProject(async (projectPath) => {
    await saveSession(projectPath, makeSession());
    await writeSessionFocus(
      projectPath,
      makeFocus("session-1", { focusPinnedAt: "2026-01-01T00:00:00.000Z" })
    );
    await updateSessionTitle(projectPath, "session-1", "Renamed");
    const agentFile = path.join(
      projectPath,
      ".coding-agent",
      "sessions",
      "session-1.json"
    );
    const raw = JSON.parse(readFileSync(agentFile, "utf-8")) as Record<
      string,
      unknown
    >;
    assert.equal(
      raw.focusPinnedAt,
      undefined,
      "agent session file must not carry focusPinnedAt"
    );
    assert.equal(
      raw.userUnpinned,
      undefined,
      "agent session file must not carry userUnpinned"
    );
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
    await saveSession(projectPath, makeSession());
    await writeSessionFocus(
      projectPath,
      makeFocus("session-1", { focusPinnedAt: originalPin })
    );
    const updated = await pinSessionIfNeeded(projectPath, "session-1");
    assert.equal(updated?.focusPinnedAt, originalPin, "focusPinnedAt should be unchanged");
  });
});

test("pinSessionIfNeeded respects userUnpinned flag and does not re-pin", async () => {
  await withTempProject(async (projectPath) => {
    await saveSession(projectPath, makeSession());
    await writeSessionFocus(
      projectPath,
      makeFocus("session-1", { userUnpinned: true })
    );
    const updated = await pinSessionIfNeeded(projectPath, "session-1");
    assert.equal(updated?.focusPinnedAt, undefined, "focusPinnedAt should NOT be set");
    assert.equal(updated?.userUnpinned, true, "userUnpinned should be preserved");
  });
});

test("pinSessionIfNeeded is a no-op for archived sessions", async () => {
  await withTempProject(async (projectPath) => {
    await saveSession(
      projectPath,
      makeSession({ status: "archived" })
    );
    await writeSessionFocus(
      projectPath,
      makeFocus("session-1", { userUnpinned: true })
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
    await saveSession(projectPath, makeSession());
    await writeSessionFocus(
      projectPath,
      makeFocus("session-1", {
        focusPinnedAt: "2026-01-01T00:00:00.000Z",
        userUnpinned: true,
      })
    );
    const ok = await archiveSession(projectPath, "session-1");
    assert.equal(ok, true);
    const after = await getSession(projectPath, "session-1");
    assert.equal(after?.status, "archived");
    assert.equal(after?.userUnpinned, undefined, "userUnpinned should be cleared on archive");
    // The sidecar itself is removed on archive so the next time the
    // session is rehydrated it starts with a fully clean focus state.
    const sidecar = await readSessionFocus(projectPath, "session-1");
    assert.equal(sidecar, null, "focus sidecar should be removed on archive");
  });
});

test("getSession returns merged focus state from the sidecar", async () => {
  await withTempProject(async (projectPath) => {
    await saveSession(projectPath, makeSession());
    await writeSessionFocus(
      projectPath,
      makeFocus("session-1", { focusPinnedAt: "2026-01-01T00:00:00.000Z" })
    );
    const session = await getSession(projectPath, "session-1");
    assert.equal(session?.focusPinnedAt, "2026-01-01T00:00:00.000Z");
  });
});

test("getSession ignores stale focus fields left on the agent session file", async () => {
  // Belt-and-suspenders: even if a pre-issue-#139 session file
  // still has focus fields on disk (e.g. a session from before the
  // upgrade), getSession must not surface them — the sidecar is the
  // source of truth.
  await withTempProject(async (projectPath) => {
    await saveSession(
      projectPath,
      makeSession({ focusPinnedAt: "2026-01-01T00:00:00.000Z" })
    );
    const session = await getSession(projectPath, "session-1");
    assert.equal(
      session?.focusPinnedAt,
      undefined,
      "stale on-disk focus fields must not be returned"
    );
  });
});

test("getSession returns no focus fields when there is no sidecar", async () => {
  await withTempProject(async (projectPath) => {
    await saveSession(projectPath, makeSession());
    const session = await getSession(projectPath, "session-1");
    assert.equal(session?.focusPinnedAt, undefined);
    assert.equal(session?.focusDoneAt, undefined);
    assert.equal(session?.userUnpinned, undefined);
  });
});

test("getSessions merges focus state from the sidecar directory", async () => {
  await withTempProject(async (projectPath) => {
    await saveSession(
      projectPath,
      makeSession({ id: "session-1", title: "one" })
    );
    await saveSession(
      projectPath,
      makeSession({ id: "session-2", title: "two" })
    );
    await writeSessionFocus(
      projectPath,
      makeFocus("session-1", { focusPinnedAt: "2026-01-01T00:00:00.000Z" })
    );
    await writeSessionFocus(
      projectPath,
      makeFocus("session-2", {
        userUnpinned: true,
      })
    );
    const sessions = await getSessions(projectPath);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    assert.equal(byId.get("session-1")?.focusPinnedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(byId.get("session-2")?.userUnpinned, true);
    assert.equal(byId.get("session-2")?.focusPinnedAt, undefined);
  });
});

test("resolveSessionFocusState pins a brand-new session", () => {
  const state = resolveSessionFocusState(null);
  assert.ok(state.focusPinnedAt, "new session should be auto-pinned");
  assert.equal(state.userUnpinned, undefined);
  assert.equal(state.focusDoneAt, undefined);
});

test("resolveSessionFocusState preserves an existing pinned session's state", () => {
  const existing = makeFocus("session-1", {
    focusPinnedAt: "2026-01-01T00:00:00.000Z",
  });
  const state = resolveSessionFocusState(existing);
  assert.equal(state.focusPinnedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(state.userUnpinned, undefined);
  assert.equal(state.focusDoneAt, undefined);
});

test("resolveSessionFocusState auto-pins an existing unpinned session on reply", () => {
  // Scenario: session exists but was never pinned (e.g. created before auto-pin,
  // or focus queue was off). User sends a new message — it should appear in the
  // focus queue automatically.
  const existing = makeFocus("session-1");
  const state = resolveSessionFocusState(existing);
  assert.ok(state.focusPinnedAt, "unpinned session should be auto-pinned on reply");
  assert.equal(state.userUnpinned, undefined);
  assert.equal(state.focusDoneAt, undefined);
});

test("resolveSessionFocusState auto-pins a 'done' session on reply", () => {
  // Scenario: user marked a session as done, then sends another message.
  // It should surface back in the focus queue.
  const existing = makeFocus("session-1", {
    focusDoneAt: "2026-01-01T00:00:00.000Z",
  });
  const state = resolveSessionFocusState(existing);
  assert.ok(state.focusPinnedAt, "done session should be auto-pinned on reply");
  assert.equal(state.focusDoneAt, undefined, "focusDoneAt should be cleared on auto-pin");
  assert.equal(state.userUnpinned, undefined);
});

test("resolveSessionFocusState does NOT re-pin a user-unpinned session on resume (regression: PR #102 Codex review)", async () => {
  // Scenario: user created a session, then explicitly unpinned it.
  // The focus sidecar therefore has userUnpinned: true and no
  // focusPinnedAt. A follow-up message hits the resume path, which
  // must (a) leave the session unpinned and (b) keep the userUnpinned
  // flag so the opt-out survives.
  await withTempProject(async (projectPath) => {
    await saveSession(projectPath, makeSession());
    await writeSessionFocus(
      projectPath,
      makeFocus("session-1", { userUnpinned: true /* no focusPinnedAt */ })
    );

    // Simulate what persistSessionStart does: read the existing
    // focus sidecar, resolve the focus state, write the new sidecar.
    const existingFocus = await readSessionFocus(projectPath, "session-1");
    assert.ok(existingFocus, "precondition: focus sidecar exists");
    assert.equal(existingFocus?.userUnpinned, true);
    assert.equal(existingFocus?.focusPinnedAt, undefined);

    const focus = resolveSessionFocusState(existingFocus);
    await writeSessionFocus(
      projectPath,
      buildSessionFocus("session-1", focus)
    );

    const after = await getSession(projectPath, "session-1");
    assert.equal(after?.focusPinnedAt, undefined, "user-unpinned session must not be re-pinned on resume");
    assert.equal(after?.userUnpinned, true, "userUnpinned flag must be preserved on resume");
  });
});

test("regression: a second writer overwriting the agent session file leaves focus state intact (issue #139/#141)", async () => {
  // The two-writer race that this regression guards against:
  //
  //   1. The Controller writes the session file and the focus sidecar
  //      (auto-pinning a brand-new session).
  //   2. The agent (Ada) subsequently writes its own session file
  //      multiple times per run, dropping any unknown top-level
  //      fields. Pre-#139, the Controller's `focusPinnedAt` lived
  //      on the session file, so it would silently disappear.
  //
  // With the sidecar fix, focus state lives in a separate file
  // that the agent never reads or writes, so the second writer
  // cannot touch it — regardless of how many times it overwrites
  // the agent session file.
  await withTempProject(async (projectPath) => {
    // Step 1: Controller auto-pins a brand-new session.
    await saveSession(projectPath, makeSession());
    await writeSessionFocus(
      projectPath,
      buildSessionFocus("session-1", {
        focusPinnedAt: new Date().toISOString(),
        focusDoneAt: undefined,
        userUnpinned: undefined,
      })
    );
    const beforeAgentWrite = await getSession(projectPath, "session-1");
    const originalPin = beforeAgentWrite?.focusPinnedAt;
    assert.ok(originalPin, "precondition: focus pin was set on create");

    // Step 2: simulate Ada's writer clobbering the agent session
    // file with only Ada's fields. This is the writer shape from
    // `@germanescobar/ada/src/storage/session-store.ts` — note the
    // absence of any Controller-managed fields.
    const adaStyleSession: SessionState = {
      id: "session-1",
      workingDirectory: projectPath,
      model: "ada-model",
      messages: [
        {
          type: "message",
          role: "user",
          content: "hi",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:01.000Z",
      status: "active",
    };
    await saveSession(projectPath, adaStyleSession);

    // Simulate Ada's loop writing the file eight times per run.
    for (let i = 0; i < 8; i++) {
      await saveSession(projectPath, {
        ...adaStyleSession,
        lastActiveAt: new Date(Date.now() + i * 100).toISOString(),
      });
    }

    // Step 3: read back and confirm the focus pin is intact.
    const after = await getSession(projectPath, "session-1");
    assert.equal(
      after?.focusPinnedAt,
      originalPin,
      "focusPinnedAt must survive any number of agent-side writes"
    );

    // And the sidecar file itself is still present and unchanged.
    const sidecar = await readSessionFocus(projectPath, "session-1");
    assert.ok(sidecar, "focus sidecar must still exist");
    assert.equal(sidecar?.focusPinnedAt, originalPin);
  });
});

test("regression: a second writer overwriting the agent session file cannot fake a pin (issue #139/#141)", async () => {
  // The inverse of the previous test: a malicious or buggy second
  // writer that *adds* focus fields to the session file must not
  // be able to spoof focus state. Pre-#139, a future Ada field
  // named `focusPinnedAt` would have been honored by the
  // Controller. Post-#139, the Controller ignores any focus
  // fields on the agent file and reads from the sidecar only.
  await withTempProject(async (projectPath) => {
    await saveSession(
      projectPath,
      makeSession({ focusPinnedAt: "2026-01-01T00:00:00.000Z" })
    );
    const session = await getSession(projectPath, "session-1");
    assert.equal(
      session?.focusPinnedAt,
      undefined,
      "focusPinnedAt written by the agent must be ignored — the sidecar is the source of truth"
    );
  });
});

// Regression tests for the PR #142 review comment: `getSession`,
// `archiveSession`, and `updateSessionTitle` must keep treating a
// malformed (or transiently empty/partial) agent session file as a
// missing session, not as an unhandled exception. Ada rewrites
// `.coding-agent/sessions/<id>.json` multiple times per run (see
// issue #140) and a reader can race the writer.

function writeAgentSessionFile(
  projectPath: string,
  sessionId: string,
  body: string
): void {
  const sessionsDir = path.join(projectPath, ".coding-agent", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(path.join(sessionsDir, `${sessionId}.json`), body);
}

test("getSession returns null for a malformed agent session file (PR #142 review)", async () => {
  await withTempProject(async (projectPath) => {
    writeAgentSessionFile(projectPath, "session-1", "{ not valid json");
    const session = await getSession(projectPath, "session-1");
    assert.equal(session, null, "malformed file must be treated as a missing session");
  });
});

test("getSession returns null for a transiently empty agent session file (PR #142 review)", async () => {
  await withTempProject(async (projectPath) => {
    writeAgentSessionFile(projectPath, "session-1", "");
    const session = await getSession(projectPath, "session-1");
    assert.equal(session, null, "empty file must be treated as a missing session");
  });
});

test("archiveSession returns false for a malformed agent session file (PR #142 review)", async () => {
  await withTempProject(async (projectPath) => {
    writeAgentSessionFile(projectPath, "session-1", "{ not valid json");
    const ok = await archiveSession(projectPath, "session-1");
    assert.equal(ok, false, "archiving a malformed file must report failure, not throw");
  });
});

test("updateSessionTitle returns null for a malformed agent session file (PR #142 review)", async () => {
  await withTempProject(async (projectPath) => {
    writeAgentSessionFile(projectPath, "session-1", "{ not valid json");
    const updated = await updateSessionTitle(projectPath, "session-1", "new title");
    assert.equal(updated, null, "title update on a malformed file must report failure, not throw");
  });
});
