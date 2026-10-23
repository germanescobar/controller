import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { validatePreviewUrl } from "../../../electron/preview-url-policy.ts";

test("popup destinations use the same scheme and file boundary policy", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "controller-preview-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await mkdir(project);
  const inside = path.join(project, "inside.html");
  const outside = path.join(root, "outside.html");
  const link = path.join(project, "escape.html");
  await writeFile(inside, "inside");
  await writeFile(outside, "outside");
  await symlink(outside, link);

  assert.equal((await validatePreviewUrl("https://example.com", project)).allowed, true);
  assert.equal((await validatePreviewUrl(pathToFileURL(inside).toString(), project)).allowed, true);
  assert.equal((await validatePreviewUrl(pathToFileURL(outside).toString(), project)).allowed, false);
  assert.equal((await validatePreviewUrl(pathToFileURL(link).toString(), project)).allowed, false);
  assert.equal((await validatePreviewUrl("javascript:alert(1)", project)).allowed, false);
  assert.equal((await validatePreviewUrl("about:blank", project)).allowed, false);
});
