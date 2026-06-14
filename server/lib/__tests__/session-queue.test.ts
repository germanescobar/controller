import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  enqueue,
  listQueue,
  removeFromQueue,
  dequeueFirst,
  clearQueue,
  type QueuedMessageInput,
} from "../session-queue.js";
import { sessionQueueFile } from "../paths.js";

function withTempHome(run: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "session-queue-"));
  const original = process.env.CODING_ORCHESTRATOR_HOME;
  process.env.CODING_ORCHESTRATOR_HOME = dir;
  return run().finally(() => {
    if (original === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
    else process.env.CODING_ORCHESTRATOR_HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });
}

function input(text: string): QueuedMessageInput {
  return {
    text,
    visibleText: text,
    provider: "claude",
    model: "claude/test",
    mode: "default",
    attachmentIds: [],
  };
}

test("listQueue returns an empty array for an unknown session", async () => {
  await withTempHome(async () => {
    assert.deepEqual(await listQueue("missing"), []);
  });
});

test("enqueue appends in order and assigns id + createdAt", async () => {
  await withTempHome(async () => {
    const first = await enqueue("s1", input("one"));
    const second = await enqueue("s1", input("two"));

    assert.ok(first.id);
    assert.ok(first.createdAt);
    assert.notEqual(first.id, second.id);

    const queue = await listQueue("s1");
    assert.deepEqual(
      queue.map((m) => m.text),
      ["one", "two"]
    );
  });
});

test("dequeueFirst removes and returns the head, then null when empty", async () => {
  await withTempHome(async () => {
    await enqueue("s1", input("one"));
    await enqueue("s1", input("two"));

    const first = await dequeueFirst("s1");
    assert.equal(first?.text, "one");
    assert.deepEqual((await listQueue("s1")).map((m) => m.text), ["two"]);

    const second = await dequeueFirst("s1");
    assert.equal(second?.text, "two");
    assert.equal(await dequeueFirst("s1"), null);
  });
});

test("removeFromQueue removes by id and reports whether it matched", async () => {
  await withTempHome(async () => {
    const a = await enqueue("s1", input("a"));
    await enqueue("s1", input("b"));

    assert.equal(await removeFromQueue("s1", a.id), true);
    assert.deepEqual((await listQueue("s1")).map((m) => m.text), ["b"]);
    assert.equal(await removeFromQueue("s1", "nope"), false);
  });
});

test("queues are isolated per session", async () => {
  await withTempHome(async () => {
    await enqueue("s1", input("s1-msg"));
    await enqueue("s2", input("s2-msg"));

    assert.deepEqual((await listQueue("s1")).map((m) => m.text), ["s1-msg"]);
    assert.deepEqual((await listQueue("s2")).map((m) => m.text), ["s2-msg"]);
  });
});

test("clearQueue deletes the session's queue file", async () => {
  await withTempHome(async () => {
    await enqueue("s1", input("one"));
    assert.ok(existsSync(sessionQueueFile("s1")));

    await clearQueue("s1");
    assert.equal(existsSync(sessionQueueFile("s1")), false);
    assert.deepEqual(await listQueue("s1"), []);
  });
});

test("concurrent enqueues are serialized without dropping writes", async () => {
  await withTempHome(async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => enqueue("s1", input(`m${i}`)))
    );
    const queue = await listQueue("s1");
    assert.equal(queue.length, 10);
    assert.equal(new Set(queue.map((m) => m.text)).size, 10);
  });
});
