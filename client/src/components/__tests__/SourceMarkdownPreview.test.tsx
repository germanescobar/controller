import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveMarkdownFilePath, SourceMarkdownPreview } from "../SourceMarkdownPreview.tsx";

test("Markdown file paths resolve relative to the document", () => {
  const file = "/project/docs/post.md";
  assert.equal(resolveMarkdownFilePath(file, "../images/plot%201.png"), "/project/images/plot 1.png");
  assert.equal(resolveMarkdownFilePath(file, "./other.md#heading"), "/project/docs/other.md");
  assert.equal(resolveMarkdownFilePath(file, "https://example.com"), null);
  assert.equal(resolveMarkdownFilePath(file, "//example.com/file.md"), null);
  assert.equal(resolveMarkdownFilePath(file, "javascript:alert(1)"), null);
  assert.equal(resolveMarkdownFilePath(file, "%zz"), null);
});

test("Markdown preview renders local images through the project route and sanitizes content", () => {
  const html = renderToStaticMarkup(
    <SourceMarkdownPreview
      content={'# Draft\n\n![chart](../images/plot.png)\n\n[Next](next.md) [Web](https://example.com)\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))'}
      filePath="/project/docs/post.md"
      projectId="project-1"
      worktreeId="worktree-1"
      onOpenFile={() => {}}
    />,
  );
  assert.match(html, /<h1 id="draft">Draft<\/h1>/);
  assert.match(html, /format=image/);
  assert.match(html, /%2Fproject%2Fimages%2Fplot.png/);
  assert.match(html, /href="next.md"/);
  assert.match(html, /href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /<script|href="javascript:|\[object Object\]/);
});

test("Markdown preview gives fragment links matching, unique heading targets", () => {
  const html = renderToStaticMarkup(
    <SourceMarkdownPreview
      content={'[Installation](#installation)\n\n## Installation\n\n## Installation'}
      filePath="/project/README.md"
      projectId="project-1"
      onOpenFile={() => {}}
    />,
  );
  assert.match(html, /href="#installation"/);
  assert.match(html, /<h2 id="installation">Installation<\/h2>/);
  assert.match(html, /<h2 id="installation-1">Installation<\/h2>/);
});

test("Markdown preview renders Mermaid fences separately from ordinary code fences", () => {
  const html = renderToStaticMarkup(
    <SourceMarkdownPreview
      content={'```mermaid\nflowchart LR\n A --> B\n```\n\n```typescript\nconst answer = 42;\n```\n\n`mermaid`'}
      filePath="/project/README.md"
      projectId="project-1"
      onOpenFile={() => {}}
    />,
  );
  assert.match(html, /Rendering Mermaid diagram/);
  assert.match(html, /<pre><code class="language-typescript">const answer = 42;/);
  assert.match(html, /<code>mermaid<\/code>/);
  assert.doesNotMatch(html, /<code class="language-mermaid">/);
});
