import test from "node:test";
import assert from "node:assert/strict";
import { SidebarRefreshQueue, type SidebarRefreshScopes } from "./sidebar-refresh-queue.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("serializes full and targeted writes, merging scopes received during a run", async () => {
  const first = deferred();
  const second = deferred();
  const calls: string[] = [];
  let active = 0;
  const queue = new SidebarRefreshQueue(
    async () => {
      assert.equal(++active, 1);
      calls.push("full");
      await first.promise;
      active--;
    },
    async (scopes: SidebarRefreshScopes) => {
      assert.equal(++active, 1);
      calls.push(JSON.stringify(scopes));
      await second.promise;
      active--;
    },
  );
  const full = queue.enqueueFull();
  await tick();
  queue.enqueueSession("p", "w");
  queue.enqueueSession("p", "w");
  queue.enqueueProject("p");
  await tick();
  assert.deepEqual(calls, ["full"]);
  first.resolve();
  await full;
  await tick();
  assert.deepEqual(calls, ["full", JSON.stringify({
    projects: ["p"], catchUpProjects: [],
    sessions: [{ projectId: "p", worktreeId: "w" }],
  })]);
  second.resolve();
  await tick();
});

test("a queued full refresh subsumes pending scopes and coalesces full requests", async () => {
  const gate = deferred();
  const calls: string[] = [];
  let runs = 0;
  const queue = new SidebarRefreshQueue(async () => {
    calls.push("full");
    if (++runs === 1) await gate.promise;
  }, async () => { calls.push("targets"); });
  const first = queue.enqueueFull();
  await tick();
  queue.enqueueSession("p", "w");
  const second = queue.enqueueFull();
  const third = queue.enqueueFull();
  queue.enqueueProject("p");
  gate.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(calls, ["full", "full"]);
});

test("failed refresh does not stop later queued work", async () => {
  const gate = deferred();
  const calls: string[] = [];
  const queue = new SidebarRefreshQueue(async () => {
    calls.push("full");
    await gate.promise;
    throw new Error("failed");
  }, async () => { calls.push("targets"); });
  const full = queue.enqueueFull();
  await tick();
  queue.enqueueSession("p", "w");
  gate.resolve();
  await assert.rejects(full, /failed/);
  await tick();
  assert.deepEqual(calls, ["full", "targets"]);
});

test("replays scopes covered by a queued full reload if it fails", async () => {
  const gate = deferred();
  const calls: SidebarRefreshScopes[] = [];
  const queue = new SidebarRefreshQueue(async () => {
    await gate.promise;
    throw new Error("full failed");
  }, async (scopes) => { calls.push(scopes); });
  queue.enqueueProject("p");
  queue.enqueueSession("p", "w");
  const full = queue.enqueueFull();
  queue.enqueueCatchUpProject("q");
  gate.resolve();
  await assert.rejects(full, /full failed/);
  await tick();
  assert.deepEqual(calls, [{
    projects: ["p"], catchUpProjects: ["q"],
    sessions: [{ projectId: "p", worktreeId: "w" }],
  }]);
});

test("a full reload queued during another run retains its own covered scopes", async () => {
  const gate = deferred();
  const calls: SidebarRefreshScopes[] = [];
  let runs = 0;
  const queue = new SidebarRefreshQueue(async () => {
    if (++runs === 1) await gate.promise;
    else throw new Error("second failed");
  }, async (scopes) => { calls.push(scopes); });
  const first = queue.enqueueFull();
  await tick();
  queue.enqueueProject("p");
  const second = queue.enqueueFull();
  gate.resolve();
  await first;
  await assert.rejects(second, /second failed/);
  await tick();
  assert.deepEqual(calls, [{ projects: ["p"], catchUpProjects: [], sessions: [] }]);
});

test("active-project catch-up scope merges without broadening ordinary project refreshes", async () => {
  const calls: SidebarRefreshScopes[] = [];
  const queue = new SidebarRefreshQueue(async () => {}, async (scopes) => { calls.push(scopes); });
  queue.enqueueProject("p");
  queue.enqueueCatchUpProject("p");
  queue.enqueueCatchUpProject("p");
  await tick();
  assert.deepEqual(calls, [{ projects: ["p"], catchUpProjects: ["p"], sessions: [] }]);
});
