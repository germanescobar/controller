import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveCommand,
  clearCommandResolverCache,
} from "../command-resolver.js";

function withTempBin(run: (dir: string, exePath: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cmd-resolver-"));
  const exePath = path.join(dir, "fake-cli");
  writeFileSync(exePath, "#!/bin/sh\necho hi\n");
  chmodSync(exePath, 0o755);
  try {
    run(dir, exePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveCommand finds an executable on PATH", () => {
  withTempBin((dir) => {
    const originalPath = process.env.PATH;
    process.env.PATH = dir;
    clearCommandResolverCache();
    try {
      assert.equal(resolveCommand("fake-cli"), path.join(dir, "fake-cli"));
    } finally {
      process.env.PATH = originalPath;
      clearCommandResolverCache();
    }
  });
});

test("resolveCommand returns null when the command is missing", () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent-dir-xyz";
  clearCommandResolverCache();
  try {
    assert.equal(resolveCommand("definitely-not-a-real-cli"), null);
  } finally {
    process.env.PATH = originalPath;
    clearCommandResolverCache();
  }
});

test("resolveCommand honors an explicit override path", () => {
  withTempBin((_dir, exePath) => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent-dir-xyz";
    clearCommandResolverCache();
    try {
      assert.equal(resolveCommand("fake-cli", exePath), exePath);
    } finally {
      process.env.PATH = originalPath;
      clearCommandResolverCache();
    }
  });
});

test("resolveCommand returns null for a non-executable override path", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cmd-resolver-"));
  const filePath = path.join(dir, "not-exec");
  writeFileSync(filePath, "data");
  chmodSync(filePath, 0o644);
  clearCommandResolverCache();
  try {
    assert.equal(resolveCommand("fake-cli", filePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    clearCommandResolverCache();
  }
});
