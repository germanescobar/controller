import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEvent, type AgentEvent } from "../sessions.js";
import { projectStoreDir } from "../paths.js";

/*
 * Integration test for the paginated
 * `GET /:projectId/sessions/:sessionId/events` endpoint introduced in
 * issue #404. Mounts the real `sessionsRouter` against a temp
 * `CONTROLLER_HOME`, seeds a project + worktree, and exercises:
 *
 *   - default (no params): full deduped transcript, byte-equivalent to
 *     the pre-pagination endpoint
 *   - `?limit=N`: tail-paginated read with the dedupe-overlap window
 *   - `?limit=N&before=<id>`: page that ends just before the anchor
 *   - validation errors (limit must be a positive integer; before
 *     must be a non-empty id)
 *
 * The helper-level coverage (`events-tail.test.ts`,
 * `user-message-dedupe.test.ts`, `anita-transcript-persistence.test.ts`)
 * exercises the parsing/dedupe logic in isolation; this file ensures
 * the route handler wires the params through to the helper correctly.
 */

async function withEventsEndpointEnv<T>(
  fn: (ctx: {
    homeDir: string;
    projectId: string;
    projectPath: string;
    baseUrl: string;
    serverBaseUrl: string;
  }) => Promise<T>
): Promise<T> {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "events-endpoint-"));
  const projectPath = mkdtempSync(path.join(os.tmpdir(), "events-endpoint-proj-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;

  const projectId = "proj-events";
  writeFileSync(
    path.join(homeDir, "projects.json"),
    JSON.stringify([
      {
        id: projectId,
        name: "demo",
        path: projectPath,
        createdAt: new Date().toISOString(),
      },
    ])
  );

  const { sessionsRouter } = await import("../../routes/sessions.js");
  const app = express();
  app.use(express.json());
  app.use("/api/projects", sessionsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve)
  );
  const port = (server.address() as { port: number }).port;
  const serverBaseUrl = `http://127.0.0.1:${port}/api/projects`;
  const baseUrl = `${serverBaseUrl}/${projectId}`;

  try {
    return await fn({ homeDir, projectId, projectPath, baseUrl, serverBaseUrl });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
  }
}

async function seedEvents(
  projectPath: string,
  sessionId: string,
  count: number
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const event: AgentEvent = {
      id: `evt-${i}`,
      sessionId,
      timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      type: "user_message",
      data: { text: `turn ${i}` },
    };
    await appendEvent(projectPath, sessionId, event);
  }
}

test("GET /sessions/:id/events with no params returns the full deduped transcript", async () => {
  await withEventsEndpointEnv(async ({ projectPath, baseUrl }) => {
    await seedEvents(projectPath, "s-default", 8);
    const res = await fetch(`${baseUrl}/sessions/s-default/events`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ id: string }>;
    assert.equal(body.length, 8);
    assert.deepEqual(
      body.map((e) => e.id),
      ["evt-0", "evt-1", "evt-2", "evt-3", "evt-4", "evt-5", "evt-6", "evt-7"]
    );
  });
});

test("GET /sessions/:id/events?limit=N returns the last N events raw (dedupe happens client-side)", async () => {
  await withEventsEndpointEnv(async ({ projectPath, baseUrl }) => {
    await seedEvents(projectPath, "s-limit", 20);
    const res = await fetch(`${baseUrl}/sessions/s-limit/events?limit=5`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ id: string }>;
    // The route asks the helper for `limit + TAIL_DEDUPE_OVERLAP = 7`
    // lines. With no anchor (`before` is unset) the helper returns
    // the last 7 lines, in chronological order.
    assert.equal(body.length, 7, `expected 7 events (5 + 2 overlap), got ${body.length}`);
    // The first event is the oldest of the window+overlap.
    assert.equal(body[0].id, "evt-13");
    // The last event in the response must be evt-19 (most recent).
    assert.equal(body[body.length - 1].id, "evt-19");
    // Every event must come from the last 7 (window + overlap).
    const ids = body.map((e) => e.id);
    for (const id of ids) {
      const n = Number(id.split("-")[1]);
      assert.ok(
        n >= 13 && n <= 19,
        `event ${id} is outside the expected window+overlap`
      );
    }
  });
});

test("GET /sessions/:id/events?limit=N&before=<id> returns the page that ends just before the anchor", async () => {
  await withEventsEndpointEnv(async ({ projectPath, baseUrl }) => {
    await seedEvents(projectPath, "s-before", 10);
    // Ask for 5 events ending just before evt-7. The route asks the
    // helper for `limit + 2 = 7` lines ending at (excluding) evt-7.
    // The helper reads 7 lines (its `minLines` is `7 + 1 + 1 = 9`,
    // but the file has only 7 lines before evt-7), iterates them in
    // chronological order, and breaks on evt-7. Result is the 6
    // events before the anchor in chronological order.
    const res = await fetch(
      `${baseUrl}/sessions/s-before/events?limit=5&before=evt-7`
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ id: string }>;
    assert.equal(body.length, 6, `expected 6 events, got ${body.length}`);
    const ids = body.map((e) => e.id);
    // First event in the response is evt-1 (oldest of the 6 lines
    // we read: evt-1..evt-6).
    assert.equal(ids[0], "evt-1");
    // Last event is evt-6 (one before the anchor).
    assert.equal(ids[ids.length - 1], "evt-6");
    assert.ok(!ids.includes("evt-7"), "the anchor must not be in the response");
  });
});

test("GET /sessions/:id/events?limit=0 returns 400 with a positive-integer error", async () => {
  await withEventsEndpointEnv(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/sessions/any/events?limit=0`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /positive integer/);
  });
});

test("GET /sessions/:id/events?limit=-3 returns 400 with a positive-integer error", async () => {
  await withEventsEndpointEnv(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/sessions/any/events?limit=-3`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /positive integer/);
  });
});

test("GET /sessions/:id/events?limit=abc returns 400 with a positive-integer error", async () => {
  await withEventsEndpointEnv(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/sessions/any/events?limit=abc`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /positive integer/);
  });
});

test("GET /sessions/:id/events?before= without a limit returns 400", async () => {
  await withEventsEndpointEnv(async ({ baseUrl }) => {
    const res = await fetch(
      `${baseUrl}/sessions/any/events?before=evt-0`
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /before requires a positive limit/);
  });
});

test("GET /sessions/:id/events?before= (empty) returns 400", async () => {
  await withEventsEndpointEnv(async ({ baseUrl }) => {
    const res = await fetch(
      `${baseUrl}/sessions/any/events?limit=5&before=`
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /non-empty event id/);
  });
});

test("GET /sessions/:id/events on a missing session returns the empty array", async () => {
  await withEventsEndpointEnv(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/sessions/no-such/events`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as unknown;
    assert.deepEqual(body, []);
  });
});

test("GET /sessions/:id/events on a missing project returns 404", async () => {
  // Use a project id that was never seeded into the test's
  // `projects.json`. The route must surface the missing-project case
  // before touching the session store so callers can distinguish
  // "wrong project" from "session with no events yet".
  await withEventsEndpointEnv(async ({ serverBaseUrl }) => {
    const url = `${serverBaseUrl}/no-such-project/sessions/no/events`;
    const res = await fetch(url);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /not found/i);
  });
});