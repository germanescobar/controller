import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #387: `GET /api/projects/:projectId/git/pr` returns the open
 * pull request for a worktree's current branch. The route shells out
 * to `gh pr view --json …`; this file stub-stubs that runner through
 * `__setPrGhRunnerForTests` (production code never touches the stub)
 * and asserts on the route response + cache behavior.
 *
 * Coverage:
 *   1. Happy path — three parallel `gh pr view` calls produce one
 *      merged `pr` payload (title / state / mergeable / description
 *      / comments / reviews / status checks).
 *   2. `no_pr_for_branch` — `gh pr view` exits 8; the route returns
 *      `{ pr: null }` without an `error` field (the "nothing to show"
 *      case, not a failure).
 *   3. `gh_not_authenticated` — `gh pr view` exits 4 with a stderr
 *      hint; route returns `{ pr: null, error: "gh_not_authenticated" }`.
 *   4. `gh_not_installed` — spawn errors with `ENOENT`; route returns
 *      `{ pr: null, error: "gh_not_installed" }`.
 *   5. Cache invalidates when the worktree's HEAD changes.
 *   6. Same head within 30s → cache hit (no second runner call).
 */

type GhCall = {
  args: string[];
  cwd: string;
};

type RunnerResult = { stdout: string; stderr: string; code?: number };

async function withPrEnv<T>(
  setup: (ctx: { projectPath: string }) => Promise<void>,
  fn: (env: {
    projectId: string;
    worktreeId: string;
    baseUrl: string;
    projectPath: string;
    binDir: string;
  }) => Promise<T>
): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-route-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-bin-"));
  const previous = process.env.CONTROLLER_HOME;
  const previousPath = process.env.PATH;
  process.env.CONTROLLER_HOME = homeDir;
  // Prepend a fake-bin so any spawned `git` still resolves (used by
  // resolveBranch / resolveHeadSha inside pr-data.ts).
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  await fs.mkdir(binDir, { recursive: true });

  const projectId = "proj-387";
  const projectPath = path.join(homeDir, "source");
  await fs.mkdir(projectPath, { recursive: true });

  await runGit(projectPath, ["init", "--initial-branch=main"]);
  await runGit(projectPath, ["config", "user.email", "test@example.com"]);
  await runGit(projectPath, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(projectPath, "README.md"), "v1\n");
  await runGit(projectPath, ["add", "README.md"]);
  await runGit(projectPath, ["commit", "-m", "v1"]);
  await runGit(projectPath, ["checkout", "-b", "issue-387"]);
  await fs.writeFile(path.join(projectPath, "README.md"), "v2\n");
  await runGit(projectPath, ["commit", "-am", "v2"]);

  await fs.writeFile(
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

  // Build the main worktree so `resolveWorktree` can find a worktree
  // by id (the test passes `worktreeId` not the default).
  const { getProjectWorktrees } = await import("../../lib/worktrees.js");
  const mainWorktree = (await getProjectWorktrees(projectId)).find(
    (w) => w.isMain
  );
  if (!mainWorktree) throw new Error("main worktree not found");

  await setup({ projectPath });

  const { clearCommandResolverCache } = await import(
    "../../lib/command-resolver.js"
  );
  clearCommandResolverCache();

  const { sessionsRouter } = await import("../../routes/sessions.js");
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use("/api/projects", sessionsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/api/projects/${projectId}`;

  try {
    return await fn({
      projectId,
      worktreeId: mainWorktree.id,
      baseUrl,
      projectPath,
      binDir,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(binDir, { recursive: true, force: true });
  }
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr}`)
        );
    });
    child.on("error", reject);
  });
}

/**
 * Build a stub `gh` runner that returns different responses per
 * `--json <fields>` set. The three call sets the route makes are:
 *  - META: number,title,state,url,author,body,createdAt,headRefName,
 *          baseRefName,additions,deletions,changedFiles,mergeable,isDraft
 *  - STATE: reviewDecision,statusCheckRollup
 *  - THREADS: comments,reviews
 */
function buildRunner(
  responses: Record<"META" | "STATE" | "THREADS", RunnerResult>
): { calls: GhCall[]; runner: import("../pr-data.js").GhRunner } {
  const calls: GhCall[] = [];
  const routes: Array<{
    key: "META" | "STATE" | "THREADS";
    fields: string[];
  }> = [
    {
      key: "META",
      fields: [
        "number",
        "title",
        "state",
        "url",
        "author",
        "body",
        "createdAt",
        "headRefName",
        "baseRefName",
        "additions",
        "deletions",
        "changedFiles",
        "mergeable",
        "isDraft",
      ],
    },
    { key: "STATE", fields: ["reviewDecision", "statusCheckRollup"] },
    { key: "THREADS", fields: ["comments", "reviews"] },
  ];
  const runner: import("../pr-data.js").GhRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    const idx = args.indexOf("--json");
    const requested = idx >= 0 ? args[idx + 1].split(",") : [];
    const sortedReq = new Set(requested);
    const match = routes.find((r) => {
      if (r.fields.length !== sortedReq.size) return false;
      for (const f of r.fields) if (!sortedReq.has(f)) return false;
      return true;
    });
    if (!match) {
      throw new Error(
        `stub runner received unexpected --json set: ${requested.join(",")}`
      );
    }
    const r = responses[match.key];
    if (r.code && r.code !== 0) {
      const err = new Error("gh exited non-zero") as NodeJS.ErrnoException &
        NodeJS.ErrnoException & {
          code?: string | number;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
        };
      err.code = r.code;
      err.stdout = r.stdout;
      err.stderr = r.stderr;
      err.killed = false;
      throw err;
    }
    return { stdout: r.stdout, stderr: r.stderr };
  };
  return { calls, runner };
}

async function fetchPr(
  baseUrl: string,
  worktreeId: string
): Promise<Response> {
  return fetch(`${baseUrl}/git/pr?worktreeId=${encodeURIComponent(worktreeId)}`);
}

const SAMPLE_META: RunnerResult = {
  stdout: JSON.stringify({
    number: 388,
    title: "Per-session inactivity-timeout override",
    state: "OPEN",
    url: "https://github.com/germanescobar/controller/pull/388",
    author: { login: "germanescobar", name: "German Escobar" },
    body: "## Summary\n\nCloses #386.",
    createdAt: "2026-09-22T21:09:40Z",
    headRefName: "issue-386",
    baseRefName: "main",
    additions: 875,
    deletions: 9,
    changedFiles: 6,
    mergeable: "MERGEABLE",
    isDraft: false,
  }),
  stderr: "",
};

const SAMPLE_STATE: RunnerResult = {
  stdout: JSON.stringify({
    reviewDecision: "APPROVED",
    statusCheckRollup: [
      {
        name: "ci / build",
        state: "SUCCESS",
        targetUrl:
          "https://github.com/germanescobar/controller/runs/12345",
        description: "Build succeeded",
        workflow: "CI",
      },
      {
        name: "ci / lint",
        state: "FAILURE",
        targetUrl:
          "https://github.com/germanescobar/controller/runs/12346",
        description: "Lint failed",
      },
    ],
  }),
  stderr: "",
};

const SAMPLE_THREADS: RunnerResult = {
  stdout: JSON.stringify({
    comments: [
      {
        id: "C1",
        body: "@codex review",
        createdAt: "2026-09-22T21:09:51Z",
        url: "https://github.com/germanescobar/controller/pull/388#issuecomment-5784211945",
        author: { login: "germanescobar", name: "German Escobar" },
      },
    ],
    reviews: [
      {
        id: "R1",
        state: "APPROVED",
        body: "Looks great.",
        submittedAt: "2026-09-22T22:00:00Z",
        url: "https://github.com/germanescobar/controller/pull/388#pullrequestreview-1",
        author: { login: "reviewer-bot", name: "Reviewer Bot" },
      },
    ],
  }),
  stderr: "",
};

test("GET /git/pr merges the three gh pr view responses into one PullRequest (issue #387)", async () => {
  await withPrEnv(async () => {}, async (env) => {
    const stub = buildRunner({
      META: SAMPLE_META,
      STATE: SAMPLE_STATE,
      THREADS: SAMPLE_THREADS,
    });
    const { __setPrGhRunnerForTests } = await import("../pr-data.js");
    const dispose = __setPrGhRunnerForTests(stub.runner);
    try {
      const res = await fetchPr(env.baseUrl, env.worktreeId);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.error, undefined);
      assert.ok(body.pr, "pr should be present");
      assert.equal(body.pr.number, 388);
      assert.equal(body.pr.title, "Per-session inactivity-timeout override");
      assert.equal(body.pr.state, "OPEN");
      assert.equal(body.pr.mergeable, "MERGEABLE");
      assert.equal(body.pr.reviewDecision, "APPROVED");
      assert.equal(body.pr.additions, 875);
      assert.equal(body.pr.deletions, 9);
      assert.equal(body.pr.changedFiles, 6);
      assert.equal(body.pr.author.login, "germanescobar");
      assert.equal(
        body.pr.author.avatarUrl,
        "https://avatars.githubusercontent.com/germanescobar?size=80"
      );
      assert.equal(body.pr.statusCheckRollup.length, 2);
      assert.equal(body.pr.statusCheckRollup[0].name, "ci / build");
      assert.equal(body.pr.comments.length, 1);
      assert.equal(body.pr.comments[0].author.login, "germanescobar");
      assert.equal(body.pr.reviews.length, 1);
      assert.equal(body.pr.reviews[0].state, "APPROVED");
      assert.equal(stub.calls.length, 3, "expected three parallel gh calls");
      for (const c of stub.calls) {
        assert.deepEqual(c.args.slice(0, 2), ["pr", "view"]);
        assert.equal(c.args[2], "--json");
      }
    } finally {
      dispose();
    }
  });
});

test("GET /git/pr returns { pr: null } when gh pr view reports 'no pull requests found' (issue #387)", async () => {
  await withPrEnv(async () => {}, async (env) => {
    const stub = buildRunner({
      META: {
        code: 8,
        stdout: "",
        stderr: "no pull requests found for branch \"issue-387\"",
      },
      STATE: { stdout: "{}", stderr: "" },
      THREADS: { stdout: "{}", stderr: "" },
    });
    const { __setPrGhRunnerForTests } = await import("../pr-data.js");
    const dispose = __setPrGhRunnerForTests(stub.runner);
    try {
      const res = await fetchPr(env.baseUrl, env.worktreeId);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.pr, null);
      assert.equal(body.error, undefined);
    } finally {
      dispose();
    }
  });
});

test("GET /git/pr surfaces gh_not_authenticated when gh exits 4 with an auth hint (issue #387)", async () => {
  await withPrEnv(async () => {}, async (env) => {
    const stub = buildRunner({
      META: {
        code: 4,
        stdout: "",
        stderr:
          "To use GitHub CLI in a non-interactive environment, please log in with `gh auth login`",
      },
      STATE: { stdout: "{}", stderr: "" },
      THREADS: { stdout: "{}", stderr: "" },
    });
    const { __setPrGhRunnerForTests } = await import("../pr-data.js");
    const dispose = __setPrGhRunnerForTests(stub.runner);
    try {
      const res = await fetchPr(env.baseUrl, env.worktreeId);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.pr, null);
      assert.equal(body.error, "gh_not_authenticated");
    } finally {
      dispose();
    }
  });
});

test("GET /git/pr surfaces gh_not_installed when gh spawn fails with ENOENT (issue #387)", async () => {
  await withPrEnv(async () => {}, async (env) => {
    const enoentRunner: import("../pr-data.js").GhRunner = async () => {
      const err = new Error("spawn gh ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      err.stdout = "";
      err.stderr = "";
      throw err;
    };
    const { __setPrGhRunnerForTests } = await import("../pr-data.js");
    const dispose = __setPrGhRunnerForTests(enoentRunner);
    try {
      const res = await fetchPr(env.baseUrl, env.worktreeId);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.pr, null);
      assert.equal(body.error, "gh_not_installed");
    } finally {
      dispose();
    }
  });
});

test("GET /git/pr surfaces gh_not_installed when the shell exits 127 with 'gh: not found' (issue #387)", async () => {
  // Mirrors the production behavior the default runner sees: the
  // wrapper `sh -c "gh ..."` runs, fails to find `gh` on PATH, and
  // surfaces an exit code of 127 with a stderr hint that mentions
  // "not found". Previously this round-tripped as a generic
  // `non_zero_exit` failure; the route should classify it as
  // `gh_not_installed` instead so the client can log it accurately.
  await withPrEnv(async () => {}, async (env) => {
    const shellMissingRunner: import("../pr-data.js").GhRunner = async () => {
      const err = new Error("Command failed: gh pr view --json ...") as NodeJS.ErrnoException;
      err.code = 127;
      err.stdout = "";
      err.stderr = "sh: gh: not found";
      throw err;
    };
    const { __setPrGhRunnerForTests } = await import("../pr-data.js");
    const dispose = __setPrGhRunnerForTests(shellMissingRunner);
    try {
      const res = await fetchPr(env.baseUrl, env.worktreeId);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.pr, null);
      assert.equal(body.error, "gh_not_installed");
    } finally {
      dispose();
    }
  });
});

test("GET /git/pr caches by HEAD — second call with the same head does not re-invoke the runner (issue #387)", async () => {
  await withPrEnv(async () => {}, async (env) => {
    const stub = buildRunner({
      META: SAMPLE_META,
      STATE: SAMPLE_STATE,
      THREADS: SAMPLE_THREADS,
    });
    const { __setPrGhRunnerForTests } = await import("../pr-data.js");
    const dispose = __setPrGhRunnerForTests(stub.runner);
    try {
      const first = await fetchPr(env.baseUrl, env.worktreeId);
      const firstBody = await first.json();
      assert.ok(firstBody.pr);
      assert.equal(stub.calls.length, 3);

      const second = await fetchPr(env.baseUrl, env.worktreeId);
      const secondBody = await second.json();
      assert.ok(secondBody.pr);
      assert.equal(stub.calls.length, 3, "no new runner calls on cache hit");
    } finally {
      dispose();
    }
  });
});

test("GET /git/pr keeps reviews that omit the optional url field (issue #387)", async () => {
  // `gh pr view --json reviews` does not actually include a `url`
  // field on its review selection (only on comments). The earlier
  // server-side validator rejected every real review because of the
  // required URL. This test pins the relaxed shape: reviews with
  // no `url` survive normalization, and the panel still renders a
  // review entry per item.
  const threadsWithoutReviewUrls: RunnerResult = {
    stdout: JSON.stringify({
      comments: [],
      reviews: [
        {
          id: "PRR_kwDOR-kYZ88AAAABPX0dTA",
          state: "APPROVED",
          body: "Looks great to me.",
          submittedAt: "2026-09-22T22:00:00Z",
          author: { login: "reviewer-bot", name: "Reviewer Bot" },
        },
        {
          id: "PRR_kwDOR-kYZ88AAAABPX0dTB",
          state: "CHANGES_REQUESTED",
          body: "",
          submittedAt: "2026-09-22T22:30:00Z",
          author: { login: "second-reviewer", name: "Second Reviewer" },
        },
      ],
    }),
    stderr: "",
  };
  await withPrEnv(async () => {}, async (env) => {
    const stub = buildRunner({
      META: SAMPLE_META,
      STATE: SAMPLE_STATE,
      THREADS: threadsWithoutReviewUrls,
    });
    const { __setPrGhRunnerForTests } = await import("../pr-data.js");
    const dispose = __setPrGhRunnerForTests(stub.runner);
    try {
      const res = await fetchPr(env.baseUrl, env.worktreeId);
      const body = await res.json();
      assert.equal(body.error, undefined);
      assert.ok(body.pr, "PR should be returned");
      // Both reviews survive even though neither carries a `url`.
      assert.equal(body.pr.reviews.length, 2);
      assert.equal(body.pr.reviews[0].state, "APPROVED");
      assert.equal(body.pr.reviews[1].state, "CHANGES_REQUESTED");
      assert.equal(body.pr.reviews[0].url, undefined);
      assert.equal(body.pr.reviews[1].url, undefined);
      assert.equal(body.pr.reviews[0].body, "Looks great to me.");
    } finally {
      dispose();
    }
  });
});

test("GET /git/pr prefers the in-progress status over an empty conclusion (issue #387)", async () => {
  // For a CheckRun that is still running, `gh pr view` emits
  // `"conclusion":""` and `"status":"IN_PROGRESS"`. The earlier
  // validator treated the empty conclusion as truthy and used it
  // as the visible state, masking in-progress runs. Pin the new
  // behavior: the empty conclusion should fall through to status.
  const stateWithEmptyConclusion: RunnerResult = {
    stdout: JSON.stringify({
      reviewDecision: null,
      statusCheckRollup: [
        {
          name: "ci / build",
          conclusion: "",
          status: "IN_PROGRESS",
          targetUrl: "https://github.com/germanescobar/controller/runs/12345",
          description: "Building",
        },
      ],
    }),
    stderr: "",
  };
  await withPrEnv(async () => {}, async (env) => {
    const stub = buildRunner({
      META: SAMPLE_META,
      STATE: stateWithEmptyConclusion,
      THREADS: SAMPLE_THREADS,
    });
    const { __setPrGhRunnerForTests } = await import("../pr-data.js");
    const dispose = __setPrGhRunnerForTests(stub.runner);
    try {
      const res = await fetchPr(env.baseUrl, env.worktreeId);
      const body = await res.json();
      assert.ok(body.pr, "PR should be returned");
      assert.equal(body.pr.statusCheckRollup.length, 1);
      const check = body.pr.statusCheckRollup[0];
      assert.equal(check.state, "IN_PROGRESS", "should fall through to status");
    } finally {
      dispose();
    }
  });
});

test("GET /git/pr cache invalidates when the worktree's HEAD changes (issue #387)", async () => {
  await withPrEnv(async () => {}, async (env) => {
    const stub = buildRunner({
      META: SAMPLE_META,
      STATE: SAMPLE_STATE,
      THREADS: SAMPLE_THREADS,
    });
    const { __setPrGhRunnerForTests } = await import("../pr-data.js");
    const dispose = __setPrGhRunnerForTests(stub.runner);
    try {
      const first = await fetchPr(env.baseUrl, env.worktreeId);
      assert.ok((await first.json()).pr);
      assert.equal(stub.calls.length, 3);

      // Make a new commit so HEAD changes.
      await runGit(env.projectPath, ["commit", "--allow-empty", "-m", "v3"]);

      const second = await fetchPr(env.baseUrl, env.worktreeId);
      assert.ok((await second.json()).pr);
      assert.equal(stub.calls.length, 6, "expected a fresh three-call refetch");
    } finally {
      dispose();
    }
  });
});

test("GET /git/pr preserves the cached PR across a transient gh failure (issue #387)", async () => {
  // First request succeeds and seeds the cache. A subsequent call
  // (forced to bypass the cache by changing HEAD) hits a transient
  // failure (e.g. network blip, unrecognized non-zero exit) — the
  // route should serve the last good payload instead of
  // `{ pr: null }`, otherwise the client tears the tab out and
  // switches to Terminal on every hiccup. Definitive outcomes (no
  // PR, install / auth errors) still take precedence and overwrite
  // the cache.
  //
  // `gh pr view --json reviews` shape on this code path is exercised
  // indirectly via the constructor above — the transient branch
  // here never parses it; we keep the focus of this test on the
  // cache + failure handling.
  await withPrEnv(async () => {}, async (env) => {
    let mode: "ok" | "transient" = "ok";
    let callsInTransientMode = 0;
    const switchableRunner: import("../pr-data.js").GhRunner = async (
      args,
      cwd,
    ) => {
      if (mode === "transient") {
        callsInTransientMode++;
        // Simulate a network error / unrecognized non-zero exit.
        const err = new Error("spawn failed") as NodeJS.ErrnoException;
        err.code = 1;
        err.stdout = "";
        err.stderr = "some other random failure";
        throw err;
      }
      const payload = {
        number: 388,
        title: "transient test",
        state: "OPEN",
        url: "https://github.com/germanescobar/controller/pull/388",
        author: { login: "germanescobar", name: "German Escobar" },
        body: "Closes #387.",
        createdAt: "2026-09-22T21:09:40Z",
        headRefName: "issue-386",
        baseRefName: "main",
        additions: 1,
        deletions: 1,
        changedFiles: 1,
        mergeable: "MERGEABLE",
        isDraft: false,
        reviewDecision: "APPROVED",
        statusCheckRollup: [],
        comments: [],
        reviews: [],
      };
      const fields = args[args.indexOf("--json") + 1].split(",");
      if (fields.includes("number")) {
        return { stdout: JSON.stringify(payload), stderr: "" };
      }
      if (fields.includes("reviewDecision")) {
        return {
          stdout: JSON.stringify({
            reviewDecision: "APPROVED",
            statusCheckRollup: [],
          }),
          stderr: "",
        };
      }
      return { stdout: JSON.stringify({ comments: [], reviews: [] }), stderr: "" };
    };
    const { __setPrGhRunnerForTests } = await import("../pr-data.js");
    const dispose = __setPrGhRunnerForTests(switchableRunner);
    try {
      const first = await fetchPr(env.baseUrl, env.worktreeId);
      const firstBody = await first.json();
      assert.ok(firstBody.pr, "first call should populate the cache");
      assert.equal(firstBody.pr.title, "transient test");

      // Change HEAD so the cache check (which guards on headSha
      // equality) misses and the route actually invokes the runner
      // in transient mode. Without this the second request would
      // return the cached payload via the fast path and never
      // exercise the new transient-failure fallback (review feedback
      // on commit `6ca1849c`).
      await runGit(env.projectPath, ["commit", "--allow-empty", "-m", "v3"]);
      mode = "transient";
      const second = await fetchPr(env.baseUrl, env.worktreeId);
      const secondBody = await second.json();
      assert.ok(
        secondBody.pr,
        "transient failure should fall back to the cached payload",
      );
      assert.equal(secondBody.pr.title, "transient test");
      assert.equal(secondBody.error, undefined);
      assert.ok(
        callsInTransientMode >= 3,
        "transient mode runner should actually have been invoked",
      );
    } finally {
      dispose();
    }
  });
});

test("GET /git/pr surfaces gh_not_installed without nuking a cached PR (issue #387)", async () => {
  // Once we have a cached payload, an install error should be
  // surfaced for logging but the cached PR is the response — the
  // panel keeps showing what we knew last. This avoids a loop
  // where the user installs gh → fetches a PR → uninstalls gh →
  // sees the tab vanish. Same HEAD-bypass trick as the transient
  // test above: the cache would otherwise short-circuit the
  // missing-gh runner.
  await withPrEnv(async () => {}, async (env) => {
    let mode: "ok" | "missing" = "ok";
    let callsInMissingMode = 0;
    const switchableRunner: import("../pr-data.js").GhRunner = async () => {
      if (mode === "missing") {
        callsInMissingMode++;
        const err = new Error("spawn gh ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        err.stdout = "";
        err.stderr = "";
        throw err;
      }
      return {
        stdout: JSON.stringify({
          number: 388,
          title: "cached pr",
          state: "OPEN",
          url: "https://github.com/germanescobar/controller/pull/388",
          author: { login: "germanescobar", name: "German Escobar" },
          body: "",
          createdAt: "2026-09-22T21:09:40Z",
          headRefName: "issue-386",
          baseRefName: "main",
          additions: 0,
          deletions: 0,
          changedFiles: 0,
          mergeable: "MERGEABLE",
          isDraft: false,
        }),
        stderr: "",
      };
    };
    const { __setPrGhRunnerForTests } = await import("../pr-data.js");
    const dispose = __setPrGhRunnerForTests(switchableRunner);
    try {
      const first = await fetchPr(env.baseUrl, env.worktreeId);
      assert.ok((await first.json()).pr);

      await runGit(env.projectPath, ["commit", "--allow-empty", "-m", "v3"]);
      mode = "missing";
      const second = await fetchPr(env.baseUrl, env.worktreeId);
      const secondBody = await second.json();
      assert.ok(secondBody.pr, "cached PR should still be served");
      assert.equal(secondBody.error, undefined);
      assert.ok(
        callsInMissingMode >= 3,
        "missing mode runner should actually have been invoked",
      );
    } finally {
      dispose();
    }
  });
});

test("GET /git/pr returns { pr: null } when the branch's PR is MERGED or CLOSED (issue #387)", async () => {
  // The panel's tab is documented as rendered only for OPEN PRs.
  // `gh pr view --json` returns MERGED / CLOSED entries for the
  // current branch — without an explicit state filter — so the
  // server has to suppress them, otherwise the tab never performs
  // its documented auto-hide (issue #387 review feedback).
  for (const closedState of ["MERGED", "CLOSED"]) {
    const mergedMeta: RunnerResult = {
      stdout: JSON.stringify({
        ...JSON.parse(SAMPLE_META.stdout),
        state: closedState,
        mergedAt:
          closedState === "MERGED" ? "2026-09-26T17:00:00Z" : undefined,
      }),
      stderr: "",
    };
    await withPrEnv(async () => {}, async (env) => {
      const stub = buildRunner({
        META: mergedMeta,
        STATE: SAMPLE_STATE,
        THREADS: SAMPLE_THREADS,
      });
      const { __setPrGhRunnerForTests } = await import("../pr-data.js");
      const dispose = __setPrGhRunnerForTests(stub.runner);
      try {
        const res = await fetchPr(env.baseUrl, env.worktreeId);
        const body = await res.json();
        assert.equal(body.error, undefined);
        assert.equal(
          body.pr,
          null,
          `${closedState} PRs should surface as { pr: null } so the panel auto-hides`,
        );
      } finally {
        dispose();
      }
    });
  }
});

test("GET /git/pr preserves metadata when only the ancillary calls fail transiently (issue #387)", async () => {
  // On an initial request the cache is empty. If metadata succeeds
  // but the parallel state / threads calls time out or return
  // invalid JSON, an earlier revision discarded the working
  // metadata and returned { pr: null }. The current implementation
  // merges the successful metadata with empty defaults for the
  // ancillary parts and returns a partial PR the panel can render.
  await withPrEnv(async () => {}, async (env) => {
    let metaOnly = true;
    const partialFailureRunner: import("../pr-data.js").GhRunner = async (
      args,
      _cwd,
    ) => {
      const fields = args[args.indexOf("--json") + 1].split(",");
      if (fields.includes("number")) {
        // Metadata call succeeds with full payload.
        return {
          stdout: JSON.stringify({
            number: 388,
            title: "partial failure test",
            state: "OPEN",
            url: "https://github.com/germanescobar/controller/pull/388",
            author: { login: "germanescobar", name: "German Escobar" },
            body: "Closes #387.",
            createdAt: "2026-09-22T21:09:40Z",
            headRefName: "issue-386",
            baseRefName: "main",
            additions: 1,
            deletions: 1,
            changedFiles: 1,
            mergeable: "MERGEABLE",
            isDraft: false,
          }),
          stderr: "",
        };
      }
      if (metaOnly) {
        // First request: ancillary calls succeed too, so the cache
        // is seeded. Then we toggle `metaOnly = false` so the next
        // request must bypass the cache (via a head change) to
        // observe the ancillary-only failure path.
        metaOnly = false;
        return { stdout: JSON.stringify({}), stderr: "" };
      }
      // Ancillary-only failure: a non-classified transient error.
      const err = new Error("socket hang up") as NodeJS.ErrnoException;
      err.code = 1;
      err.stdout = "";
      err.stderr = "connection reset";
      throw err;
    };
    const { __setPrGhRunnerForTests } = await import("../pr-data.js");
    const dispose = __setPrGhRunnerForTests(partialFailureRunner);
    try {
      // First call seeds the cache (all three calls succeed; no
      // ancillary failures yet).
      const first = await fetchPr(env.baseUrl, env.worktreeId);
      const firstBody = await first.json();
      assert.ok(firstBody.pr, "seed call should populate the cache");

      // Force HEAD to change so the cache check misses and the
      // runner is actually invoked. The ancillary calls now fail.
      await runGit(env.projectPath, ["commit", "--allow-empty", "-m", "v3"]);
      const second = await fetchPr(env.baseUrl, env.worktreeId);
      const secondBody = await second.json();
      assert.ok(
        secondBody.pr,
        "successful metadata should still surface even when ancillary calls fail",
      );
      assert.equal(secondBody.pr.title, "partial failure test");
      // Empty checks / timeline are silently merged in.
      assert.equal(secondBody.pr.statusCheckRollup.length, 0);
      assert.equal(secondBody.pr.comments.length, 0);
      assert.equal(secondBody.pr.reviews.length, 0);
    } finally {
      dispose();
    }
  });
});

test("GET /git/pr keeps cached ancillary sections when only those calls fail (issue #387)", async () => {
  // After the cache TTL expires and metadata succeeds but the
  // ancillary (checks / threads) calls fail transiently, the
  // previous revision merged in empty defaults and wiped the
  // checks / comments / reviews we already had. The fix is to
  // reuse the corresponding fields from the cached PR when one
  // exists — initial loads still get empty defaults (no prior
  // payload), so the panel shows the empty-state rows correctly.
  await withPrEnv(async () => {}, async (env) => {
    let phase: "seed" | "transient" = "seed";
    const seedState = {
      reviewDecision: "APPROVED",
      statusCheckRollup: [
        {
          name: "ci / build",
          state: "SUCCESS",
          targetUrl: "https://github.com/germanescobar/controller/runs/1",
        },
      ],
    };
    const seedThreads = {
      comments: [
        {
          id: "C-cached",
          body: "cached comment",
          createdAt: "2026-09-22T21:09:51Z",
          url: "https://github.com/germanescobar/controller/pull/388#issuecomment-1",
          author: { login: "germanescobar", name: "German Escobar" },
        },
      ],
      reviews: [
        {
          id: "R-cached",
          state: "APPROVED",
          body: "cached review",
          submittedAt: "2026-09-22T22:00:00Z",
          url: "https://github.com/germanescobar/controller/pull/388#pullrequestreview-1",
          author: { login: "reviewer-bot", name: "Reviewer Bot" },
        },
      ],
    };
    const switchableRunner: import("../pr-data.js").GhRunner = async (
      args,
      _cwd,
    ) => {
      const fields = args[args.indexOf("--json") + 1].split(",");
      if (fields.includes("number")) {
        return {
          stdout: JSON.stringify({
            number: 388,
            title: "cached ancillary",
            state: "OPEN",
            url: "https://github.com/germanescobar/controller/pull/388",
            author: { login: "germanescobar", name: "German Escobar" },
            body: "Closes #387.",
            createdAt: "2026-09-22T21:09:40Z",
            headRefName: "issue-386",
            baseRefName: "main",
            additions: 1,
            deletions: 1,
            changedFiles: 1,
            mergeable: "MERGEABLE",
            isDraft: false,
          }),
          stderr: "",
        };
      }
      if (phase === "seed") {
        if (fields.includes("reviewDecision")) {
          return { stdout: JSON.stringify(seedState), stderr: "" };
        }
        return { stdout: JSON.stringify(seedThreads), stderr: "" };
      }
      // Transient phase: ancillary calls fail.
      const err = new Error("transient") as NodeJS.ErrnoException;
      err.code = 1;
      err.stdout = "";
      err.stderr = "transient ancillary failure";
      throw err;
    };
    const { __setPrGhRunnerForTests } = await import("../pr-data.js");
    const dispose = __setPrGhRunnerForTests(switchableRunner);
    try {
      // Seed the cache (full success).
      const first = await fetchPr(env.baseUrl, env.worktreeId);
      const firstBody = await first.json();
      assert.equal(firstBody.pr.statusCheckRollup.length, 1);
      assert.equal(firstBody.pr.comments.length, 1);
      assert.equal(firstBody.pr.reviews.length, 1);

      // Force HEAD change so the cache check misses and we hit
      // the runner again.
      await runGit(env.projectPath, ["commit", "--allow-empty", "-m", "v4"]);
      phase = "transient";
      const second = await fetchPr(env.baseUrl, env.worktreeId);
      const secondBody = await second.json();
      assert.ok(secondBody.pr, "metadata success should still surface a PR");
      // Cached sections are reused — the panel keeps showing them
      // instead of resetting to empty.
      assert.equal(secondBody.pr.statusCheckRollup.length, 1);
      assert.equal(secondBody.pr.statusCheckRollup[0].name, "ci / build");
      assert.equal(secondBody.pr.comments.length, 1);
      assert.equal(secondBody.pr.comments[0].body, "cached comment");
      assert.equal(secondBody.pr.reviews.length, 1);
      assert.equal(secondBody.pr.reviews[0].body, "cached review");
    } finally {
      dispose();
    }
  });
});
