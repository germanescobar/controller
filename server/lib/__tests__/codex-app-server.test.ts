import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  CodexAppServerManager,
  type AppServerChild,
  type CallTimeouts,
} from "../codex-app-server.js";
import type { AgentStreamEvent } from "../agents.js";

interface JsonRpcRequest {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

type Responder = (request: JsonRpcRequest, child: FakeChild) => void;

/* In-memory stand-in for a `codex app-server` process. Each request written
 * to stdin is handed to `respond`, which can reply via `reply`/`fail` or stay
 * silent to simulate a hung server. */
class FakeChild extends EventEmitter implements AppServerChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly requests: JsonRpcRequest[] = [];
  killed = false;

  constructor(respond: Responder) {
    super();
    let buffered = "";
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        buffered += chunk.toString("utf-8");
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          const request = JSON.parse(buffered.slice(0, newline)) as JsonRpcRequest;
          buffered = buffered.slice(newline + 1);
          this.requests.push(request);
          respond(request, this);
          newline = buffered.indexOf("\n");
        }
        callback();
      },
    });
  }

  reply(id: number, result: unknown) {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  fail(id: number, message: string) {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { message } })}\n`);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const FAST_TIMEOUTS: CallTimeouts = { initializeMs: 50, turnStartMs: 50, defaultMs: 50 };

function managerWith(responders: Responder[]) {
  const children: FakeChild[] = [];
  const manager = new CodexAppServerManager({
    timeouts: FAST_TIMEOUTS,
    spawnAppServer: async () => {
      const respond = responders[children.length] ?? responders[responders.length - 1];
      const child = new FakeChild(respond);
      children.push(child);
      return child;
    },
  });
  return { manager, children };
}

const healthy: Responder = (request, child) => {
  if (request.id === undefined) return;
  if (request.method === "thread/start") {
    child.reply(request.id, { thread: { id: "thread-1" } });
  } else if (request.method === "turn/start") {
    child.reply(request.id, { turn: { id: "turn-1" } });
  } else {
    child.reply(request.id, {});
  }
};

const rejectsInitialize: Responder = (request, child) => {
  if (request.method === "initialize" && request.id !== undefined) {
    child.fail(request.id, "initialize exploded");
  }
};

const silent: Responder = () => {};

const turnStartHangs: Responder = (request, child) => {
  if (request.method === "turn/start") return;
  healthy(request, child);
};

const turnOptions = { message: "hi", cwd: "/tmp", env: {}, mode: "default" as const };

test("a rejected initialize is not cached: the next call spawns a fresh app-server", async () => {
  const { manager, children } = managerWith([rejectsInitialize, healthy]);

  await assert.rejects(() => manager.listModels({}), /initialize exploded/);
  assert.equal(children.length, 1);
  assert.equal(children[0].killed, true);

  assert.deepEqual(await manager.listModels({}), []);
  assert.equal(children.length, 2);
});

test("an initialize that never answers times out and the next call respawns", async () => {
  const { manager, children } = managerWith([silent, healthy]);

  await assert.rejects(() => manager.listModels({}), /did not answer initialize within 50ms/);
  assert.equal(children[0].killed, true);

  await manager.listModels({});
  assert.equal(children.length, 2);
});

test("a turn/start that never answers rejects after the timeout and emits run.failed", async () => {
  const { manager } = managerWith([turnStartHangs]);
  const events: AgentStreamEvent[] = [];

  await assert.rejects(
    () => manager.startPlanTurn(turnOptions, (event) => events.push(event)),
    /did not answer turn\/start within 50ms/
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ["run.started", "run.failed"]
  );
});

test("a late close from a previous child does not clear the current child or sessions", async () => {
  const { manager, children } = managerWith([rejectsInitialize, healthy]);
  await assert.rejects(() => manager.listModels({}));

  const turn = await manager.startPlanTurn(turnOptions, () => {});
  turn.done.catch(() => {});
  children[0].emit("close");

  // The session survived: steering reaches the current child.
  assert.equal(await manager.steerSession(turn.sessionId, "more"), "steered");
  assert.equal(children.length, 2);
  assert.ok(children[1].requests.some((request) => request.method === "turn/steer"));
});

test("an EPIPE on stdin fails pending calls instead of throwing uncaught", async () => {
  const { manager, children } = managerWith([silent, healthy]);
  const pending = manager.listModels({});
  await new Promise((resolve) => setImmediate(resolve));

  const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  children[0].stdin.emit("error", epipe);

  await assert.rejects(pending, /stdin failed: write EPIPE/);
  assert.equal(children[0].killed, true);
  await manager.listModels({});
  assert.equal(children.length, 2);
});
