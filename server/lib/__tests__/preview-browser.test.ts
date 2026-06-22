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
