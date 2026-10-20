import test from "node:test";
import assert from "node:assert/strict";
import { isReplayDeviceResponse } from "./terminal-replay.ts";

test("replayed terminal identification answers are discarded, including batched answers", () => {
  assert.equal(isReplayDeviceResponse("\x1b[?1;2c"), true);
  assert.equal(isReplayDeviceResponse("\x1b[>0;276;0c"), true);
  assert.equal(isReplayDeviceResponse("\x1b[?1;2c\x1b[>0;276;0c"), true);
  assert.equal(isReplayDeviceResponse("ls\r"), false);
  assert.equal(isReplayDeviceResponse("\x1b[A"), false);
});
