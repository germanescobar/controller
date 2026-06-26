import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPage } from "../../pages/Settings.tsx";

/*
 * Regression test for the responsive contract of the Settings page
 * (issue #179). The page renders the sections twice:
 *
 *   - A `md:hidden` mobile tab strip with horizontally-scrollable tabs.
 *   - A `hidden md:flex` desktop side nav.
 *
 * Both renderings share the stable test ids `settings-nav-<id>` (added in
 * #167) so existing browser-driven automation keeps working regardless of
 * the active viewport. The active section is also marked with
 * `aria-current="page"` in both renderings for assistive tech.
 *
 * `shortcuts` was added in issue #235; we assert it surfaces in both
 * layouts too so the tab isn't accidentally hidden on mobile.
 */

const SECTIONS = ["agents", "integrations", "skills", "shortcuts"] as const;

function render(): string {
  return renderToStaticMarkup(
    <SettingsPage
      section="agents"
      onSectionChange={() => {}}
      onClose={() => {}}
    />,
  );
}

test("Settings renders every section with the stable settings-nav-<id> test id", () => {
  const html = render();
  // Both the mobile tab strip and the desktop side nav emit the test id,
  // so we expect each section id to appear at least twice.
  for (const id of SECTIONS) {
    const matches = html.match(new RegExp(`data-testid="settings-nav-${id}"`, "g")) ?? [];
    assert.ok(
      matches.length >= 2,
      `expected at least 2 occurrences of settings-nav-${id} (mobile + desktop), got ${matches.length}`,
    );
  }
});

test("Settings marks the active section with aria-current='page' in both layouts", () => {
  const html = render();
  const activeMatches = html.match(/aria-current="page"/g) ?? [];
  // One in the mobile tab strip, one in the desktop side nav.
  assert.equal(
    activeMatches.length,
    2,
    `expected exactly 2 aria-current="page" attributes (mobile + desktop), got ${activeMatches.length}`,
  );
  // The active section is "agents" in this render, and the desktop nav uses
  // the full label ("Agents & Models") while the mobile tabs use the
  // short label ("Agents"). Both buttons should be present.
  assert.match(html, /Agents &amp; Models/);
  assert.match(html, /Agents/);
});

test("Settings renders a mobile back control and a desktop close control", () => {
  const html = render();
  // The mobile back button uses an aria-label of "Back" and the desktop
  // close button uses "Close settings". Both are wired to onClose.
  assert.match(html, /aria-label="Back"/);
  assert.match(html, /aria-label="Close settings"/);
});

test("Settings marks the section nav items as buttons (no anchor tag, easy to activate on touch)", () => {
  const html = render();
  const buttonMatches = html.match(/<button/g) ?? [];
  // 3 section buttons in the mobile strip + 3 in the desktop nav + the
  // back button + the desktop close button = at least 8 buttons.
  assert.ok(
    buttonMatches.length >= 8,
    `expected at least 8 <button> elements, got ${buttonMatches.length}`,
  );
});
