import assert from "node:assert/strict";
import { test } from "node:test";
import {
  continueEmulatedSteerInBackground,
  type SteerStream,
} from "./background-emulated-steer.ts";

class FakeStream implements SteerStream {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  close(): void {
    this.closed = true;
  }

  emit(type: string): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type }) }));
  }
}

test("a detached steer resumes only its originating session after the stopped run ends", async () => {
  const stoppedRun = new FakeStream();
  const resumedRun = new FakeStream();
  const started: Array<{ sessionId?: string; text: string }> = [];
  const completed: string[] = [];
  const errors: Error[] = [];
  let resolveStop: () => void = () => {};
  const stopRequest = new Promise<void>((resolve) => { resolveStop = resolve; });

  continueEmulatedSteerInBackground(
    stoppedRun,
    {
      projectId: "coliseo",
      sessionId: "original",
      text: "steer text",
      options: { resumeSessionId: "other", worktreeId: "casa-revalidation" },
      stopRequest,
    },
    (_projectId, text, options) => {
      started.push({ sessionId: options.resumeSessionId, text });
      return resumedRun;
    },
    (sessionId) => completed.push(sessionId),
    (error) => errors.push(error),
  );

  stoppedRun.emit("anita_event");
  assert.equal(started.length, 0);
  stoppedRun.emit("done");
  assert.equal(stoppedRun.closed, true);
  assert.equal(started.length, 0);
  resolveStop();
  await stopRequest;
  await Promise.resolve();
  assert.deepEqual(started, [{ sessionId: "original", text: "steer text" }]);
  resumedRun.emit("done");
  assert.deepEqual(completed, ["original"]);
  assert.deepEqual(errors, []);
});

test("a failed stop cannot start a detached steer on another session", async () => {
  const stoppedRun = new FakeStream();
  let rejectStop: (error: Error) => void = () => {};
  const stopRequest = new Promise<void>((_resolve, reject) => { rejectStop = reject; });
  const errors: Error[] = [];
  let starts = 0;
  continueEmulatedSteerInBackground(
    stoppedRun,
    {
      projectId: "coliseo",
      sessionId: "original",
      text: "steer text",
      options: { resumeSessionId: "original" },
      stopRequest,
    },
    () => { starts += 1; return new FakeStream(); },
    () => {},
    (error) => errors.push(error),
  );
  rejectStop(new Error("stop failed"));
  await Promise.resolve();
  stoppedRun.emit("done");
  await Promise.resolve();
  assert.equal(starts, 0);
  assert.equal(stoppedRun.closed, true);
  assert.equal(errors[0]?.message, "stop failed");
});
