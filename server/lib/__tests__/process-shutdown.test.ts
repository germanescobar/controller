import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installSessionRuntimeShutdownHandlers } from "../process-shutdown.js";

function fakeProcess() {
  const emitter = new EventEmitter();
  const signals: Array<[number, NodeJS.Signals]> = [];
  const target = Object.assign(emitter, {
    pid: 1234,
    kill(pid: number, signal: NodeJS.Signals) {
      signals.push([pid, signal]);
      return true;
    },
  }) as unknown as Pick<
    NodeJS.Process,
    "pid" | "once" | "removeAllListeners" | "kill"
  >;
  return { emitter, signals, target };
}

test("normal process exit stops active session runtimes and monitors", () => {
  const { emitter, target } = fakeProcess();
  let stops = 0;
  let monitorStops = 0;
  installSessionRuntimeShutdownHandlers(
    target,
    () => ++stops,
    () => ++monitorStops
  );

  emitter.emit("exit");

  assert.equal(stops, 1);
  assert.equal(monitorStops, 1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`${signal} stops runtimes and monitors, then restores default signal behavior`, () => {
    const { emitter, signals, target } = fakeProcess();
    let stops = 0;
    let monitorStops = 0;
    installSessionRuntimeShutdownHandlers(
      target,
      () => ++stops,
      () => ++monitorStops
    );

    emitter.emit(signal);

    assert.equal(stops, 1);
    assert.equal(monitorStops, 1);
    assert.equal(emitter.listenerCount(signal), 0);
    assert.deepEqual(signals, [[1234, signal]]);
  });
}
