import test from "node:test";
import assert from "node:assert/strict";
import { PreviewViewportStore } from "./preview-viewport.js";

test("viewport presets are isolated by pane and default restores host sizing", () => {
  const store = new PreviewViewportStore();
  assert.deepEqual(store.set("project:one", "mobile"), { width: 390, height: 844 });
  assert.deepEqual(store.set("project:two", "desktop"), { width: 1280, height: 800 });
  assert.equal(store.set("project:one", "default"), null);
  assert.equal(store.get("project:one"), null);
  assert.deepEqual(store.get("project:two"), { width: 1280, height: 800 });
});
