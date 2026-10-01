import type { ConnectionInput } from "../api.ts";

export const APOLLO_MCP_URL = "https://mcp.apollo.io/mcp";

export function isApolloMcpConnection(mode: string, url: string | undefined): boolean {
  return mode === "mcp" && url?.replace(/\/$/, "") === APOLLO_MCP_URL;
}

export function apolloConnectionInput(): ConnectionInput {
  return {
    name: "Apollo",
    transport: { mode: "mcp", config: { url: APOLLO_MCP_URL } },
    auth: { schemes: [{ acquisition: "oauth_dynamic", attachment: {
      kind: "header", name: "Authorization", prefix: "Bearer ",
    } }] },
  };
}
