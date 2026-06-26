// Public site origin. Used by the /llms.txt route so the agent-
// discoverable index emits absolute URLs that resolve against the
// actual deploy, not against `/docs/...` (which would 404 on a Pages
// project site since Pages serves the site under /<repo>/).
//
// The base path (`/controller`) is the GitHub Pages project path;
// switching to a custom domain later is a one-line change here plus
// removing `basePath` from next.config.mjs.
export const SITE_ORIGIN = "https://germanescobar.github.io";
export const SITE_BASE_PATH = "/controller";
