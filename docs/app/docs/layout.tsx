import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "@/lib/source";

// Standard Fumadocs+Next.js docs layout: sidebar from the page tree,
// top header bar, container width control. The page tree is built by
// the loader from `content/docs/**/meta.json` files and individual MDX
// frontmatter `title` entries.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: "Controller",
        url: "/docs",
      }}
    >
      {children}
    </DocsLayout>
  );
}