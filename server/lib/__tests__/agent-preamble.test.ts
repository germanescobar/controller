import test from "node:test";
import assert from "node:assert/strict";
import {
  buildControllerPreamble,
  framePreambleForPrompt,
} from "../agent-preamble.js";

const CLI_PATH = "/home/me/coding-orchestrator/bin/controller-browser";

test("always states the agent is running inside Controller", () => {
  const preamble = buildControllerPreamble({
    browserAvailable: false,
    cliPath: CLI_PATH,
  });
  assert.match(preamble, /running inside Controller/);
  // No browser instructions when no pane is connected.
  assert.doesNotMatch(preamble, /controller-browser/);
});

test("advertises the browser CLI by absolute path when a pane is connected", () => {
  const preamble = buildControllerPreamble({
    browserAvailable: true,
    cliPath: CLI_PATH,
  });
  assert.match(preamble, /running inside Controller/);
  // The CLI is invoked by its absolute install path (not on PATH).
  assert.match(preamble, new RegExp(`"${CLI_PATH}" open`));
  assert.match(preamble, new RegExp(`"${CLI_PATH}" snapshot`));
});

test("framing marks the block as context-only", () => {
  const framed = framePreambleForPrompt("hello");
  assert.match(framed, /do not repeat back/i);
  assert.match(framed, /hello/);
});
