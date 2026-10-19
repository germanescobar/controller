import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createSchedule,
  getSchedule,
  listSchedules,
  listScheduleRuns,
  MAX_SCHEDULE_RUNS,
  removeSchedule,
  runDueSchedules,
  setScheduleEnabled,
  tryFireSchedule,
  type SchedulesConsumerDeps,
  type ScheduleRun,
} from "../schedules.js";
import { projectSchedulesIndexFile, projectScheduleRunsFile } from "../paths.js";

/*
 * Issue #243: the schedule store and tick consumer. The race test is the
 * critical one — two ticks claiming the same due schedule must start exactly
 * one session even when the session start is slow.
 */

async function withHome<T>(fn: (projectPath: string) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "schedules-test-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = home;
  const projectPath = path.join(home, "project");
  await fs.mkdir(projectPath, { recursive: true });
  try {
    return await fn(projectPath);
  } finally {
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("createSchedule persists a one-shot and seeds nextRunAt from runAt", async () => {
  await withHome(async (projectPath) => {
    const schedule = await createSchedule(projectPath, "proj-1", {
      worktreeId: "wt-1",
      prompt: "Run the morning health check",
      runAt: "2026-06-26T08:00:00.000Z",
    });
    assert.equal(schedule.cron, null);
    assert.equal(schedule.runAt, "2026-06-26T08:00:00.000Z");
    assert.equal(schedule.nextRunAt, "2026-06-26T08:00:00.000Z");
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.source, "user");

    const reloaded = await getSchedule(projectPath, schedule.id);
    // The persisted file round-trips through JSON, which drops `undefined`
    // optional keys (provider/model/mode); compare against the same shape.
    assert.deepEqual(reloaded, JSON.parse(JSON.stringify(schedule)));
  });
});

test("createSchedule computes nextRunAt from cron for a recurring schedule", async () => {
  await withHome(async (projectPath) => {
    const schedule = await createSchedule(projectPath, "proj-1", {
      worktreeId: "wt-1",
      prompt: "weekday standup",
      cron: "0 9 * * 1-5",
      timezone: "America/New_York",
    });
    assert.equal(schedule.runAt, null);
    assert.ok(new Date(schedule.nextRunAt).getTime() > Date.now());
  });
});

test("createSchedule rejects an invalid cron and an invalid timezone", async () => {
  await withHome(async (projectPath) => {
    await assert.rejects(
      createSchedule(projectPath, "p", { worktreeId: "w", prompt: "x", cron: "nope" }),
      /Invalid cron expression/
    );
    await assert.rejects(
      createSchedule(projectPath, "p", {
        worktreeId: "w",
        prompt: "x",
        cron: "0 9 * * *",
        timezone: "Mars/Phobos",
      }),
      /Invalid timezone/
    );
  });
});

test("listSchedules includes disabled by default and can exclude them", async () => {
  await withHome(async (projectPath) => {
    const a = await createSchedule(projectPath, "p", {
      worktreeId: "w",
      prompt: "a",
      runAt: "2026-06-26T08:00:00.000Z",
    });
    await createSchedule(projectPath, "p", {
      worktreeId: "w",
      prompt: "b",
      runAt: "2026-06-27T08:00:00.000Z",
    });
    await setScheduleEnabled(projectPath, a.id, false);

    const all = await listSchedules(projectPath);
    assert.equal(all.length, 2);
    const enabledOnly = await listSchedules(projectPath, { includeDisabled: false });
    assert.equal(enabledOnly.length, 1);
    assert.equal(enabledOnly[0].prompt, "b");
  });
});

test("removeSchedule deletes the file, runs, and index entry", async () => {
  await withHome(async (projectPath) => {
    const schedule = await createSchedule(projectPath, "p", {
      worktreeId: "w",
      prompt: "a",
      runAt: "2026-06-26T08:00:00.000Z",
    });
    assert.equal(await removeSchedule(projectPath, schedule.id), true);
    assert.equal(await getSchedule(projectPath, schedule.id), null);
    assert.equal((await listSchedules(projectPath)).length, 0);
    assert.equal(await removeSchedule(projectPath, schedule.id), false);

    // Recreating after the index drained to `[]` must not look like a stale index.
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      await createSchedule(projectPath, "p", { worktreeId: "w", prompt: "b", runAt: "2026-06-26T08:00:00.000Z" });
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(warnings, []);
    assert.equal((await listSchedules(projectPath)).length, 1);
  });
});

test("tryFireSchedule fires a due one-shot once and disables it", async () => {
  await withHome(async (projectPath) => {
    const schedule = await createSchedule(projectPath, "proj-1", {
      worktreeId: "wt-1",
      prompt: "do the thing",
      runAt: "2026-06-26T08:00:00.000Z",
    });
    let started = 0;
    const deps: SchedulesConsumerDeps = {
      listProjects: async () => [{ id: "proj-1", path: projectPath }],
      startSession: async () => {
        started += 1;
        return { sessionId: "sess-fired" };
      },
      now: () => new Date("2026-06-26T08:05:00.000Z"),
    };

    await tryFireSchedule(projectPath, "proj-1", schedule.id, deps);
    assert.equal(started, 1);

    const after = await getSchedule(projectPath, schedule.id);
    assert.equal(after?.enabled, false, "one-shot is consumed after firing");
    assert.equal(after?.lastRunSessionId, "sess-fired");
    assert.equal(after?.lastError, null);

    const runs = await listScheduleRuns(projectPath, schedule.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].sessionId, "sess-fired");

    // A second tick must not re-fire the consumed one-shot.
    await tryFireSchedule(projectPath, "proj-1", schedule.id, deps);
    assert.equal(started, 1);
  });
});

test("two ticks racing the same due schedule start exactly one session (slow start)", async () => {
  await withHome(async (projectPath) => {
    const schedule = await createSchedule(projectPath, "proj-1", {
      worktreeId: "wt-1",
      prompt: "race me",
      runAt: "2026-06-26T08:00:00.000Z",
    });
    let started = 0;
    const deps: SchedulesConsumerDeps = {
      listProjects: async () => [{ id: "proj-1", path: projectPath }],
      startSession: async () => {
        started += 1;
        // Slow start: the second tick must already have observed the marked
        // (disabled) schedule and skipped before this resolves.
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { sessionId: `sess-${started}` };
      },
      now: () => new Date("2026-06-26T08:05:00.000Z"),
    };

    await Promise.all([
      tryFireSchedule(projectPath, "proj-1", schedule.id, deps),
      tryFireSchedule(projectPath, "proj-1", schedule.id, deps),
    ]);

    assert.equal(started, 1, "lock-then-mark must collapse the race to one fire");
  });
});

test("recurring schedule advances nextRunAt and stays enabled after firing", async () => {
  await withHome(async (projectPath) => {
    const schedule = await createSchedule(projectPath, "proj-1", {
      worktreeId: "wt-1",
      prompt: "hourly",
      cron: "0 * * * *",
      timezone: "UTC",
    });
    // Force it due by rewinding nextRunAt into the past via the store.
    const fileBefore = await getSchedule(projectPath, schedule.id);
    assert.ok(fileBefore);

    const deps: SchedulesConsumerDeps = {
      listProjects: async () => [{ id: "proj-1", path: projectPath }],
      startSession: async () => ({ sessionId: "sess-recurring" }),
      now: () => new Date(new Date(schedule.nextRunAt).getTime() + 1000),
    };

    await tryFireSchedule(projectPath, "proj-1", schedule.id, deps);
    const after = await getSchedule(projectPath, schedule.id);
    assert.equal(after?.enabled, true);
    assert.ok(
      new Date(after!.nextRunAt).getTime() > new Date(schedule.nextRunAt).getTime(),
      "nextRunAt should advance to the following occurrence"
    );
    assert.equal(after?.lastRunSessionId, "sess-recurring");
  });
});

test("a failing session start records lastError and does not break the schedule", async () => {
  await withHome(async (projectPath) => {
    const schedule = await createSchedule(projectPath, "proj-1", {
      worktreeId: "wt-1",
      prompt: "will fail",
      runAt: "2026-06-26T08:00:00.000Z",
    });
    const deps: SchedulesConsumerDeps = {
      listProjects: async () => [{ id: "proj-1", path: projectPath }],
      startSession: async () => {
        throw new Error("agent exploded");
      },
      now: () => new Date("2026-06-26T08:05:00.000Z"),
    };

    await tryFireSchedule(projectPath, "proj-1", schedule.id, deps);
    const after = await getSchedule(projectPath, schedule.id);
    assert.equal(after?.lastError, "agent exploded");
    assert.equal(after?.lastRunSessionId, null);

    const runs = await listScheduleRuns(projectPath, schedule.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].error, "agent exploded");
  });
});

test("runDueSchedules fires only schedules whose nextRunAt has passed", async () => {
  await withHome(async (projectPath) => {
    const due = await createSchedule(projectPath, "proj-1", {
      worktreeId: "wt-1",
      prompt: "due",
      runAt: "2026-06-26T08:00:00.000Z",
    });
    const future = await createSchedule(projectPath, "proj-1", {
      worktreeId: "wt-1",
      prompt: "future",
      runAt: "2026-06-26T10:00:00.000Z",
    });
    const fired: string[] = [];
    const deps: SchedulesConsumerDeps = {
      listProjects: async () => [{ id: "proj-1", path: projectPath }],
      startSession: async (params) => {
        fired.push(params.prompt);
        return { sessionId: `sess-${params.prompt}` };
      },
      now: () => new Date("2026-06-26T08:05:00.000Z"),
    };

    await runDueSchedules(new Date("2026-06-26T08:05:00.000Z"), deps);
    assert.deepEqual(fired, ["due"]);

    assert.equal((await getSchedule(projectPath, due.id))?.enabled, false);
    assert.equal((await getSchedule(projectPath, future.id))?.enabled, true);
  });
});

test("getSchedule/removeSchedule reject traversal ids without touching files outside the store (issue #453)", async () => {
  await withHome(async (projectPath) => {
    // The schedules dir is `<home>/projects/<key>/schedules`, so three `..`
    // segments land on `<home>/decoy.json`.
    const home = process.env.CONTROLLER_HOME as string;
    const decoy = path.join(home, "decoy.json");
    await fs.writeFile(decoy, JSON.stringify({ id: "decoy" }));

    assert.equal(await getSchedule(projectPath, "../../../decoy"), null);
    assert.equal(await removeSchedule(projectPath, "../../../decoy"), false);
    assert.deepEqual(await listScheduleRuns(projectPath, "../../../decoy"), []);
    assert.equal(await fs.readFile(decoy, "utf-8"), JSON.stringify({ id: "decoy" }));
  });
});

test("a corrupt index is rebuilt from the schedule files instead of dropping schedules (issue #470)", async () => {
  await withHome(async (projectPath) => {
    const runAt = "2026-06-26T08:00:00.000Z";
    await createSchedule(projectPath, "proj-1", { worktreeId: "wt-1", prompt: "first", runAt });
    await createSchedule(projectPath, "proj-1", { worktreeId: "wt-1", prompt: "second", runAt });
    // Simulate a torn write of the index.
    await fs.writeFile(projectSchedulesIndexFile(projectPath), '[{"id": "trunc');

    await createSchedule(projectPath, "proj-1", { worktreeId: "wt-1", prompt: "third", runAt });

    const prompts = (await listSchedules(projectPath)).map((s) => s.prompt).sort();
    assert.deepEqual(prompts, ["first", "second", "third"]);

    const fired: string[] = [];
    const deps: SchedulesConsumerDeps = {
      listProjects: async () => [{ id: "proj-1", path: projectPath }],
      startSession: async (params) => {
        fired.push(params.prompt);
        return { sessionId: `sess-${params.prompt}` };
      },
      now: () => new Date("2026-06-26T08:05:00.000Z"),
    };
    await runDueSchedules(new Date("2026-06-26T08:05:00.000Z"), deps);
    assert.deepEqual(fired.sort(), ["first", "second", "third"]);
  });
});

test("an empty index next to existing schedule files is rebuilt (issue #470)", async () => {
  await withHome(async (projectPath) => {
    const runAt = "2026-06-26T08:00:00.000Z";
    const first = await createSchedule(projectPath, "proj-1", { worktreeId: "wt-1", prompt: "first", runAt });
    const second = await createSchedule(projectPath, "proj-1", { worktreeId: "wt-1", prompt: "second", runAt });
    await fs.writeFile(projectSchedulesIndexFile(projectPath), "[]");

    const prompts = (await listSchedules(projectPath)).map((s) => s.prompt).sort();
    assert.deepEqual(prompts, ["first", "second"]);

    const index = JSON.parse(await fs.readFile(projectSchedulesIndexFile(projectPath), "utf-8"));
    assert.deepEqual(
      index.map((entry: { id: string }) => entry.id).sort(),
      [first.id, second.id].sort(),
      "the rebuilt index is persisted"
    );

    const fired: string[] = [];
    const deps: SchedulesConsumerDeps = {
      listProjects: async () => [{ id: "proj-1", path: projectPath }],
      startSession: async (params) => {
        fired.push(params.prompt);
        return { sessionId: `sess-${params.prompt}` };
      },
      now: () => new Date("2026-06-26T08:05:00.000Z"),
    };
    await runDueSchedules(new Date("2026-06-26T08:05:00.000Z"), deps);
    assert.deepEqual(fired.sort(), ["first", "second"]);
  });
});

test("a missing index falls back to the schedule files so the tick still sees them", async () => {
  await withHome(async (projectPath) => {
    const schedule = await createSchedule(projectPath, "proj-1", {
      worktreeId: "wt-1",
      prompt: "orphaned",
      runAt: "2026-06-26T08:00:00.000Z",
    });
    await fs.rm(projectSchedulesIndexFile(projectPath));

    const fired: string[] = [];
    const deps: SchedulesConsumerDeps = {
      listProjects: async () => [{ id: "proj-1", path: projectPath }],
      startSession: async (params) => {
        fired.push(params.prompt);
        return { sessionId: "sess-1" };
      },
      now: () => new Date("2026-06-26T08:05:00.000Z"),
    };
    await runDueSchedules(new Date("2026-06-26T08:05:00.000Z"), deps);
    assert.deepEqual(fired, ["orphaned"]);
    assert.deepEqual((await listSchedules(projectPath)).map((s) => s.id), [schedule.id]);
  });
});

test("run history is capped at MAX_SCHEDULE_RUNS, keeping the newest", async () => {
  await withHome(async (projectPath) => {
    const schedule = await createSchedule(projectPath, "proj-1", {
      worktreeId: "wt-1",
      prompt: "every minute",
      runAt: "2026-06-26T08:00:00.000Z",
    });
    const seeded: ScheduleRun[] = Array.from({ length: MAX_SCHEDULE_RUNS }, (_, i) => ({
      firedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      sessionId: `old-${i}`,
      error: null,
    }));
    await fs.writeFile(
      projectScheduleRunsFile(projectPath, schedule.id),
      JSON.stringify(seeded)
    );

    const deps: SchedulesConsumerDeps = {
      listProjects: async () => [{ id: "proj-1", path: projectPath }],
      startSession: async () => ({ sessionId: "newest" }),
      now: () => new Date("2026-06-26T08:05:00.000Z"),
    };
    await tryFireSchedule(projectPath, "proj-1", schedule.id, deps);

    const runs = await listScheduleRuns(projectPath, schedule.id);
    assert.equal(runs.length, MAX_SCHEDULE_RUNS);
    assert.equal(runs[0].sessionId, "old-1", "the oldest run is dropped");
    assert.equal(runs[runs.length - 1].sessionId, "newest");
  });
});
