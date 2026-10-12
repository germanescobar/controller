import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Tests for `PUT /api/projects/:projectId/source` (issue #313
 * follow-up). The route is the write counterpart to the existing
 * `GET /source` handler and must:
 *
 *   - Save the supplied content to the file on disk.
 *   - Reject paths that fall outside the project + worktree roots
 *     (the same trust model as the read endpoint).
 *   - Reject bodies that aren't strings.
 *   - Cap the body at 1 MiB to mirror the read endpoint's size
 *     limit and stop a runaway client from overwriting a giant
 *     file in one shot.
 *   - Refuse to overwrite a directory.
 *
 * Each test mounts the worktrees router on a temp
 * `CONTROLLER_HOME` so the project registry is hermetic, and
 * writes to a real on-disk file so the `fs.writeFile` /
 * `fs.realpath` calls exercise their production code paths.
 */

interface Env {
  baseUrl: string;
  projectPath: string;
}

async function withEnv<T>(fn: (env: Env) => Promise<T>): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "source-write-test-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;

  const projectId = "proj-1";
  const projectPath = path.join(homeDir, "source");
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, "README.md"), "v1\n");
  await fs.writeFile(
    path.join(projectPath, "notes.txt"),
    "first version\n"
  );

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
  // Match the global `express.json({ limit: "50mb" })` mounted in
  // `server/index.ts` so a 1 MiB+ body in the oversize test
  // reaches the route handler instead of being rejected by
  // body-parser's default 100 KB cap.
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

test("PUT /source saves the new content to an existing file", async () => {
  await withEnv(async ({ baseUrl, projectPath }) => {
    const res = await fetch(`${baseUrl}?path=notes.txt`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "second version\n" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      path: string;
      relativePath: string;
      content: string;
      savedAt: string;
    };
    assert.equal(body.content, "second version\n");
    assert.equal(body.relativePath, "notes.txt");
    assert.ok(body.savedAt, "savedAt should be returned");

    const onDisk = await fs.readFile(path.join(projectPath, "notes.txt"), "utf-8");
    assert.equal(onDisk, "second version\n");
  });
});

test("PUT /source rejects a missing content field with 400", async () => {
  await withEnv(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}?path=notes.txt`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test("PUT /source rejects a non-string content with 400", async () => {
  await withEnv(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}?path=notes.txt`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: 42 }),
    });
    assert.equal(res.status, 400);
  });
});

test("PUT /source refuses a path outside the project with 403", async () => {
  await withEnv(async ({ baseUrl, projectPath }) => {
    // `/etc/passwd` is a real file, so the path-safety check has
    // to look at the resolved location, not just whether the
    // file exists.
    const outside = path.join(path.dirname(projectPath), "outside.txt");
    await fs.writeFile(outside, "leave me alone\n");
    try {
      const res = await fetch(
        `${baseUrl}?path=${encodeURIComponent(outside)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "pwned\n" }),
        }
      );
      assert.equal(res.status, 403);
      // Confirm the file on disk was untouched.
      const onDisk = await fs.readFile(outside, "utf-8");
      assert.equal(onDisk, "leave me alone\n");
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});

test("PUT /source refuses a traversal attempt with 403", async () => {
  await withEnv(async ({ baseUrl }) => {
    const res = await fetch(
      `${baseUrl}?path=${encodeURIComponent("../escape.txt")}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "pwned\n" }),
      }
    );
    assert.equal(res.status, 403);
  });
});

test("PUT /source rejects a directory target with 400", async () => {
  await withEnv(async ({ baseUrl, projectPath }) => {
    // Create a real directory inside the project and try to PUT
    // to it. The route must refuse without clobbering the dir.
    const subdir = path.join(projectPath, "subdir");
    await fs.mkdir(subdir, { recursive: true });
    try {
      const res = await fetch(`${baseUrl}?path=subdir`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "pwned\n" }),
      });
      assert.equal(res.status, 400);
      const stat = await fs.stat(subdir);
      assert.ok(stat.isDirectory(), "directory should be untouched");
    } finally {
      await fs.rm(subdir, { recursive: true, force: true });
    }
  });
});

test("PUT /source rejects an oversize body with 413", async () => {
  await withEnv(async ({ baseUrl }) => {
    // 1 MiB + 1 byte of content. The handler's cap is 1 MiB
    // exactly, so anything over must be refused before the file
    // is touched.
    const oversize = "x".repeat(1024 * 1024 + 1);
    const res = await fetch(`${baseUrl}?path=notes.txt`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: oversize }),
    });
    assert.equal(res.status, 413);
  });
});

test("PUT /source requires a `path` query parameter with 400", async () => {
  await withEnv(async ({ baseUrl }) => {
    const res = await fetch(baseUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    assert.equal(res.status, 400);
  });
});
