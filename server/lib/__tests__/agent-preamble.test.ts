import test from "node:test";
import assert from "node:assert/strict";
import {
  buildControllerPreamble,
  framePreambleForPrompt,
} from "../agent-preamble.js";

test("always states the agent is running inside Controller", () => {
  const preamble = buildControllerPreamble();
  assert.match(preamble, /running inside Controller/);
});

test("framing marks the block as context-only", () => {
  const framed = framePreambleForPrompt("hello");
  assert.match(framed, /do not repeat back/i);
  assert.match(framed, /hello/);
});
