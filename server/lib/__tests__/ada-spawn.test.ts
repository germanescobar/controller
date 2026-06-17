import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { spawn as childSpawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { getAgentProvider } from "../agents.js";

const ada = getAgentProvider("ada");
assert.ok(ada, "ada provider must be registered");

/**
 * Spawn the Ada provider against a tiny fake `ada` shim that prints its argv
 * as JSON and exits. Returns the parsed argv array, which is what the provider
 * would have handed to `child_process.spawn`.
 *
 * The shim lives in a temp dir so we don't need `ada` actually installed —
 * the test asserts how the orchestrator wires the CLI invocation, not what
 * Ada does internally.
 */
function captureAdaArgs(options: Record<string, unknown>): Promise<string[]> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ada-spawn-"));
  const shim = path.join(dir, "ada");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      // `node -e` puts user args at process.argv[1+] (no [eval] placeholder
      // is exposed for inline scripts). The `--` separator guards against
      // node treating leading-dash args (e.g. `--stream-json`) as its own
      // CLI options. JSON-encode the user args so the test can recover
      // exact slot values (no whitespace collapsing from shell `$*`).
      "node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- \"$@\"",
      "",
    ].join("\n")
  );
  chmodSync(shim, 0o755);
  const child = ada!.spawn({
    message: "Hello",
    cwd: dir,
    env: {},
    command: shim,
    resumeSessionId: undefined,
    model: "test/model",
    reasoningEffort: undefined,
    serviceTier: undefined,
    ...options,
  } as Parameters<NonNullable<typeof ada>["spawn"]>[0]);

  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      rmSync(dir, { recursive: true, force: true });
      if (!out && err) {
        reject(new Error(`shim produced no stdout. stderr=${err} exit=${code}`));
        return;
      }
      try {
        resolve(JSON.parse(out) as string[]);
      } catch (parseErr) {
        reject(
          new Error(
            `failed to parse shim output as JSON: '${out}' stderr='${err}' exit=${code} (${parseErr})`
          )
        );
      }
    });
  });
}

test("ada spawn does not pass --system-prompt when none is provided", async () => {
  const args = await captureAdaArgs({ systemPrompt: undefined });
  assert.ok(
    !args.includes("--system-prompt"),
    `unexpected --system-prompt in argv: ${args.join(" ")}`
  );
});

test("ada spawn passes --system-prompt before the chat subcommand", async () => {
  const prompt = "You are running inside Controller.";
  const args = await captureAdaArgs({ systemPrompt: prompt });
  const flagIndex = args.indexOf("--system-prompt");
  assert.ok(
    flagIndex >= 0,
    `expected --system-prompt in argv: ${args.join(" ")}`
  );
  assert.equal(args[flagIndex + 1], prompt, "system prompt value follows the flag");
  const chatIndex = args.indexOf("chat");
  assert.ok(
    flagIndex < chatIndex,
    `--system-prompt must come before the chat subcommand, got: ${args.join(" ")}`
  );
});

test("ada spawn omits --system-prompt when the value is empty/whitespace", async () => {
  const args = await captureAdaArgs({ systemPrompt: "   \n  " });
  assert.ok(
    !args.includes("--system-prompt"),
    `empty systemPrompt should not emit the flag, got: ${args.join(" ")}`
  );
});

test("ada spawn keeps the user message in argv (not folded into system prompt)", async () => {
  const args = await captureAdaArgs({
    message: "what is the weather?",
    systemPrompt: "static identity context",
  });
  assert.ok(
    args.includes("what is the weather?"),
    `user message must be present in argv: ${args.join(" ")}`
  );
  // The system prompt and the user message must be separate argv slots —
  // never concatenated. (`child_process.spawn` already enforces this when
  // given an args array, but assert it explicitly so a future refactor
  // that switches to shell-joined strings fails fast.)
  const flagIndex = args.indexOf("--system-prompt");
  const userMessageIndex = args.indexOf("what is the weather?");
  assert.ok(flagIndex >= 0, `missing --system-prompt in argv: ${args.join(" ")}`);
  assert.ok(userMessageIndex >= 0, `missing user message in argv: ${args.join(" ")}`);
  assert.notEqual(args[flagIndex + 1], "what is the weather?");
});

test("child_process.spawn resolves an installed binary (sanity)", () => {
  // Smoke test that the testing environment can launch a real child and
  // capture stdout. Without this guard, the rest of this file's tests could
  // silently no-op in a stripped-down environment (e.g. a CI image without
  // /bin/sh).
  const dir = mkdtempSync(path.join(os.tmpdir(), "spawn-sanity-"));
  const shim = path.join(dir, "shim");
  writeFileSync(shim, "#!/bin/sh\necho hello\n");
  chmodSync(shim, 0o755);
  const child = childSpawn(shim, [], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise<void>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => {
      rmSync(dir, { recursive: true, force: true });
      assert.equal(out.trim(), "hello", `expected shim to print 'hello', got '${out}'`);
      resolve();
    });
  });
});
