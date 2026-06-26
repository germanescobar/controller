import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarBottomBar } from "../sidebar.tsx";
import { DOCS_URL } from "@/lib/links";

function render(): string {
  return renderToStaticMarkup(
    <SidebarBottomBar onSettings={() => {}} />,
  );
}

test("SidebarBottomBar renders a help link that points at DOCS_URL with target=_blank", () => {
  const html = render();
  // The help link should be a plain <a> with the public docs URL and
  // target="_blank" so Electron's setWindowOpenHandler forwards it
  // to shell.openExternal. The data-testid gives the test (and any
  // future browser-driven automation) a stable hook.
  assert.match(html, /data-testid="sidebar-help"/);
  assert.match(html, new RegExp(`href="${DOCS_URL.replace(/[/.]/g, "\\$&")}"`));
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer"/);
});

test("SidebarBottomBar help link has an accessible name that mentions docs", () => {
  const html = render();
  // The HelpCircle icon is the only visible content; without an
  // aria-label, screen readers would announce just "link" with no
  // destination hint.
  assert.match(html, /aria-label="Open Controller docs in browser"/);
});

test("SidebarBottomBar still renders the Settings button alongside the help link", () => {
  const html = render();
  // Regression guard: the existing sidebar-settings testid must keep
  // working so we don't break whatever browser-driven automation
  // already targets it.
  assert.match(html, /data-testid="sidebar-settings"/);
  assert.match(html, />Settings</);
});
