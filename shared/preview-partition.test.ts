import assert from "node:assert/strict";
import test from "node:test";
import { PreviewCertPolicy, previewPartitionForKey } from "./preview-partition.js";

test("browser keys map to distinct Electron-safe partitions", () => {
  const keys = [
    "project:worktree-a",
    "project:worktree_b",
    "project/worktree-a",
    "project:worktree-a_",
    "project:🌳",
  ];
  const partitions = keys.map(previewPartitionForKey);

  assert.equal(new Set(partitions).size, keys.length);
  for (const partition of partitions) {
    assert.match(partition, /^controller-preview-[a-zA-Z0-9_-]+$/);
  }
  assert.equal(previewPartitionForKey(keys[0]), partitions[0]);
  assert.throws(() => previewPartitionForKey(""), /must not be empty/);
});

test("certificate policies are independent across panes and allow only loopback", () => {
  const paneA = new PreviewCertPolicy();
  const paneB = new PreviewCertPolicy();

  paneA.setInsecure(true);
  paneB.setInsecure(false);
  for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "[::1]", "::1"]) {
    assert.equal(paneA.verify(host), 0);
    assert.equal(paneB.verify(host), -3);
  }
  assert.equal(paneA.verify("example.com"), -3);
  assert.equal(paneA.verify("localhost.evil.com"), -3);

  paneB.setInsecure(true);
  paneA.setInsecure(false);
  assert.equal(paneA.verify("localhost"), -3);
  assert.equal(paneB.verify("localhost"), 0);
});
