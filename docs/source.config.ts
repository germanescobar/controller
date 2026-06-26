import { defineDocs, defineConfig } from "fumadocs-mdx/config";

// `defineDocs` is the standard Fumadocs+Next.js convention for declaring a
// single content collection rooted at content/docs. `defineConfig` lets
// us add a global frontmatter schema (currently just a `title`) without
// having to repeat it on every collection.
export default defineConfig({
  mdxOptions: {
    // MDX 3 is the default; we keep the option explicit so future bumps
    // are deliberate.
  },
});

export const docs = defineDocs({
  dir: "content/docs",
});
