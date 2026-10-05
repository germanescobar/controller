import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEvent, getEventsTail, type AgentEvent } from "../sessions.js";
import { projectStoreDir } from "../paths.js";

/*
 * Tests for the tail-paginated events helper introduced in issue #404.
 * The default `GET /:projectId/sessions/:sessionId/events` endpoint used
 * to ship the full deduped transcript on every open; this helper is the
 * server-side counterpart of the paginated open path. The full-transcript
 * endpoint is unchanged and still covered by `user-message-dedupe.test.ts`
 * and `anita-transcript-persistence.test.ts`.
 */

/* Runs `run` against a fresh temp project + isolated Controller home. */
function withTempProject(run: (projectPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "events-tail-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "orch-home-"));
  const prevHome = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = home;
  return run(dir).finally(() => {
    if (prevHome === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
}

function makeEvent(index: number, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: overrides.id ?? `evt-${index}`,
    sessionId: "s-tail",
    timestamp: new Date(2026, 0, 1, 0, 0, index).toISOString(),
    type: "user_message",
    data: { text: `turn ${index}` },
    ...overrides,
  };
}

test("getEventsTail honors the requested limit and returns events in chronological order", async () => {
  await withTempProject(async (projectPath) => {
    const sessionId = "s-tail-honors-limit";
    for (let i = 0; i < 20; i++) {
      await appendEvent(projectPath, sessionId, makeEvent(i));
    }
    const tail = await getEventsTail(projectPath, sessionId, { limit: 5 });
    assert.equal(tail.length, 5);
    assert.deepEqual(
      tail.map((e) => e.data.text),
      ["turn 15", "turn 16", "turn 17", "turn 18", "turn 19"],
    );
  });
});

test("getEventsTail returns the full transcript when the file is smaller than the limit", async () => {
  await withTempProject(async (projectPath) => {
    const sessionId = "s-tail-smaller-than-limit";
    await appendEvent(projectPath, sessionId, makeEvent(0));
    await appendEvent(projectPath, sessionId, makeEvent(1));
    const tail = await getEventsTail(projectPath, sessionId, { limit: 50 });
    assert.equal(tail.length, 2);
    assert.deepEqual(
      tail.map((e) => e.data.text),
      ["turn 0", "turn 1"],
    );
  });
});

test("getEventsTail returns the empty array when the events file does not exist", async () => {
  await withTempProject(async (projectPath) => {
    const tail = await getEventsTail(projectPath, "no-such-session", { limit: 10 });
    assert.deepEqual(tail, []);
  });
});

test("getEventsTail returns the empty array when the events file is empty", async () => {
  await withTempProject(async (projectPath) => {
    const sessionId = "s-tail-empty-file";
    // Manually create the file so it's present-but-empty (no appendEvent
    // call would create it without content; we want to exercise the
    // empty-file branch of the read path).
    const store = projectStoreDir(projectPath);
    mkdirSync(path.join(store, "events"), { recursive: true });
    writeFileSync(path.join(store, "events", `${sessionId}.jsonl`), "");
    const tail = await getEventsTail(projectPath, sessionId, { limit: 10 });
    assert.deepEqual(tail, []);
  });
});

test("getEventsTail rejects a non-positive limit", async () => {
  await withTempProject(async (projectPath) => {
    await assert.rejects(
      () => getEventsTail(projectPath, "any", { limit: 0 }),
      /positive limit/,
    );
    await assert.rejects(
      () => getEventsTail(projectPath, "any", { limit: -5 }),
      /positive limit/,
    );
  });
});

test("getEventsTail skips malformed tail lines without dropping the page size", async () => {
  await withTempProject(async (projectPath) => {
    const sessionId = "s-tail-malformed";
    await appendEvent(projectPath, sessionId, makeEvent(0));
    await appendEvent(projectPath, sessionId, makeEvent(1));
    // Append a half-written JSON line on its own line, then a valid
    // line. The helper should skip the malformed line and still return
    // as much of the requested page as it can.
    const { appendFileSync } = await import("node:fs");
    const store = projectStoreDir(projectPath);
    const filePath = path.join(store, "events", `${sessionId}.jsonl`);
    appendFileSync(filePath, '{"id":"evt-broken","sessionId":"s-tail-malformed"\n');
    await appendEvent(projectPath, sessionId, makeEvent(2, { id: "evt-2-good" }));
    const tail = await getEventsTail(projectPath, sessionId, { limit: 10 });
    // The broken line is skipped; the three well-formed lines survive.
    assert.equal(tail.length, 3);
    assert.deepEqual(
      tail.map((e) => e.id),
      ["evt-0", "evt-1", "evt-2-good"],
    );
  });
});

test("getEventsTail honors ?before= and returns every event ending just before the anchor", async () => {
  await withTempProject(async (projectPath) => {
    const sessionId = "s-tail-before";
    for (let i = 0; i < 10; i++) {
      await appendEvent(projectPath, sessionId, makeEvent(i, { id: `evt-${i}` }));
    }
    // Everything ending just before evt-5: should be evt-0..evt-4.
    const tail = await getEventsTail(projectPath, sessionId, {
      limit: 10,
      before: "evt-5",
    });
    assert.deepEqual(
      tail.map((e) => e.id),
      ["evt-0", "evt-1", "evt-2", "evt-3", "evt-4"],
    );
  });
});

test("getEventsTail ?before= with a limit smaller than the available window trims from the head", async () => {
  await withTempProject(async (projectPath) => {
    const sessionId = "s-tail-before-trim";
    for (let i = 0; i < 10; i++) {
      await appendEvent(projectPath, sessionId, makeEvent(i, { id: `evt-${i}` }));
    }
    // Ask for 3 events ending just before evt-8. The window is
    // [evt-0..evt-7] (8 events before the anchor). The helper trims
    // from the head to honor `limit`, returning the *last* 3 events
    // in the window: evt-5, evt-6, evt-7.
    const tail = await getEventsTail(projectPath, sessionId, {
      limit: 3,
      before: "evt-8",
    });
    assert.deepEqual(
      tail.map((e) => e.id),
      ["evt-5", "evt-6", "evt-7"],
    );
  });
});

test("getEventsTail rejects an empty `before` value", async () => {
  await withTempProject(async (projectPath) => {
    await assert.rejects(
      () => getEventsTail(projectPath, "any", { limit: 5, before: "" }),
      /non-empty event id/,
    );
  });
});

test("getEventsTail reads correctly when the line size spans a 64KiB chunk boundary", async () => {
  // Stress the chunked backward-reader: a single line larger than the
  // 64KiB read chunk forces the reader to assemble the line across two
  // reads. Pad the payload so the line is just over 64KiB.
  await withTempProject(async (projectPath) => {
    const sessionId = "s-tail-bigline";
    const padding = "x".repeat(70 * 1024);
    await appendEvent(
      projectPath,
      sessionId,
      makeEvent(0, { id: "evt-huge", data: { text: padding } }),
    );
    await appendEvent(projectPath, sessionId, makeEvent(1, { id: "evt-small" }));
    const tail = await getEventsTail(projectPath, sessionId, { limit: 5 });
    assert.equal(tail.length, 2);
    assert.equal(tail[0].id, "evt-huge");
    assert.equal(tail[0].data.text, padding);
    assert.equal(tail[1].id, "evt-small");
  });
});