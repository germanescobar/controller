import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceImagePreview } from "../SourceImagePreview.tsx";

test("image preview uses the gated image route and escapes file paths", () => {
  const html = renderToStaticMarkup(<SourceImagePreview projectId="project" worktreeId="worktree" path="/images/a & b.png" />);
  assert.match(html, /format=image/);
  assert.match(html, /worktreeId=worktree/);
  assert.match(html, /%2Fimages%2Fa\+%26\+b.png/);
  assert.match(html, /role="status"/);
  assert.match(html, /object-contain/);
});
