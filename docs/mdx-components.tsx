import defaultComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

// Merges Fumadocs' default MDX component overrides (callouts, code
// blocks, steps, etc.) with any site-specific overrides. The
// `/docs/[[...slug]]/page.tsx` route passes this to MDX content with
// extra per-page components layered on top (e.g. relative links).
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultComponents,
    ...components,
  };
}