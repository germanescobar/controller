import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { MarkdownImage } from "../MarkdownImage.tsx";

test("chat Markdown preserves artifact and remote images while sanitizing unsafe protocols", () => {
  const html = renderToStaticMarkup(<ReactMarkdown components={{ img: MarkdownImage }}>{
    '![capture](/api/browser/artifacts/pane/session/id.png)\n\n![remote](https://example.com/image.png)\n\n![unsafe](file:///etc/passwd)\n\n![script](javascript:alert)'
  }</ReactMarkdown>);
  assert.match(html, /src="\/api\/browser\/artifacts\/pane\/session\/id.png"/);
  assert.match(html, /src="https:\/\/example.com\/image.png"/);
  assert.doesNotMatch(html, /src="(?:file:|javascript:)/);
  assert.match(html, /unsafe \(image unavailable\)/);
});
