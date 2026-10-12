import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Tests for the mtime-based conflict detection on
 * `PUT /api/projects/:projectId/source` (Codex P1 review, PR #422).
 *
 * The route accepts an optional `baseMtime` in the body. When
 * present and the file already exists, the on-disk mtime must
 * still match — otherwise an external write happened between the
 * GET and the PUT and we return 412 to refuse the clobber.
 *
 *   - Matching mtime → 200 + content written.
 *   - Stale mtime (file changed on disk since the GET) → 412 +
 *     `currentMtime` in the body so the client can refresh.
 *   - Missing `baseMtime` → 200 (back-compat for older callers
 *     and for brand-new files that have no previous revision).
 */

interface Env {
  baseUrl: string;
  projectPath: string;
}

async function withEnv<T>(fn: (env: Env) => Promise<T>): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "source-mtime-test-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;

  const projectId = "proj-1";
  const projectPath = path.join(homeDir, "source");
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, "notes.txt"), "first version\n");

  await fs.writeFile(
    path.join(homeDir, "projects.json"),
    JSON.stringify([
      {
        id: projectId,
        name: "demo",
        path: projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ])
  );

  const { worktreesRouter } = await import("../../routes/worktrees.js");
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use("/api/projects", worktreesRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/api/projects/${projectId}/source`;

  try {
    return await fn({ baseUrl, projectPath });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

test("GET /source returns the file mtime", async () => {
  await withEnv(async ({ baseUrl, projectPath }) => {
    const res = await fetch(`${baseUrl}?path=notes.txt`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { mtime?: string };
    assert.ok(body.mtime, "GET /source should return an mtime");
    const expected = (
      await fs.stat(path.join(projectPath, "notes.txt"))
    ).mtime.toISOString();
    assert.equal(body.mtime, expected);
  });
});

test("PUT /source with a matching baseMtime saves the file", async () => {
  await withEnv(async ({ baseUrl, projectPath }) => {
    const getRes = await fetch(`${baseUrl}?path=notes.txt`);
    const file = (await getRes.json()) as { mtime: string };
    const res = await fetch(`${baseUrl}?path=notes.txt`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "updated\n", baseMtime: file.mtime }),
    });
    assert.equal(res.status, 200);
    const onDisk = await fs.readFile(path.join(projectPath, "notes.txt"), "utf-8");
    assert.equal(onDisk, "updated\n");
  });
});

test("PUT /source with a stale baseMtime rejects with 412", async () => {
  await withEnv(async ({ baseUrl, projectPath }) => {
    const getRes = await fetch(`${baseUrl}?path=notes.txt`);
    const file = (await getRes.json()) as { mtime: string };

    // Simulate a concurrent external write — bump the mtime by
    // a full second so the comparison can never be equal at
    // millisecond resolution.
    const filePath = path.join(projectPath, "notes.txt");
    const future = new Date(Date.now() + 5_000);
    await fs.utimes(filePath, future, future);

    const res = await fetch(`${baseUrl}?path=notes.txt`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "would clobber\n", baseMtime: file.mtime }),
    });
    assert.equal(res.status, 412);
    const body = (await res.json()) as { error?: string; currentMtime?: string };
    assert.ok(body.error, "412 body should include an error message");
    assert.ok(body.currentMtime, "412 body should include currentMtime");

    // The on-disk file should be untouched.
    const onDisk = await fs.readFile(filePath, "utf-8");
    assert.equal(onDisk, "first version\n");
  });
});

test("PUT /source without a baseMtime still saves (back-compat)", async () => {
  await withEnv(async ({ baseUrl, projectPath }) => {
    // Bump the mtime first so we know the only way this test
    // passes is because the server skipped the check entirely.
    const filePath = path.join(projectPath, "notes.txt");
    const future = new Date(Date.now() + 5_000);
    await fs.utimes(filePath, future, future);

    const res = await fetch(`${baseUrl}?path=notes.txt`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "updated\n" }),
    });
    assert.equal(res.status, 200);
    const onDisk = await fs.readFile(filePath, "utf-8");
    assert.equal(onDisk, "updated\n");
  });
});

test("PUT /source accepts a non-ISO baseMtime by ignoring the check", async () => {
  await withEnv(async ({ baseUrl, projectPath }) => {
    // A non-parseable baseMtime shouldn't crash the route — the
    // server should treat it the same as omitted and save anyway.
    const res = await fetch(`${baseUrl}?path=notes.txt`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "updated\n", baseMtime: "not-a-date" }),
    });
    assert.equal(res.status, 200);
    const onDisk = await fs.readFile(path.join(projectPath, "notes.txt"), "utf-8");
    assert.equal(onDisk, "updated\n");
  });
});
