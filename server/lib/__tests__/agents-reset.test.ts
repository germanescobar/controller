import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #259: per-agent "Reset session permissions" endpoint.
 *
 * Verifies that POST /api/agents/:agentId/session-permissions/reset:
 *   - Returns 400 when projectId / worktreeId are missing.
 *   - Returns 404 when the worktree does not exist.
 *   - For Claude, marks the worktree so the next session start skips
 *     `--resume` (the only way to revoke session permissions given the
 *     Claude control protocol's lack of a "remove rules" message).
 *   - For Codex, returns droppedRuntimes = 0 when nothing is live
 *     (we don't spin up a real codex app-server child in this test;
 *     the heavy spawn path is exercised by the manual checklist).
 *   - For Anita, returns 200 with zeroes (no permission prompts).
 */

async function withAgentsEnv<T>(
  fn: (ctx: { baseUrl: string; projectId: string }) => Promise<T>
): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-test-"));
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

  const { agentsRouter } = await import("../../routes/agents.js");
  const app = express();
  app.use(express.json());
  app.use("/api/agents", agentsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/api/agents`;

  try {
    return await fn({ baseUrl, projectId });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("reset returns 400 when projectId / worktreeId are missing", async () => {
  await withAgentsEnv(async ({ baseUrl }) => {
    const res = await postJson(`${baseUrl}/claude/session-permissions/reset`, {});
    assert.equal(res.status, 400);
  });
});

test("reset returns 404 for an unknown worktree", async () => {
  await withAgentsEnv(async ({ baseUrl, projectId }) => {
    const res = await postJson(
      `${baseUrl}/claude/session-permissions/reset`,
      { projectId, worktreeId: "nope" }
    );
    assert.equal(res.status, 404);
  });
});

test("reset returns 404 for an unknown agent", async () => {
  await withAgentsEnv(async ({ baseUrl, projectId }) => {
    const res = await postJson(
      `${baseUrl}/not-an-agent/session-permissions/reset`,
      { projectId, worktreeId: "main" }
    );
    assert.equal(res.status, 404);
  });
});

test("Claude reset marks the worktree for next-turn revocation", async () => {
  await withAgentsEnv(async ({ baseUrl, projectId }) => {
    // The main worktree's id is a UUID, not the literal "main" — fetch
    // it from the registry so we can assert against the actual key.
    const { resolveWorktree } = await import(
      "../../lib/worktrees.js"
    );
    const worktree = await resolveWorktree(projectId, "main");
    if (!worktree) throw new Error("main worktree not found");

    const res = await postJson(
      `${baseUrl}/claude/session-permissions/reset`,
      { projectId, worktreeId: "main" }
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      droppedRuntimes: number;
      killedRuntimes: number;
    };
    assert.equal(body.ok, true);
    // No live Claude runtimes in this test, so neither counter moves.
    assert.equal(body.droppedRuntimes, 0);
    assert.equal(body.killedRuntimes, 0);

    // The per-worktree revocation flag must now be set on the
    // resolved worktree id so the next session-start skips --resume.
    const { hasClaudeSessionRevocation } = await import(
      "../../lib/session-permissions.js"
    );
    assert.equal(hasClaudeSessionRevocation(worktree.id), true);
  });
});

test("Codex reset returns 200 with zeroes when nothing is live", async () => {
  await withAgentsEnv(async ({ baseUrl, projectId }) => {
    const res = await postJson(
      `${baseUrl}/codex/session-permissions/reset`,
      { projectId, worktreeId: "main" }
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      droppedRuntimes: number;
      killedRuntimes: number;
    };
    assert.equal(body.ok, true);
    assert.equal(body.droppedRuntimes, 0);
    assert.equal(body.killedRuntimes, 0);
  });
});

test("Anita reset returns 200 (no permission prompts to revoke)", async () => {
  await withAgentsEnv(async ({ baseUrl, projectId }) => {
    const res = await postJson(
      `${baseUrl}/anita/session-permissions/reset`,
      { projectId, worktreeId: "main" }
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      droppedRuntimes: number;
      killedRuntimes: number;
    };
    assert.equal(body.ok, true);
    assert.equal(body.droppedRuntimes, 0);
    assert.equal(body.killedRuntimes, 0);
  });
});
