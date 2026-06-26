import { source, getPage } from "@/lib/source";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/page";
import { notFound } from "next/navigation";
import { createRelativeLink } from "fumadocs-ui/mdx";
import { getMDXComponents } from "@/mdx-components";

// Pre-render every docs page at build time. We delegate to
// `source.generateParams()` (Fumadocs' typed wrapper around the
// page list) so we don't need to maintain a separate slug list when
// new pages are added. `dynamicParams = false` rejects any path
// outside the pre-rendered set with a 404, which is the only sane
// behavior for a static export anyway.
export const dynamicParams = false;

export function generateStaticParams() {
  return source.generateParams("slug");
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = getPage(params.slug);
  if (!page) notFound();

  const MDXContent = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={false}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        {/* `createRelativeLink` rewrites absolute /docs links to basePath-
            relative URLs so client-side navigation stays inside the
            GitHub Pages site (and honors the `basePath` config). */}
        <MDXContent
          components={getMDXComponents({
            // a (next link)
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}