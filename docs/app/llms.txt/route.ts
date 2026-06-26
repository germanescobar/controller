// /llms.txt — agent-discoverable index of the public docs site. Same
// format as the emerging `llms.txt` convention: a plain Markdown
// document listing every doc page with a short description and the
// absolute URL.
//
// We walk the loader's `generateParams()` output (the same set of
// slugs the static export uses) and emit one entry per page. Each
// entry uses the page's `description` frontmatter so the index stays
// in sync with the actual content. The route runs at build time —
// Next.js pre-renders the response as a static file at
// `out/llms.txt`, served as plain text by GitHub Pages.
import { source, getPage } from "@/lib/source";

export const revalidate = false;

const BASE_URL = "/docs";

export async function GET(): Promise<Response> {
  const entries: { name: string; description: string; url: string }[] = [];
  const params = source.generateParams("slug");
  for (const p of params) {
    const slug = p.slug.length ? p.slug : ["overview"];
    const page = getPage(slug);
    if (!page) continue;
    entries.push({
      name: page.data.title ?? slug.join("/"),
      description: page.data.description ?? "",
      url: `${BASE_URL}/${slug.join("/")}`,
    });
  }

  const lines: string[] = ["# Controller Docs"];
  for (const entry of entries) {
    const desc = entry.description.replace(/\s+/g, " ").trim();
    lines.push(`- [${entry.name}](${entry.url}): ${desc}`);
  }

  // `text/plain` so agents can `curl` it without a Markdown
  // renderer. The leading `# Controller Docs` keeps it parseable by
  // anything that does want Markdown.
  return new Response(lines.join("\n") + "\n", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
