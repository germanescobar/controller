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
  // `/docs` (empty slug) is a real route — it should redirect or render
  // the same content as `/docs/overview`. We include the empty-slug
  // entry explicitly so Next.js pre-renders both `/docs` and the
  // nested doc routes. The page-level redirect happens in the Page
  // component below when `params.slug` is undefined.
  const params = source.generateParams("slug");
  // The typed return requires a `lang` field; we don't use i18n so
  // it's always the empty string.
  params.push({ slug: [], lang: "" });
  return params;
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
  // `/docs` (empty slug) resolves to the overview page via the
  // shared `getPage` helper. We don't add the fallback here because
  // the helper is also called from `generateMetadata`, and a single
  // source of truth keeps both paths in sync.
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