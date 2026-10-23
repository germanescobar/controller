import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { previewBrowserBridge } from "../preview-browser.js";

/** Minimal stand-in for a `ws` socket: EventEmitter + a capturing `send`. */
class FakeSocket extends EventEmitter {
  public sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

function register(socket: FakeSocket, key: string): void {
  socket.emit("message", Buffer.from(JSON.stringify({ kind: "register", key })));
}

function registerController(socket: FakeSocket): void {
  socket.emit(
    "message",
    Buffer.from(JSON.stringify({ kind: "register-controller" }))
  );
}

test("forwards a command to the registered host and resolves with its result", async () => {
  const socket = new FakeSocket();
  previewBrowserBridge.handleConnection(socket as never);
  register(socket, "p1:w1");

  const pending = previewBrowserBridge.execute("p1:w1", "snapshot", {});

  // The bridge should have sent exactly one command frame.
  assert.equal(socket.sent.length, 1);
  const command = JSON.parse(socket.sent[0]);
  assert.equal(command.kind, "command");
  assert.equal(command.action, "snapshot");

  socket.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        kind: "result",
        requestId: command.requestId,
        result: { ok: true, text: "hello" },
      })
    )
  );

  const result = await pending;
  assert.deepEqual(result, { ok: true, text: "hello" });
});

test("orders navigation, snapshot, and action for one pane", async () => {
  const socket = new FakeSocket();
  previewBrowserBridge.handleConnection(socket as never);
  register(socket, "p-order:w-order");

  const opened = previewBrowserBridge.execute("p-order:w-order", "open", { url: "http://localhost/next" });
  const snapped = previewBrowserBridge.execute("p-order:w-order", "snapshot", {});
  const clicked = previewBrowserBridge.execute("p-order:w-order", "click", { selector: "#go" });
  assert.equal(socket.sent.length, 1);

  const reply = (index: number) => {
    const frame = JSON.parse(socket.sent[index]);
    socket.emit("message", Buffer.from(JSON.stringify({ kind: "result", requestId: frame.requestId, result: { ok: true, summary: frame.action } })));
  };
  reply(0);
  await opened;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.length, 2);
  assert.equal(JSON.parse(socket.sent[1]).action, "snapshot");
  reply(1);
  await snapped;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.length, 3);
  assert.equal(JSON.parse(socket.sent[2]).action, "click");
  reply(2);
  assert.deepEqual(await clicked, { ok: true, summary: "click" });
});

test("rejects when no host is connected for the key", async () => {
  await assert.rejects(
    previewBrowserBridge.execute("missing:key", "snapshot", {}, { hostWaitMs: 50 }),
    /No preview pane/
  );
});

test("drops the host on close so later commands reject", async () => {
  const socket = new FakeSocket();
  previewBrowserBridge.handleConnection(socket as never);
  register(socket, "p2:w2");
  assert.equal(previewBrowserBridge.hasHost("p2:w2"), true);

  socket.emit("close");
  assert.equal(previewBrowserBridge.hasHost("p2:w2"), false);
});

test("waits briefly for a host to register before rejecting (issue #170)", async () => {
  // No host is registered yet. Schedule one to appear after a short delay.
  const socket = new FakeSocket();
  setTimeout(() => previewBrowserBridge.handleConnection(socket as never), 0);
  setTimeout(() => register(socket, "p3:w3"), 150);

  const start = Date.now();
  const pending = previewBrowserBridge.execute(
    "p3:w3",
    "snapshot",
    {},
    { hostWaitMs: 1000 }
  );
  // The bridge should not have sent anything yet (no host at the time of the
  // call). After ~150ms the renderer should connect and the command should
  // be forwarded.
  assert.equal(socket.sent.length, 0);
  socket.sent.length = 0;

  // Replay the first command after the host appears: this is the one the
  // bridge is waiting on.
  setTimeout(() => {
    if (socket.sent.length > 0) {
      const command = JSON.parse(socket.sent[0]);
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            kind: "result",
            requestId: command.requestId,
            result: { ok: true, text: "late" },
          })
        )
      );
    }
  }, 250);

  const result = await pending;
  assert.deepEqual(result, { ok: true, text: "late" });
  // Sanity: the wait was real (>= 150ms).
  assert.ok(Date.now() - start >= 100, "waited at least 100ms for the host");
});

test("asks the desktop registry to create an unvisited worktree pane", async () => {
  const registry = new FakeSocket();
  previewBrowserBridge.handleConnection(registry as never);
  registerController(registry);

  const pane = new FakeSocket();
  const pending = previewBrowserBridge.execute(
    "p-lazy:w-lazy",
    "snapshot",
    {},
    { hostWaitMs: 1_000, ensureHost: { projectRoot: "/tmp/lazy" } }
  );

  assert.equal(registry.sent.length, 1);
  assert.deepEqual(JSON.parse(registry.sent[0]), {
    kind: "ensure-pane",
    key: "p-lazy:w-lazy",
    projectRoot: "/tmp/lazy",
  });

  previewBrowserBridge.handleConnection(pane as never);
  register(pane, "p-lazy:w-lazy");
  setTimeout(() => {
    const command = JSON.parse(pane.sent[0]);
    pane.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          kind: "result",
          requestId: command.requestId,
          result: { ok: true, text: "created lazily" },
        })
      )
    );
  }, 150);

  assert.deepEqual(await pending, { ok: true, text: "created lazily" });
});

test("uses only the latest desktop registry and drops it on disconnect", async () => {
  const oldRegistry = new FakeSocket();
  const activeRegistry = new FakeSocket();
  previewBrowserBridge.handleConnection(oldRegistry as never);
  previewBrowserBridge.handleConnection(activeRegistry as never);
  registerController(oldRegistry);
  registerController(activeRegistry);

  await assert.rejects(
    previewBrowserBridge.execute(
      "p-window:w-window",
      "snapshot",
      {},
      { hostWaitMs: 50, ensureHost: { projectRoot: "/tmp/window" } }
    ),
    /No preview pane/
  );
  assert.equal(oldRegistry.sent.length, 0);
  assert.equal(activeRegistry.sent.length, 1);

  activeRegistry.emit("close");
  await assert.rejects(
    previewBrowserBridge.execute(
      "p-closed:w-closed",
      "snapshot",
      {},
      { hostWaitMs: 50, ensureHost: { projectRoot: "/tmp/closed" } }
    ),
    /No preview pane/
  );
  assert.equal(activeRegistry.sent.length, 1);
});

test("rejects fast when no host appears within the grace window", async () => {
  const start = Date.now();
  await assert.rejects(
    previewBrowserBridge.execute(
      "nope:key",
      "snapshot",
      {},
      { hostWaitMs: 100 }
    ),
    /No preview pane/
  );
  // Should fail in roughly the grace window, not the full 20s default.
  assert.ok(Date.now() - start < 1_000, "rejected within the grace window");
});
