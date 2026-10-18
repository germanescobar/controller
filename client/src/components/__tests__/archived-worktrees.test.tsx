import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";

/*
 * Smoke test for the dedicated archive view. Renders the page
 * with a fake fetch so we can lock in the static structure: the
 * empty-state copy, the per-row "Unarchive" and "Delete forever"
 * buttons, the client-side filter, and the `?includeRemoved=1`
 * fetch flag the server uses to opt in to archived rows.
 *
 * The interaction-heavy flows (actual restore / purge / SSE
 * refresh) are covered by `client/src/lib/__tests__/archive-worktrees.test.ts`
 * and `server/lib/__tests__/worktree-archive-view.test.ts`. This
 * file only guards the page composition so a future refactor
 * that drops the destructive button or the empty state fails
 * the build.
 *
 * The same happy-dom + `createRoot` pattern used by
 * `jump-to-bottom-button.test.tsx` — happy-dom provides the DOM
 * React needs, and `IS_REACT_ACT_ENVIRONMENT: true` silences the
 * "not configured to support act(...)" warning under Node.
 */

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function installFetchMock(
  handler: (call: FetchCall) => Response | Promise<Response>,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler({ url, init });
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ORIGINAL_BASE = process.env.CONTROLLER_BASE_URL;
const ORIGINAL_ACT_ENV = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT;

test.before(() => {
  // `EventSource` is a browser global; the archive view
  // subscribes to the project-events SSE stream on mount, so
  // polyfill a no-op implementation before the module is
  // imported. The polyfill only needs to keep
  // `new EventSource(...)` from throwing under `createRoot`; the
  // network-level interactions are stubbed via
  // `installFetchMock` below.
  (globalThis as unknown as { EventSource: unknown }).EventSource = class {
    url: string;
    constructor(url: string) {
      this.url = url;
    }
    addEventListener() {}
    close() {}
  };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

test.after(() => {
  if (ORIGINAL_BASE === undefined) delete process.env.CONTROLLER_BASE_URL;
  else process.env.CONTROLLER_BASE_URL = ORIGINAL_BASE;
  if (ORIGINAL_ACT_ENV === undefined) {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  } else {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      ORIGINAL_ACT_ENV;
  }
});

async function renderAndSettle(
  ui: React.ReactNode
): Promise<{ host: unknown; window: Window }> {
  const browserWindow = new Window({ url: "http://localhost" });
  // Base-UI's `Button` checks `instanceof HTMLElement` on the
  // ref, so happy-dom's constructor needs to be reachable as a
  // global. `Object.assign` overwrites the same names Node has
  // hoisted (window, document) and adds the ones React's DOM
  // runtime expects (`HTMLElement`, `Element`, `Node`).
  Object.assign(globalThis, {
    window: browserWindow,
    document: browserWindow.document,
    HTMLElement: browserWindow.HTMLElement,
    Element: browserWindow.Element,
    Node: browserWindow.Node,
  });
  const host = browserWindow.document.createElement("div");
  browserWindow.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLDivElement);
  await act(async () => {
    root.render(ui);
    // Let the mount-time `useEffect` fire and the fetch promise
    // settle. Three setImmediate hops is enough for the JSON
    // body to be parsed and `setWorktrees` to flush.
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  return { host, window: browserWindow };
}

test("archive view renders the empty-state copy when there are no archived worktrees", async () => {
  const mock = installFetchMock(() => jsonResponse(200, []));
  let host: { innerHTML: string; remove: () => void } | null = null;
  let browserWindow: Window | null = null;
  try {
    const { ArchivedWorktrees } = await import("../../pages/ArchivedWorktrees.tsx");
    const rendered = await renderAndSettle(
      <ArchivedWorktrees projectId="proj-1" projectName="demo" onClose={() => {}} />,
    );
    host = rendered.host as unknown as { innerHTML: string; remove: () => void };
    browserWindow = rendered.window;
    const html = host.innerHTML;
    assert.match(html, /Archived worktrees/);
    assert.match(html, /No archived worktrees/);
    // No per-row buttons when the list is empty.
    assert.doesNotMatch(html, /Unarchive/);
    assert.doesNotMatch(html, /Delete forever/);
  } finally {
    if (host && browserWindow) host.remove();
    if (browserWindow) await browserWindow.happyDOM.close();
    mock.restore();
  }
});

test("archive view renders one row per archived worktree with action buttons", async () => {
  const mock = installFetchMock(() =>
    jsonResponse(200, [
      {
        id: "wt-1",
        projectId: "proj-1",
        name: "issue-1",
        path: "/tmp/issue-1",
        branch: "issue-1",
        isMain: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        presence: "removed",
      },
      {
        id: "wt-2",
        projectId: "proj-1",
        name: "issue-2",
        path: "/tmp/issue-2",
        branch: "issue-2",
        isMain: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        presence: "removed",
      },
    ]),
  );
  let host: { innerHTML: string; remove: () => void } | null = null;
  let browserWindow: Window | null = null;
  try {
    const { ArchivedWorktrees } = await import("../../pages/ArchivedWorktrees.tsx");
    const rendered = await renderAndSettle(
      <ArchivedWorktrees projectId="proj-1" projectName="demo" onClose={() => {}} />,
    );
    host = rendered.host as unknown as { innerHTML: string; remove: () => void };
    browserWindow = rendered.window;
    const html = host.innerHTML;
    // Both rows are rendered.
    assert.match(html, /issue-1/);
    assert.match(html, /issue-2/);
    // Each row has both action buttons. We don't count exact
    // occurrences because the AlertDialog also serializes its
    // copy ("Delete forever?"), but the button labels appear at
    // least twice — once per row.
    assert.match(html, /Unarchive/);
    assert.match(html, /Delete forever/);
  } finally {
    if (host && browserWindow) host.remove();
    if (browserWindow) await browserWindow.happyDOM.close();
    mock.restore();
  }
});

test("archive view filters out non-archived rows on the client", async () => {
  // Even if a misbehaving server returns active rows in the
  // `?includeRemoved=1` response, the page itself must drop
  // them. Otherwise a stale row reappears in the archive list
  // and confuses the user.
  const mock = installFetchMock(() =>
    jsonResponse(200, [
      {
        id: "wt-1",
        projectId: "proj-1",
        name: "issue-1",
        path: "/tmp/issue-1",
        branch: "issue-1",
        isMain: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        presence: "removed",
      },
      {
        id: "wt-2",
        projectId: "proj-1",
        name: "live-1",
        path: "/tmp/live-1",
        branch: "live-1",
        isMain: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        presence: "active",
      },
    ]),
  );
  let host: { innerHTML: string; remove: () => void } | null = null;
  let browserWindow: Window | null = null;
  try {
    const { ArchivedWorktrees } = await import("../../pages/ArchivedWorktrees.tsx");
    const rendered = await renderAndSettle(
      <ArchivedWorktrees projectId="proj-1" projectName="demo" onClose={() => {}} />,
    );
    host = rendered.host as unknown as { innerHTML: string; remove: () => void };
    browserWindow = rendered.window;
    const html = host.innerHTML;
    assert.match(html, /issue-1/);
    assert.doesNotMatch(html, /live-1/);
  } finally {
    if (host && browserWindow) host.remove();
    if (browserWindow) await browserWindow.happyDOM.close();
    mock.restore();
  }
});

test("archive view fetches with the includeRemoved flag so the server returns the full registry", async () => {
  const mock = installFetchMock(() => jsonResponse(200, []));
  let host: { innerHTML: string; remove: () => void } | null = null;
  let browserWindow: Window | null = null;
  try {
    const { ArchivedWorktrees } = await import("../../pages/ArchivedWorktrees.tsx");
    const rendered = await renderAndSettle(
      <ArchivedWorktrees projectId="proj-1" projectName="demo" onClose={() => {}} />,
    );
    host = rendered.host as unknown as { innerHTML: string; remove: () => void };
    browserWindow = rendered.window;
    // The page issues its worktree fetch on mount; the flag is
    // what unlocks the archived rows.
    const calls = mock.calls.filter((c) => c.url.includes("/worktrees"));
    assert.ok(calls.length >= 1, "expected at least one /worktrees fetch");
    for (const call of calls) {
      assert.match(
        call.url,
        /[?&]includeRemoved=1(\b|&|$)/,
        `archive view must opt in to removed rows: ${call.url}`,
      );
    }
  } finally {
    if (host && browserWindow) host.remove();
    if (browserWindow) await browserWindow.happyDOM.close();
    mock.restore();
  }
});
