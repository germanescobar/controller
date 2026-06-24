import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #210: project-scoped event stream. We mount the new
 * `eventsRouter` against a temp `CONTROLLER_HOME`, pre-seed a
 * project, subscribe two clients (one for the seeded project, one for a
 * non-existent project — expect 404), and exercise the in-process bus by
 * emitting lifecycle events from the test. The stream should filter
 * events to the matching project and ignore everything else.
 */

async function readSse(res: Response): Promise<unknown[]> {
  if (!res.body) return [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const out: unknown[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = block
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (dataLine) {
          try {
            out.push(JSON.parse(dataLine.slice(6)));
          } catch {
            // ignore parse errors
          }
        }
        idx = buffer.indexOf("\n\n");
      }
    }
  } catch (err) {
    // Connection aborted (test teardown) or closed by the server — the
    // events we accumulated so far are still useful for assertions.
    if (
      err &&
      typeof err === "object" &&
      "name" in err &&
      ((err as { name?: string }).name === "AbortError" ||
        (err as { name?: string }).name === "ERR_STREAM_PREMATURE_CLOSE")
    ) {
      // fall through and return what we have
    } else {
      throw err;
    }
  }
  return out;
}

async function withEventsEnv<T>(
  fn: (ctx: { baseUrl: string; projectId: string }) => Promise<T>
): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "events-test-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;

  const projectId = "proj-1";
  await fs.writeFile(
    path.join(homeDir, "projects.json"),
    JSON.stringify([
      {
        id: projectId,
        name: "demo",
        path: path.join(homeDir, "source"),
        createdAt: new Date().toISOString(),
      },
    ])
  );

  const { eventsRouter } = await import("../../routes/events.js");
  const app = express();
  app.use(express.json());
  app.use("/api/projects", eventsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/api/projects`;

  try {
    return await fn({ baseUrl, projectId });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

test("GET /events returns 404 for an unknown project", async () => {
  await withEventsEnv(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/missing/events`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /not found/i);
  });
});

test("GET /events delivers worktree and session lifecycle events for the active project", async () => {
  await withEventsEnv(async ({ baseUrl, projectId }) => {
    const events = await import("../../lib/events.js");
    // Subscriber for the active project — closes via the response body
    // ending naturally once we cancel the request.
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/${projectId}/events`, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });
    assert.equal(res.status, 200);
    assert.match(
      res.headers.get("content-type") ?? "",
      /text\/event-stream/
    );

    // Drain SSE events in the background; the route never ends on its
    // own, so we tolerate abort errors from the reader once the test
    // tears the connection down.
    const delivered: Array<Record<string, unknown>> = [];
    const readerPromise = readSse(res)
      .then((events) => {
        for (const event of events) delivered.push(event as Record<string, unknown>);
      })
      .catch((err: unknown) => {
        if (err && typeof err === "object" && "name" in err && (err as { name?: string }).name === "AbortError") {
          return;
        }
        throw err;
      });

    // Emit events from two different projects so we can verify the
    // route only forwards the matching project's events.
    const otherProjectId = "proj-other";
    events.emitWorktreeAdded(otherProjectId, {
      id: "wt-other",
      projectId: otherProjectId,
      name: "noise",
      path: "/tmp/noise",
      isMain: false,
      createdAt: new Date().toISOString(),
    });

    const worktree = {
      id: "wt-1",
      projectId,
      name: "issue-1",
      path: "/tmp/issue-1",
      isMain: false,
      createdAt: new Date().toISOString(),
    };
    events.emitWorktreeAdded(projectId, worktree);
    events.emitSessionAdded(projectId, worktree.id, "sess-1");
    events.emitSessionUpdated(projectId, worktree.id, "sess-1");
    events.emitSessionRemoved(projectId, worktree.id, "sess-1");
    events.emitWorktreeRemoved(projectId, worktree.id);

    // Give the SSE writer a tick to flush before we tear the
    // connection down — the route runs in-process, but Node's HTTP
    // server may coalesce small writes, so we let the event loop
    // turn a few times before aborting.
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();

    await readerPromise;

    const types = delivered.map((event) => event.type as string);
    assert.deepEqual(types, [
      "worktree_added",
      "session_added",
      "session_updated",
      "session_removed",
      "worktree_removed",
    ]);

    const added = delivered[0] as { worktree: { id: string } };
    assert.equal(added.worktree.id, "wt-1");

    // Per-project events (worktree/session) from another project must
    // not be delivered — only project-lifecycle events are broadcast.
    assert.ok(
      !delivered.some(
        (event) =>
          "projectId" in event && (event as { projectId: string }).projectId === otherProjectId
      ),
      "per-project events from other projects should not be delivered"
    );
  });
});

test("subscribeProjectEvents throws-safe: a broken subscriber does not kill the bus", async () => {
  await withEventsEnv(async ({ projectId }) => {
    const events = await import("../../lib/events.js");

    const seen: string[] = [];
    const unsubscribeBad = events.subscribeProjectEvents(() => {
      throw new Error("boom");
    });
    const unsubscribeGood = events.subscribeProjectEvents((event) => {
      if ("projectId" in event) seen.push(event.projectId);
      else if (event.type === "project_added" || event.type === "project_updated") {
        seen.push(event.project.id);
      }
    });

    try {
      events.emitWorktreeAdded(projectId, {
        id: "wt-2",
        projectId,
        name: "issue-2",
        path: "/tmp/issue-2",
        isMain: false,
        createdAt: new Date().toISOString(),
      });
      assert.deepEqual(seen, [projectId]);
    } finally {
      unsubscribeBad();
      unsubscribeGood();
    }
  });
});

test("GET /events broadcasts project-lifecycle events from other projects", async () => {
  // Review feedback (issue #210): a client subscribed to project A
  // must still learn about project_added/updated/removed on project B,
  // otherwise the sidebar's project list goes stale when another
  // window/CLI creates or renames a different project.
  await withEventsEnv(async ({ baseUrl, projectId }) => {
    const events = await import("../../lib/events.js");

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/${projectId}/events`, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });
    assert.equal(res.status, 200);

    const delivered: Array<Record<string, unknown>> = [];
    const readerPromise = readSse(res)
      .then((streamed) => {
        for (const event of streamed) delivered.push(event as Record<string, unknown>);
      })
      .catch((err: unknown) => {
        if (err && typeof err === "object" && "name" in err && (err as { name?: string }).name === "AbortError") {
          return;
        }
        throw err;
      });

    const otherProjectId = "proj-other";
    events.emitProjectEvent({
      type: "project_added",
      project: {
        id: otherProjectId,
        name: "other",
        path: "/tmp/other",
        createdAt: new Date().toISOString(),
      },
    });
    events.emitProjectEvent({ type: "project_removed", projectId: otherProjectId });

    // A per-project event from another project must still be filtered
    // — only project-lifecycle events are broadcast.
    events.emitWorktreeAdded(otherProjectId, {
      id: "wt-noise",
      projectId: otherProjectId,
      name: "noise",
      path: "/tmp/noise",
      isMain: false,
      createdAt: new Date().toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await readerPromise;

    const types = delivered.map((event) => event.type as string);
    assert.deepEqual(types, ["project_added", "project_removed"]);
  });
});