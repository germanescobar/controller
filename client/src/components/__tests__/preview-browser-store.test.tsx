import assert from "node:assert/strict";
import test from "node:test";
import { PreviewBrowserStore } from "../PreviewBrowserPool.tsx";

test("popup tabs switch, close, and keep independent navigation state", () => {
  const store = new PreviewBrowserStore();
  store.track("project:worktree", "/worktree");
  const first = store.getPane("project:worktree").activeTabId;
  store.updateTab("project:worktree", first, { url: "https://one.example", src: "https://one.example", title: "One" });

  const popup = store.addTab("project:worktree");
  store.updateTab("project:worktree", popup, { url: "https://two.example", src: "https://two.example", title: "Two" });
  assert.equal(store.getPane("project:worktree").url, "https://two.example");
  assert.equal(store.getTab("project:worktree", first)?.url, "https://one.example");
  assert.equal(store.getTopology()[0].tabs.length, 2);
  store.updateTab("project:worktree", popup, { url: "https://redirected.example" });
  assert.equal(store.getPane("project:worktree").url, "https://redirected.example");
  assert.equal(store.getTopology()[0].tabs[1].src, "https://two.example");

  store.selectTab("project:worktree", first);
  assert.equal(store.getPane("project:worktree").title, "One");
  store.closeTab("project:worktree", first);
  assert.equal(store.getPane("project:worktree").activeTabId, popup);
  store.closeTab("project:worktree", popup);
  assert.equal(store.getPane("project:worktree").url, null);
  assert.equal(store.getPane("project:worktree").tabs.length, 1);

  // An async validation reply from the closed tab cannot resurrect it.
  store.updateTab("project:worktree", popup, { url: "https://late.example" });
  assert.equal(store.getPane("project:worktree").url, null);
});
