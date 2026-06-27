import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentProvider } from "../agents.js";

const claude = getAgentProvider("claude");
assert.ok(claude, "claude provider must be registered");

/**
 * Spawn the Claude provider against a fake `claude` shim that prints its argv
 * as JSON and exits, so we can assert how auto-approve maps onto the CLI's
 * permission mode and control-channel flags without Claude installed.
 */
function captureClaudeArgs(options: Record<string, unknown>): Promise<string[]> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "claude-spawn-"));
  const shim = path.join(dir, "claude");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      "node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- \"$@\"",
      "",
    ].join("\n")
  );
  chmodSync(shim, 0o755);
  const child = claude!.spawn({
    message: "Hello",
    cwd: dir,
    env: {},
    command: shim,
    resumeSessionId: undefined,
    model: undefined,
    reasoningEffort: undefined,
    serviceTier: undefined,
    mode: "default",
    ...options,
  } as Parameters<NonNullable<typeof claude>["spawn"]>[0]);

  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    // Control-channel mode keeps stdin open; ignore EPIPE from the shim exiting.
    child.stdin?.on("error", () => {});
    child.on("error", reject);
    child.on("close", () => {
      rmSync(dir, { recursive: true, force: true });
      try {
        resolve(JSON.parse(out) as string[]);
      } catch (parseErr) {
        reject(new Error(`failed to parse shim output as JSON: '${out}' (${parseErr})`));
      }
    });
  });
}

test("claude auto-approve on runs with bypassPermissions and no control channel", async () => {
  const args = await captureClaudeArgs({ autoApprove: true });
  const modeIndex = args.indexOf("--permission-mode");
  assert.ok(modeIndex >= 0, `expected --permission-mode, got: ${args.join(" ")}`);
  assert.equal(args[modeIndex + 1], "bypassPermissions");
  assert.ok(
    !args.includes("--permission-prompt-tool"),
    `auto-approve on must not open the control channel, got: ${args.join(" ")}`
  );
  // The prompt is passed as a plain argv argument in autonomous mode.
  assert.ok(args.includes("Hello"), `expected prompt in argv: ${args.join(" ")}`);
});

test("claude auto-approve off uses default mode + stdio approval control channel", async () => {
  const args = await captureClaudeArgs({ autoApprove: false });
  const modeIndex = args.indexOf("--permission-mode");
  assert.equal(args[modeIndex + 1], "default");
  const promptToolIndex = args.indexOf("--permission-prompt-tool");
  assert.ok(promptToolIndex >= 0, `off must set --permission-prompt-tool, got: ${args.join(" ")}`);
  assert.equal(args[promptToolIndex + 1], "stdio");
  assert.ok(
    args.includes("--input-format"),
    `off must stream input over stdin, got: ${args.join(" ")}`
  );
  // The prompt is delivered over the control channel, not as an argv arg.
  assert.ok(!args.includes("Hello"), `prompt must not be an argv arg, got: ${args.join(" ")}`);
});

test("claude plan mode keeps the control channel regardless of auto-approve", async () => {
  const args = await captureClaudeArgs({ mode: "plan", autoApprove: true });
  const modeIndex = args.indexOf("--permission-mode");
  assert.equal(args[modeIndex + 1], "plan");
  assert.ok(
    args.includes("--permission-prompt-tool"),
    `plan mode must open the control channel, got: ${args.join(" ")}`
  );
});
