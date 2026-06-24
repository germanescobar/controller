import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { spawn as childSpawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { getAgentProvider } from "../agents.js";

const anita = getAgentProvider("anita");
assert.ok(anita, "anita provider must be registered");

/**
 * Spawn the Anita provider against a tiny fake `anita` shim that prints its argv
 * as JSON and exits. Returns the parsed argv array, which is what the provider
 * would have handed to `child_process.spawn`.
 *
 * The shim lives in a temp dir so we don't need `anita` actually installed —
 * the test asserts how the orchestrator wires the CLI invocation, not what
 * Anita does internally.
 */
function captureAnitaArgs(options: Record<string, unknown>): Promise<string[]> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "anita-spawn-"));
  const shim = path.join(dir, "anita");
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
  const child = anita!.spawn({
    message: "Hello",
    cwd: dir,
    env: {},
    command: shim,
    resumeSessionId: undefined,
    model: "test/model",
    reasoningEffort: undefined,
    serviceTier: undefined,
    ...options,
  } as Parameters<NonNullable<typeof anita>["spawn"]>[0]);

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

test("anita spawn does not pass --system-prompt when none is provided", async () => {
  const args = await captureAnitaArgs({ systemPrompt: undefined });
  assert.ok(
    !args.includes("--system-prompt"),
    `unexpected --system-prompt in argv: ${args.join(" ")}`
  );
});

test("anita spawn passes --system-prompt before the chat subcommand", async () => {
  const prompt = "You are running inside Controller.";
  const args = await captureAnitaArgs({ systemPrompt: prompt });
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

test("anita spawn omits --system-prompt when the value is empty/whitespace", async () => {
  const args = await captureAnitaArgs({ systemPrompt: "   \n  " });
  assert.ok(
    !args.includes("--system-prompt"),
    `empty systemPrompt should not emit the flag, got: ${args.join(" ")}`
  );
});

test("anita spawn keeps the user message in argv (not folded into system prompt)", async () => {
  const args = await captureAnitaArgs({
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

test("anita spawn omits --model when the value is empty/whitespace", async () => {
  // Issue #213: emitting `--model ""` made the anita CLI fail with
  // "Invalid model format" before any `run.started` event landed, which
  // surfaced as the misleading "Agent exited before reporting a sessionId"
  // preflight error. The provider must omit the flag entirely when no
  // model is supplied.
  for (const modelValue of [undefined, "", "   ", "\n  \t"]) {
    const args = await captureAnitaArgs({ model: modelValue });
    assert.ok(
      !args.includes("--model"),
      `empty model ${JSON.stringify(modelValue)} should not emit --model, got: ${args.join(" ")}`
    );
  }
});

test("anita spawn passes --model before the chat subcommand when supplied", async () => {
  const args = await captureAnitaArgs({ model: "ollama/glm-4.7-flash:latest" });
  const flagIndex = args.indexOf("--model");
  assert.ok(flagIndex >= 0, `expected --model in argv: ${args.join(" ")}`);
  assert.equal(args[flagIndex + 1], "ollama/glm-4.7-flash:latest");
  const chatIndex = args.indexOf("chat");
  assert.ok(
    flagIndex < chatIndex,
    `--model must come before the chat subcommand, got: ${args.join(" ")}`
  );
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

const codex = getAgentProvider("codex");
assert.ok(codex, "codex provider must be registered");

/**
 * Spawn the Codex provider against a tiny fake `codex` shim that prints its
 * argv as JSON and exits. Mirrors `captureAnitaArgs` for the codex spawn
 * path so the test suite covers both providers' `--model` handling in one
 * place (issue #213).
 */
function captureCodexArgs(options: Record<string, unknown>): Promise<string[]> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-spawn-"));
  const shim = path.join(dir, "codex");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      "node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- \"$@\"",
      "",
    ].join("\n")
  );
  chmodSync(shim, 0o755);
  const child = codex!.spawn({
    message: "Hello",
    cwd: dir,
    env: {},
    command: shim,
    resumeSessionId: undefined,
    model: "test/model",
    reasoningEffort: undefined,
    serviceTier: undefined,
    mode: undefined,
    ...options,
  } as Parameters<NonNullable<typeof codex>["spawn"]>[0]);

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

test("codex spawn omits --model when the value is empty/whitespace", async () => {
  // Belt-and-suspenders companion to the anita test: the codex provider
  // has the same latent issue described in issue #213.
  for (const modelValue of [undefined, "", "   ", "\n  \t"]) {
    const args = await captureCodexArgs({ model: modelValue });
    assert.ok(
      !args.includes("--model"),
      `empty model ${JSON.stringify(modelValue)} should not emit --model, got: ${args.join(" ")}`
    );
  }
});

test("codex spawn passes --model when supplied", async () => {
  const args = await captureCodexArgs({ model: "gpt-5" });
  const flagIndex = args.indexOf("--model");
  assert.ok(flagIndex >= 0, `expected --model in argv: ${args.join(" ")}`);
  assert.equal(args[flagIndex + 1], "gpt-5");
});
