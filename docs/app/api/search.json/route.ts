// Pre-rendered client-side search index. Fumadocs UI's <SearchDialog>
// fetches a search index URL by default; this route returns the
// serialized Orama index so the search bar works on GitHub Pages
// (which only serves static files, no runtime).
//
// We write the JSON to `search-index.json` at the site root so the
// URL stays short and stable regardless of the framework's default
// route resolution. The deploy workflow's size guard checks this
// exact path.
import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

const server = createFromSource(source);

export const revalidate = false;

export async function GET(): Promise<Response> {
  const payload = await server.export();
  return new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Edge caches (and the GitHub Pages CDN) can hold the file
      // indefinitely — the index only changes when content changes,
      // and a new build invalidates the deploy URL.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}