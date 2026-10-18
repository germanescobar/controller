import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tryAcquireSharedLoopOwner } from "../shared-loop-owner.js";

const unexpectedCompromise = (error: Error): void => { throw error; };

test("only one concurrent server can own a Controller home", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "controller-owner-"));
  try {
    const [first, second] = await Promise.all([
      tryAcquireSharedLoopOwner(home, unexpectedCompromise),
      tryAcquireSharedLoopOwner(home, unexpectedCompromise),
    ]);
    assert.equal(Number(first !== null) + Number(second !== null), 1);
    assert.equal(await tryAcquireSharedLoopOwner(home, unexpectedCompromise), null);
    const childCode = `import { tryAcquireSharedLoopOwner } from ${JSON.stringify(new URL("../shared-loop-owner.ts", import.meta.url).href)};
const release = await tryAcquireSharedLoopOwner(${JSON.stringify(home)}, (error) => { throw error; });
console.log(release ? "owner" : "secondary");
await release?.();`;
    const child = async () => (await promisify(execFile)(process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childCode])).stdout.trim();
    assert.equal(await child(), "secondary", "another process cannot start shared work");
    await (first ?? second)?.();
    assert.equal(await child(), "owner", "another process can take over after release");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("different homes can own shared work independently", async () => {
  const firstHome = await fs.mkdtemp(path.join(os.tmpdir(), "controller-owner-a-"));
  const secondHome = await fs.mkdtemp(path.join(os.tmpdir(), "controller-owner-b-"));
  try {
    const [first, second] = await Promise.all([
      tryAcquireSharedLoopOwner(firstHome, unexpectedCompromise),
      tryAcquireSharedLoopOwner(secondHome, unexpectedCompromise),
    ]);
    assert.ok(first);
    assert.ok(second);
    await Promise.all([first(), second()]);
  } finally {
    await Promise.all([fs.rm(firstHome, { recursive: true, force: true }), fs.rm(secondHome, { recursive: true, force: true })]);
  }
});

test("a symlink alias cannot claim the same home twice", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "controller-owner-alias-"));
  const alias = `${home}-alias`;
  try {
    await fs.symlink(home, alias, "dir");
    const release = await tryAcquireSharedLoopOwner(home, unexpectedCompromise);
    assert.ok(release);
    assert.equal(await tryAcquireSharedLoopOwner(alias, unexpectedCompromise), null);
    await release();
  } finally {
    await fs.rm(alias, { force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("a stale lock left by a crashed owner is reclaimed", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "controller-owner-stale-"));
  const lockDir = `${home}.lock`;
  try {
    await fs.mkdir(lockDir);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockDir, old, old);
    const release = await tryAcquireSharedLoopOwner(home, unexpectedCompromise);
    assert.ok(release);
    await release();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});
