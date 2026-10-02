import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { FocusConversationControls } from "../focus-conversation-controls.tsx";
import type {
  Monitor,
  SessionChildSummary,
  SessionSummary,
} from "../../api.ts";

function render(
  variant: "mobile" | "desktop",
  options: {
    isOnRadar?: boolean;
    countdown?: boolean;
    autoAdvance?: boolean;
    parent?: SessionSummary | null;
    children?: SessionChildSummary[];
    currentProjectId?: string;
    onOpenConversation?: (target: {
      projectId: string;
      worktreeId: string;
      sessionId: string;
    }) => void;
    delayRunAt?: string | null;
    delayMessagePreview?: string | null;
    monitors?: Monitor[];
  } = {},
) {
  return renderToStaticMarkup(
    <FocusConversationControls
      variant={variant}
      bindings={null}
      isOnRadar={options.isOnRadar ?? true}
      autoAdvance={options.autoAdvance ?? true}
      onNext={() => {}}
      onDone={() => {}}
      onAddToRadar={() => {}}
      onToggleAutoAdvance={() => {}}
      countdown={options.countdown ? {
        scheduledAt: Date.now(),
        durationMs: 4000,
        onStay: () => {},
      } : null}
      parent={options.parent ?? null}
      children={options.children ?? []}
      currentProjectId={options.currentProjectId}
      onOpenConversation={options.onOpenConversation}
      delayRunAt={options.delayRunAt ?? null}
      delayMessagePreview={options.delayMessagePreview ?? null}
      monitors={options.monitors ?? []}
    />,
  );
}

const PARENT: SessionSummary = {
  id: "parent-id",
  title: "Coordinator session",
  workingDirectory: "/worktree/main",
  worktreeId: "wt-main",
  model: "claude",
  createdAt: "2026-09-21T00:00:00.000Z",
  lastActiveAt: "2026-09-21T00:00:00.000Z",
  status: "completed",
};

const CHILD: SessionChildSummary = {
  id: "child-id",
  title: "Worker session",
  workingDirectory: "/worktree/main",
  worktreeId: "wt-main",
  model: "claude",
  projectId: "proj-main",
  createdAt: "2026-09-21T00:00:00.000Z",
  lastActiveAt: "2026-09-21T00:00:00.000Z",
  status: "completed",
};

test("mobile controls restore the compact radar row with Next and Done", () => {
  const html = render("mobile");
  assert.match(html, /focus-conversation-controls-mobile/);
  assert.match(html, /md:hidden/);
  assert.match(html, />Next</);
  assert.match(html, />Done</);
  assert.match(html, /Auto advance/);
  assert.match(html, /Auto-advance/);
  assert.doesNotMatch(html, /On radar \d/);
});

test("desktop controls render as a top-right floating panel", () => {
  const html = render("desktop");
  assert.match(html, /focus-conversation-controls-desktop/);
  assert.match(html, /absolute right-4 top-4/);
  assert.match(html, /hidden/);
  assert.match(html, /md:flex/);
  assert.match(html, /flex-col items-stretch/);
  assert.match(html, />Next</);
  assert.match(html, />Done</);
});

test("an unpinned session keeps the panel with Next and Add to radar", () => {
  const html = render("desktop", { isOnRadar: false });
  assert.match(html, /Add to radar/);
  assert.match(html, />Next</);
  assert.doesNotMatch(html, />Done</);
});

test("the panel owns the auto-advance switch state", () => {
  const enabledHtml = render("desktop");
  assert.match(enabledHtml, /data-checked=""/);
  assert.match(enabledHtml, /Ctrl\+T|⌃T/);
  assert.match(
    render("desktop", { autoAdvance: false }),
    /data-unchecked=""/,
  );
});

test("the panel replaces normal actions with the auto-advance countdown", () => {
  const html = render("desktop", { countdown: true });
  assert.match(html, /Advancing in 4s/);
  assert.match(html, />Stay</);
  assert.match(html, /lucide-pause/);
  assert.match(html, />Next</);
  assert.match(html, /Ctrl\+S|⌃S/);
  assert.match(html, /flex-col items-stretch/);
  assert.doesNotMatch(html, />Done</);
});

test("the mobile countdown keeps only the plain Stay action", () => {
  const html = render("mobile", { countdown: true });
  assert.match(html, /Advancing in 4s/);
  assert.match(html, />Stay</);
  assert.match(html, /lucide-pause/);
  assert.doesNotMatch(html, />Next</);
  assert.doesNotMatch(html, /Ctrl\+S|⌃S/);
});

test("mobile normal controls do not expose shortcut chips or tooltips", () => {
  const html = render("mobile");
  assert.doesNotMatch(html, /Ctrl\+[NSTD]|⌃[NSTD]/);
  assert.doesNotMatch(html, /data-slot="kbd"/);
});

// --- Relationship rows (issue #384) -----------------------------------
//
// The floating panel grows a `Parent` row when the current session has
// a parent and a `Children` row when it has any children. Both rows
// are intentionally conditional so a session with no relationships
// renders the panel unchanged (no empty section).

test("a session with no parent and no children renders the panel unchanged", () => {
  const html = render("desktop", { currentProjectId: "proj-main" });
  assert.doesNotMatch(html, /focus-conversation-relationships-desktop/);
  assert.doesNotMatch(html, />Parent</);
  assert.doesNotMatch(html, />Children</);
});

test("a child session renders a Parent row with a clickable truncated title", () => {
  const html = render("desktop", {
    parent: PARENT,
    currentProjectId: "proj-main",
    onOpenConversation: () => {},
  });
  assert.match(html, /focus-conversation-relationships-desktop/);
  assert.match(html, /focus-conversation-relationship-parent/);
  assert.match(html, />Parent</);
  // The clickable title is rendered as an <a> with a
  // `controller://` href so the existing click handler picks it
  // up without extra plumbing.
  assert.match(
    html,
    /href="controller:\/\/project\/proj-main\/worktree\/wt-main\/session\/parent-id"/
  );
  assert.match(html, /Coordinator session/);
});

test("a parent session renders a Children row with one clickable title per child", () => {
  const html = render("desktop", {
    children: [CHILD, { ...CHILD, id: "child-2", title: "Second worker" }],
    currentProjectId: "proj-main",
    onOpenConversation: () => {},
  });
  assert.match(html, /focus-conversation-relationships-desktop/);
  assert.match(html, /focus-conversation-relationship-children/);
  assert.match(html, />Children</);
  // Two anchors, one per child, each with the right URI.
  assert.match(
    html,
    /href="controller:\/\/project\/proj-main\/worktree\/wt-main\/session\/child-id"/
  );
  assert.match(
    html,
    /href="controller:\/\/project\/proj-main\/worktree\/wt-main\/session\/child-2"/
  );
  assert.match(html, /Worker session/);
  assert.match(html, /Second worker/);
});

test("missing project id hides the Parent row (URI would be malformed)", () => {
  // `currentProjectId` is unset, so the parent anchor can't be
  // built. The panel must skip the row rather than emit a broken
  // `controller://` link.
  const html = render("desktop", {
    parent: PARENT,
    currentProjectId: undefined,
    onOpenConversation: () => {},
  });
  assert.doesNotMatch(html, /focus-conversation-relationship-parent/);
  assert.doesNotMatch(html, /controller:\/\/project\//);
});

test("a child with an empty projectId renders as plain text, not a link", () => {
  // Server returns projectId: "" when the two walks found no
  // project for the child (archived between walks — see
  // server/routes/sessions.ts). The panel should render the
  // title without wiring it up as an anchor.
  const orphan = { ...CHILD, id: "orphan", projectId: "" };
  const html = render("desktop", {
    children: [orphan],
    currentProjectId: "proj-main",
    onOpenConversation: () => {},
  });
  assert.match(html, /focus-conversation-relationship-children/);
  assert.match(html, /Worker session/);
  // No anchor is rendered for the orphan row.
  assert.doesNotMatch(html, /href="[^"]*session\/orphan"/);
});

test("long titles are truncated to keep the panel compact", () => {
  const longTitle = "x".repeat(120);
  const longParent: SessionSummary = { ...PARENT, title: longTitle };
  const html = render("desktop", {
    parent: longParent,
    currentProjectId: "proj-main",
    onOpenConversation: () => {},
  });
  // The visible anchor text shows the truncated 40-char title
  // with an ellipsis. The full title still appears in the
  // `title=` attribute (browser hover / accessibility), which is
  // the expected behavior: the user sees the truncation inline
  // and the full text on hover.
  assert.match(
    html,
    />x{40}…<\/a>/
  );
  assert.match(html, new RegExp(`title="${longTitle}"`));
});

test("parent row anchor is still rendered when no onOpenConversation callback is provided", () => {
  // Without the navigation callback the click handler is a no-op,
  // but the anchor is still rendered with the right URI. The user
  // sees the relationship and can click — clicking simply doesn't
  // navigate, which matches the rest of the panel surfaces
  // (rendering isn't gated on a callback). This keeps the panel
  // mountable from places that don't have a navigation callback
  // handy (e.g. tests with a static renderToStaticMarkup call).
  const html = render("desktop", {
    parent: PARENT,
    currentProjectId: "proj-main",
  });
  assert.match(html, /focus-conversation-relationship-parent/);
  assert.match(
    html,
    /href="controller:\/\/project\/proj-main\/worktree\/wt-main\/session\/parent-id"/
  );
});

test("parent and children rows render below the Next/Done action row", () => {
  // Issue #384: the rows are stacked *below* the Add to radar /
  // Done / Next row, in the same vertical style as the rest of
  // the panel. The order matters — relationships should never
  // push the action row offscreen.
  const html = render("desktop", {
    parent: PARENT,
    children: [CHILD],
    currentProjectId: "proj-main",
    onOpenConversation: () => {},
  });
  const nextPos = html.indexOf(">Next<");
  const parentPos = html.indexOf("focus-conversation-relationship-parent");
  assert.ok(nextPos > 0, "expected Next button in rendered HTML");
  assert.ok(parentPos > 0, "expected parent row in rendered HTML");
  assert.ok(parentPos > nextPos, "parent row should appear after Next");
});

test("the mobile variant never renders the relationship rows (issue #384 out-of-scope)", () => {
  // The mobile header carries this component in a tight
  // horizontal strip. The multi-line relationship rows would
  // overflow the strip, so the issue scopes them to desktop
  // only. The mobile variant receives the same props (the
  // SessionView mounts both variants with the same data), but
  // the rows must not appear.
  const html = render("mobile", {
    parent: PARENT,
    children: [CHILD, { ...CHILD, id: "child-2" }],
    currentProjectId: "proj-main",
    onOpenConversation: () => {},
  });
  assert.doesNotMatch(html, /focus-conversation-relationships-mobile/);
  assert.doesNotMatch(html, />Parent</);
  assert.doesNotMatch(html, />Children</);
  // Existing mobile contract still holds: Next / Done visible.
  assert.match(html, />Next</);
  assert.match(html, />Done</);
});

// --- Runtime rows (issue #339) --------------------------------------
//
// The panel grows two new desktop-only rows: a `Next run in Xs`
// delay row sourced from the queue head's `runAt`, and a
// `Monitors (N)` row sourced from the live monitor list. Mobile
// stays out of scope (same rationale as the relationship rows).
// Stop / start actions are not exposed in this issue's slice —
// the bar is information-only.

const MONITOR: Monitor = {
  id: "mon-1",
  sessionId: "parent-id",
  worktreePath: "/worktree/main",
  description: "Watch CI",
  command: "gh pr checks --watch",
  persistent: false,
  deadlineAt: Date.now() + 5 * 60 * 1000,
  startedAt: "2026-09-21T00:00:00.000Z",
  lineCount: 3,
  onLinePattern: null,
};

test("no delay and no monitors keeps the panel unchanged", () => {
  // Baseline: with both new props unset the runtime block must
  // not appear — same contract as the relationship rows. The
  // existing panel shape is preserved for the common case.
  const html = render("desktop", { currentProjectId: "proj-main" });
  assert.doesNotMatch(html, /focus-conversation-runtime-desktop/);
  assert.doesNotMatch(html, />Next run in/);
  assert.doesNotMatch(html, />Monitors \(/);
});

test("a future delay renderAt renders a Next run countdown row on desktop", () => {
  const html = render("desktop", {
    delayRunAt: new Date(Date.now() + 5_000).toISOString(),
  });
  assert.match(html, /focus-conversation-runtime-desktop/);
  assert.match(html, /focus-conversation-runtime-delay/);
  assert.match(html, /Next run in/);
  // The hourglass icon is the visual marker for a queued wake.
  assert.match(html, /lucide-hourglass/);
  // No preview was supplied, so the inner preview span must
  // not be rendered — otherwise the row would always carry an
  // empty quoted label.
  assert.doesNotMatch(html, /focus-conversation-runtime-delay-preview/);
});

test("the delay row renders a quoted preview of the wake's message text", () => {
  // Without the preview the row only tells the user *when*
  // something is going to fire, not *what*. The preview makes
  // it obvious in the floating panel that `wake self "Hello"`
  // is queued, so the user doesn't need to glance at the
  // queued-messages strip below the chat input to find out.
  const html = render("desktop", {
    delayRunAt: new Date(Date.now() + 5_000).toISOString(),
    delayMessagePreview: "Hello",
  });
  assert.match(html, /focus-conversation-runtime-delay-preview/);
  // Quoted + the literal preview text. The full string still
  // appears on `title=` for hover / accessibility.
  assert.match(html, /“Hello”/);
  assert.match(html, /title="Hello"/);
});

test("the wake preview is truncated to keep the panel compact", () => {
  const long = "x".repeat(120);
  const html = render("desktop", {
    delayRunAt: new Date(Date.now() + 5_000).toISOString(),
    delayMessagePreview: long,
  });
  // 40-char truncation matches the relationship-row truncation
  // (one truncation style across the panel). The visible text is
  // wrapped in curly quotes ("…"), so the pattern accounts for
  // both opening and closing quotes. Full text on hover via
  // `title=`.
  assert.match(html, /“x{40}…[”]<\/span>/);
  assert.match(html, new RegExp(`title="${long}"`));
});

test("a past delay renderAt does not render the delay row", () => {
  // Past timestamps mean the wakes consumer would already have
  // fired; the panel must not show a "Next run in <negative>s"
  // or similar artifact. We use a timestamp far enough in the
  // past that `Date.parse(...) < now` regardless of clock drift.
  const html = render("desktop", {
    delayRunAt: new Date(Date.now() - 60_000).toISOString(),
  });
  assert.doesNotMatch(html, /focus-conversation-runtime-delay/);
  assert.doesNotMatch(html, />Next run in</);
});

test("active monitors render as a Monitors (N) row on desktop", () => {
  const html = render("desktop", {
    monitors: [
      MONITOR,
      { ...MONITOR, id: "mon-2", description: "Watch tests" },
    ],
  });
  assert.match(html, /focus-conversation-runtime-desktop/);
  assert.match(html, /focus-conversation-runtime-monitors/);
  // Both descriptions show up, count is in the header.
  assert.match(html, />Monitors \(2\)/);
  assert.match(html, /Watch CI/);
  assert.match(html, /Watch tests/);
  // Activity icon marks each entry.
  assert.match(html, /lucide-activity/);
});

test("monitor descriptions are truncated to keep the panel compact", () => {
  const longDesc = "x".repeat(120);
  const html = render("desktop", {
    monitors: [{ ...MONITOR, description: longDesc }],
  });
  // Visible text uses the same 40-char truncation the relationship
  // rows use. The full command is preserved on `title=` for
  // hover / accessibility — matches the relationship-rows pattern
  // (truncate the inline label, keep full detail on hover).
  assert.match(html, />x{40}…</);
  assert.match(html, /title="gh pr checks --watch/);
});

test("the runtime rows never render on mobile (issue #339 + #384)", () => {
  // Mobile strip is too tight for vertical rows; this is the
  // same out-of-scope rule that already excludes the
  // relationship rows. SessionView passes both new props to
  // both mounts — the mobile variant must still skip them.
  const html = render("mobile", {
    delayRunAt: new Date(Date.now() + 5_000).toISOString(),
    delayMessagePreview: "Hello",
    monitors: [MONITOR],
  });
  assert.doesNotMatch(html, /focus-conversation-runtime-mobile/);
  assert.doesNotMatch(html, />Next run in</);
  assert.doesNotMatch(html, />Monitors \(/);
  // Preview must not leak either — the delay row itself is
  // desktop-only.
  assert.doesNotMatch(html, /focus-conversation-runtime-delay-preview/);
});

test("the runtime rows render after the relationships and after the action row", () => {
  // Layout contract: the Next/Done action row stays on top, the
  // relationship rows follow, then the new runtime rows. This
  // keeps the most-used actions reachable regardless of how
  // many relationships / monitors exist.
  const html = render("desktop", {
    parent: PARENT,
    children: [CHILD],
    delayRunAt: new Date(Date.now() + 5_000).toISOString(),
    monitors: [MONITOR],
    currentProjectId: "proj-main",
    onOpenConversation: () => {},
  });
  const nextPos = html.indexOf(">Next<");
  const parentPos = html.indexOf("focus-conversation-relationship-parent");
  const delayPos = html.indexOf("focus-conversation-runtime-delay");
  const monitorPos = html.indexOf("focus-conversation-runtime-monitors");
  assert.ok(nextPos > 0, "expected Next button");
  assert.ok(parentPos > 0, "expected parent row");
  assert.ok(delayPos > 0, "expected delay row");
  assert.ok(monitorPos > 0, "expected monitor row");
  assert.ok(parentPos > nextPos, "parent should follow Next");
  assert.ok(delayPos > parentPos, "delay row should follow parent row");
  assert.ok(monitorPos > delayPos, "monitor row should follow delay row");
});
