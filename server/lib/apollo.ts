/** Official Apollo remote MCP endpoint and connection defaults. */
export const APOLLO_MCP_URL = "https://mcp.apollo.io/mcp";

/** Match the endpoint, not a user-editable connection name. */
export function isApolloMcpConnection(mode: string, url: string | undefined): boolean {
  return mode === "mcp" && url?.replace(/\/$/, "") === APOLLO_MCP_URL;
}

/** Conservative: unknown Apollo tools also need an explicit confirmation. */
export function apolloToolRisk(name: string, description = ""): "read" | "credit" | "external" {
  const text = `${name} ${description}`.toLowerCase().replace(/[_./-]/g, " ");
  if (/enrich|credit|\bmatch\b|compan(?:y|ies) search|organization(?:s)? search|job posting|insight|purchase/.test(text)) return "credit";
  if (/\b(create|update|delete|remove|add|send|enroll|write|approve|complete|skip|launch|schedule|stop|install|draft|modify)\b/.test(text)) return "external";
  if (/\b(search|list|read|show|view|details|status|usage|transcript|recording)\b/.test(text)) return "read";
  return "external";
}

export function apolloRiskNote(risk: "read" | "credit" | "external"): string {
  return risk === "credit"
    ? "May consume Apollo credits or incur charges; confirm the action with the user before calling."
    : risk === "external"
      ? "May change Apollo data or trigger outreach; confirm the action with the user before calling."
      : "";
}
