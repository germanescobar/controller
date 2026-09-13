import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Request-level tests for the memory REST surface. Mounts the real
 * `memoryRouter` against a temp `CONTROLLER_HOME`, then drives the
 * full CRUD lifecycle over HTTP. Covers the route-ordering fix
 * (issue #350 PR review, P1) and the DELETE projectId validation
 * (P2).
 */

async function withRoutes<T>(
  fn: (env: {
    baseUrl: string;
    projectId: string;
    onDisk: { globalNotes: string; projectNotes: string; globalPinned: string; projectPinned: string };
  }) => Promise<T>
): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-routes-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;

  const projectId = "proj-1";
  const projectPath = path.join(homeDir, "source");
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(
    path.join(homeDir, "projects.json"),
    JSON.stringify([
      { id: projectId, name: "demo", path: projectPath, createdAt: new Date().toISOString() },
    ])
  );

  const { memoryRouter } = await import("../../routes/memory.js");
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api", memoryRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/api/memory`;
  const onDisk = {
    globalNotes: path.join(homeDir, "memory", "global", "notes"),
    projectNotes: path.join(homeDir, "memory", "projects", projectId, "notes"),
    globalPinned: path.join(homeDir, "memory", "global", "pinned.md"),
    projectPinned: path.join(homeDir, "memory", "projects", projectId, "pinned.md"),
  };

  try {
    return await fn({ baseUrl, projectId, onDisk });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

async function getJson<T>(res: Response): Promise<T> {
  return (await (res as unknown as { json: () => Promise<T> }).json()) as T;
}

test("pinned routes match before :slug (route-ordering fix, PR review P1)", async () => {
  await withRoutes(async ({ baseUrl, onDisk }) => {
    // First write the global pinned snippet via the explicit route.
    const putPinned = await fetch(`${baseUrl}/global/pinned`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "global pinned body" }),
    });
    assert.equal(putPinned.status, 200);

    // The fact that GET /global/pinned returns the pinned body (not
    // 404 because the request was misrouted to a `:slug` handler
    // looking for a note literally named `pinned`) is the regression
    // assertion. The previous code returned 404 here.
    const getPinned = await fetch(`${baseUrl}/global/pinned`);
    assert.equal(getPinned.status, 200);
    const pinnedBody = (await getJson<{ content: string }>(getPinned)) as { content: string };
    assert.equal(pinnedBody.content, "global pinned body");

    // The file on disk is the pinned one, not a note.
    const onDiskPinned = await fs.readFile(onDisk.globalPinned, "utf-8");
    assert.equal(onDiskPinned, "global pinned body");
  });
});

test("search route matches before :slug (route-ordering fix, PR review P1)", async () => {
  await withRoutes(async ({ baseUrl }) => {
    const search = await fetch(`${baseUrl}/global/search?query=anything`);
    // The previous code returned 404 because the request hit
    // /memory/:scope/:slug with `slug=search`. With the fix it
    // reaches the search handler and returns 200 with empty results.
    assert.equal(search.status, 200);
    const body = (await getJson<{ results: unknown[] }>(search)) as { results: unknown[] };
    assert.deepEqual(body.results, []);
  });
});

test("DELETE validates the projectId against the project registry (PR review P2)", async () => {
  await withRoutes(async ({ baseUrl, onDisk }) => {
    // Seed a global note that a malicious DELETE must not be able to
    // reach via a path-traversal-shaped projectId.
    await fs.mkdir(onDisk.globalNotes, { recursive: true });
    await fs.writeFile(path.join(onDisk.globalNotes, "doomed.md"), "global note");

    // A project-scoped DELETE with a non-existent projectId must
    // 404, *not* fall through and delete the global file.
    const res = await fetch(
      `${baseUrl}/project/doomed?projectId=../global`,
      { method: "DELETE" }
    );
    assert.equal(res.status, 404);
    // The global note is still there.
    assert.equal(
      (await fs.readFile(path.join(onDisk.globalNotes, "doomed.md"), "utf-8")) === "global note",
      true
    );
  });
});

test("DELETE with a real projectId still works", async () => {
  await withRoutes(async ({ baseUrl }) => {
    // Create a project-scoped note. The PUT route reads projectId from
    // the body (matching the CLI's wire contract) — see write/pin in
    // runMemory.
    const create = await fetch(`${baseUrl}/project/deleteme`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x", projectId: "proj-1" }),
    });
    assert.equal(create.status, 200);

    // Delete it via the same route. The DELETE route reads projectId
    // from the query (matching the CLI's wire contract).
    const del = await fetch(`${baseUrl}/project/deleteme?projectId=proj-1`, {
      method: "DELETE",
    });
    assert.equal(del.status, 204);

    // Confirm it's gone.
    const get = await fetch(`${baseUrl}/project/deleteme?projectId=proj-1`);
    assert.equal(get.status, 404);
  });
});
