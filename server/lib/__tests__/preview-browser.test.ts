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
    previewBrowserBridge.execute("missing:key", "snapshot", {}, 50),
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
