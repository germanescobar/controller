import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { FocusConversationControls } from "../focus-conversation-controls.tsx";
import type {
  Monitor,
  QueuedMessage,
  SessionGoal,
  SessionChildSummary,
  SessionSummary,
} from "../../api.ts";

function render(
  variant: "sidebar" | "desktop",
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
    followUps?: QueuedMessage[];
    goal?: SessionGoal | null;
    navigation?: React.ReactNode;
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
      followUps={options.followUps ?? []}
      goal={options.goal ?? null}
      navigation={options.navigation}
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

test("sidebar controls show Auto Advance, Done, and Next", () => {
  const html = render("sidebar");
  assert.match(html, /focus-conversation-controls-sidebar/);
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

test("the sidebar countdown keeps only the plain Stay action", () => {
  const html = render("sidebar", { countdown: true });
  assert.match(html, /Advancing in 4s/);
  assert.match(html, />Stay</);
  assert.match(html, /lucide-pause/);
  assert.doesNotMatch(html, />Next</);
  assert.doesNotMatch(html, /Ctrl\+S|⌃S/);
});

test("sidebar controls do not expose shortcut chips or tooltips", () => {
  const html = render("sidebar");
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

test("the sidebar renders relationships below navigation", () => {
  const html = render("sidebar", {
    parent: PARENT,
    children: [CHILD],
    currentProjectId: "proj-main",
    onOpenConversation: () => {},
    navigation: <nav>Agent Terminal Changes</nav>,
  });
  assert.match(html, /focus-conversation-relationships-sidebar/);
  assert.match(html, />Parent</);
  assert.match(html, />Children</);
  assert.match(html, />Next</);
  assert.ok(html.indexOf(">Next<") < html.indexOf("Agent Terminal Changes"));
  assert.ok(html.indexOf("Agent Terminal Changes") < html.indexOf("focus-conversation-relationship-parent"));
});

test("the sidebar navigation slot renders arbitrary archive-style content", () => {
  // SessionView injects an Archive action into the navigation slot
  // (it's not a tab — it just lives at the bottom of the nav list
  // with a separator above it). Verify the slot forwards arbitrary
  // content unchanged so the archive action keeps its semantics.
  const html = render("sidebar", {
    navigation: (
      <nav aria-label="Session views">
        <button type="button" aria-label="Archive session">
          Archive session
        </button>
      </nav>
    ),
  });
  assert.match(html, /aria-label="Archive session"/);
  assert.match(html, />Archive session</);
});

// --- Runtime rows (issue #339) --------------------------------------

const MONITOR: Monitor = {
  id: "mon-1",
  sessionId: "parent-id",
  worktreePath: "/worktree/main",
  description: "Watch CI",
  command: "gh pr checks --watch",
  persistent: false,
  deadlineAt: Date.now() + 5 * 60 * 1000,
  startedAt: "2026-09-21T00:00:00.000Z",
  status: "running",
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

test("the sidebar renders delay and monitor information", () => {
  const html = render("sidebar", {
    delayRunAt: new Date(Date.now() + 5_000).toISOString(),
    delayMessagePreview: "Hello",
    monitors: [MONITOR],
  });
  assert.match(html, /focus-conversation-runtime-sidebar/);
  assert.match(html, /Next run in/);
  assert.match(html, /Monitors \(1\)/);
  assert.match(html, /focus-conversation-runtime-delay-preview/);
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

test("activity rows show every generated follow-up and the active goal compactly", () => {
  const html = render("desktop", {
    followUps: [
      { id: "wake", origin: "wake", text: "Check CI", visibleText: "Check CI", provider: "codex", model: "gpt-6", mode: "default", attachmentIds: [], createdAt: "2026-10-18T00:00:00Z" },
      { id: "goal", origin: "goal", text: "Continue until green", visibleText: "Continue until green", provider: "codex", model: "gpt-6", mode: "default", attachmentIds: [], createdAt: "2026-10-18T00:00:00Z" },
    ],
    goal: { sessionId: "s", condition: "CI is green", setAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:00:00Z", turnsEvaluated: 1 },
  });
  assert.match(html, /Follow-ups \(2\)/);
  assert.match(html, /Check CI/);
  assert.match(html, /Continue until green/);
  assert.match(html, /Goal: CI is green/);
  assert.doesNotMatch(html, /Cancel follow-up/);
});
