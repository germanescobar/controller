import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  enqueue,
  listQueue,
  removeFromQueue,
  resolveQueuedMessage,
  dequeueFirst,
  clearQueue,
  withSessionQueueTransaction,
  type QueuedMessageInput,
} from "../session-queue.js";
import { sessionQueueFile } from "../paths.js";

function withTempHome(run: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "session-queue-"));
  const original = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;
  return run().finally(() => {
    if (original === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = original;
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

test("resolveQueuedMessage blocks dequeue until promoted ownership is settled", async () => {
  await withTempHome(async () => {
    const promoted = await enqueue("s1", input("promoted"));
    await enqueue("s1", input("next"));

    let releaseResolver: (() => void) | undefined;
    const resolverEntered = new Promise<void>((resolve) => {
      releaseResolver = resolve;
    });
    let allowResolution: (() => void) | undefined;
    const resolutionAllowed = new Promise<void>((resolve) => {
      allowResolution = resolve;
    });

    const resolution = resolveQueuedMessage("s1", promoted.id, async () => {
      releaseResolver?.();
      await resolutionAllowed;
      return { result: "steered" as const, remove: true };
    });
    await resolverEntered;

    let dequeueSettled = false;
    const dequeue = dequeueFirst("s1").finally(() => {
      dequeueSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(dequeueSettled, false, "dequeue must wait for steer ownership");

    allowResolution?.();
    assert.equal((await resolution).removed, true);
    assert.equal((await dequeue)?.text, "next");
    assert.deepEqual(await listQueue("s1"), []);
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

test("lifecycle transactions serialize concurrent enqueues", async () => {
  await withTempHome(async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });

    const transaction = withSessionQueueTransaction("s1", async (queue) => {
      entered();
      await held;
      await queue.clear();
    });
    await started;
    let enqueued = false;
    const pending = enqueue("s1", input("after archive")).then(() => {
      enqueued = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(enqueued, false);
    release();
    await Promise.all([transaction, pending]);
    assert.equal(enqueued, true);
  });
});
