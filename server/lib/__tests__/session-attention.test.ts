import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getCachedPersistedAttentionSnapshot,
  hasPendingSessionAttention,
  listPersistedAttentionSessionIds,
} from "../session-attention.js";
import type { AgentEvent } from "../sessions.js";

function event(type: string, data: Record<string, unknown> = {}): AgentEvent {
  return {
    id: `${type}-id`,
    sessionId: "session-1",
    timestamp: new Date().toISOString(),
    type,
    data,
  };
}

test("reconstructs unresolved user input from persisted events", () => {
  assert.equal(
    hasPendingSessionAttention([event("user_input_requested")]),
    true,
  );
  assert.equal(
    hasPendingSessionAttention([
      event("user_input_requested"),
      event("user_input_response"),
    ]),
    false,
  );
});

test("reconstructs unresolved approvals and clears them on terminal events", () => {
  assert.equal(
    hasPendingSessionAttention([event("tool_approval_requested")]),
    true,
  );
  assert.equal(
    hasPendingSessionAttention([
      event("tool_approval_requested"),
      event("run.completed"),
    ]),
    false,
  );
});

test("discovers unresolved attention from event logs after a cold start", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "persisted-attention-"));
  const previousHome = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;
  const eventsDir = path.join(homeDir, "projects", "demo-store", "events");
  await fs.mkdir(eventsDir, { recursive: true });
  await fs.writeFile(
    path.join(eventsDir, "waiting-session.jsonl"),
    `${JSON.stringify(event("user_input_requested"))}\n`,
  );

  try {
    const pending = await listPersistedAttentionSessionIds();
    assert.deepEqual([...pending], ["waiting-session"]);
  } finally {
    if (previousHome === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previousHome;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test("updates attention from appended lines and waits for incomplete writes", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "persisted-attention-"));
  const previousHome = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;
  const eventsDir = path.join(homeDir, "projects", "demo-store", "events");
  const filePath = path.join(eventsDir, "waiting-session.jsonl");
  await fs.mkdir(eventsDir, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(event("user_input_requested"))}\n`);

  try {
    const cold = getCachedPersistedAttentionSnapshot();
    assert.equal(cold.ready, false);
    assert.deepEqual([...cold.sessionIds], []);
    const first = listPersistedAttentionSessionIds();
    assert.equal(listPersistedAttentionSessionIds(), first);
    assert.deepEqual([...await first], ["waiting-session"]);
    const complete = getCachedPersistedAttentionSnapshot();
    assert.equal(complete.ready, true);
    assert.deepEqual([...complete.sessionIds], ["waiting-session"]);
    await listPersistedAttentionSessionIds();

    const response = Buffer.from(JSON.stringify(event("user_input_response", { text: "😀" })));
    const midpoint = response.indexOf(Buffer.from("😀")) + 2;
    await fs.appendFile(filePath, response.subarray(0, midpoint));
    assert.deepEqual([...await listPersistedAttentionSessionIds()], ["waiting-session"]);

    await fs.appendFile(filePath, Buffer.concat([response.subarray(midpoint), Buffer.from("\n")]));
    assert.deepEqual([...await listPersistedAttentionSessionIds()], []);

    await fs.writeFile(filePath, `${JSON.stringify(event("tool_approval_requested"))}\n`);
    assert.deepEqual([...await listPersistedAttentionSessionIds()], ["waiting-session"]);
  } finally {
    if (previousHome === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previousHome;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
