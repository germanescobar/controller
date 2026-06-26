"use client";

// Static SearchDialog wiring for the GitHub Pages export. The default
// search dialog in Fumadocs UI is fetch-backed and POSTs to a server
// route handler — Pages serves only static files, so we force the
// static (client-side, Orama) client via `type="static"` and point it
// at the index file the /api/search.json route emits at build time.
//
// Splitting this out from the root layout keeps the layout as a
// server component: only this client wrapper needs the browser bundle
// (`fumadocs-core/search/client/orama-static`), and the lazy import
// inside DefaultSearchDialog keeps it out of the initial JS.
import DefaultSearchDialog from "fumadocs-ui/components/dialog/search-default";
import type { ComponentProps } from "react";

// The path MUST include the Next.js `basePath` (/controller on the
// GitHub Pages project site). basePath only rewrites links the Next
// asset pipeline renders server-side; it does NOT rewrite string
// literals in client components, so a bare `/api/search.json` would
// fetch from `https://<origin>/api/search.json` and 404.
const SEARCH_API = "/controller/api/search.json";

export function StaticSearchDialog(
  props: Omit<ComponentProps<typeof DefaultSearchDialog>, "type" | "api">,
) {
  return <DefaultSearchDialog type="static" api={SEARCH_API} {...props} />;
}