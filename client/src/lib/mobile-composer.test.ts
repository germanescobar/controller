import test from "node:test";
import assert from "node:assert/strict";
import { getComposerLayout } from "./mobile-composer.ts";

test("mobile composer is one line without details until focused", () => {
  assert.deepEqual(getComposerLayout(true, false, 5), {
    showDetails: false,
    showCompactActions: true,
    maxLines: 1,
    autoFocusOnSessionChange: false,
  });

  assert.deepEqual(getComposerLayout(true, true, 5), {
    showDetails: true,
    showCompactActions: false,
    maxLines: 5,
    autoFocusOnSessionChange: false,
  });
});

test("desktop composer remains expanded and keyboard-ready", () => {
  assert.deepEqual(getComposerLayout(false, false, 5), {
    showDetails: true,
    showCompactActions: false,
    maxLines: 5,
    autoFocusOnSessionChange: true,
  });
});
