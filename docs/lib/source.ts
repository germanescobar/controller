// Generated/typed surface for the docs content collection. The build
// pipeline (createMDX) scans `content/docs/**/*.mdx` and `meta.json`
// files and emits typed `.source` artifacts at build time. We import
// the typed `docs` collection from there, then create a `loader()` to
// turn it into the runtime surface used by the docs route group
// (`getPage`, `getPages`, `pageTree`, etc.).
//
// `baseUrl` is what `next.config.mjs` declares via `basePath` — it is
// used by `source` to rewrite absolute URLs for search and page
// resolution so client-side navigation stays inside the
// `https://germanescobar.github.io/controller/` prefix.
import { docs } from "@/.source/server";
import { loader } from "fumadocs-core/source";

const fumadocsSource = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});

// The route layer only needs three handles. We re-export them so the
// route file doesn't reach into the loader object directly — this also
// keeps the loader import off the route's hot path.
export const source = fumadocsSource;

export function getPage(slug: string[] | undefined) {
  return fumadocsSource.getPage(slug);
}

export function getPages() {
  return fumadocsSource.getPages();
}