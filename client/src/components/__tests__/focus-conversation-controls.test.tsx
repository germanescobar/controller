import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { FocusConversationControls } from "../focus-conversation-controls.tsx";

function render(
  variant: "mobile" | "desktop",
  options: {
    isOnRadar?: boolean;
    countdown?: boolean;
    autoAdvance?: boolean;
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
    />,
  );
}

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
