import test from "node:test";
import assert from "node:assert/strict";
import { APOLLO_MCP_URL, apolloConnectionInput, isApolloMcpConnection } from "./apollo-connection.ts";
import { apolloToolRisk } from "../../../server/lib/apollo.ts";

test("Apollo preset uses the official MCP URL and browser OAuth", () => {
  const input = apolloConnectionInput();
  assert.equal(input.transport.mode, "mcp");
  assert.equal(input.transport.config?.url, APOLLO_MCP_URL);
  assert.deepEqual(input.auth.schemes, [{
    acquisition: "oauth_dynamic",
    attachment: { kind: "header", name: "Authorization", prefix: "Bearer " },
  }]);
  assert.equal(isApolloMcpConnection("mcp", input.transport.config?.url), true);
  assert.equal(isApolloMcpConnection("mcp", "https://example.com/mcp"), false);
});

test("Apollo tool risk classification is conservative", () => {
  assert.equal(apolloToolRisk("people_search"), "read");
  assert.equal(apolloToolRisk("organizations_enrich"), "credit");
  assert.equal(apolloToolRisk("emailer_messages_send_now"), "external");
  assert.equal(apolloToolRisk("new_tool"), "external");
});
