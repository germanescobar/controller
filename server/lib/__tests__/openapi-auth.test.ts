import test from "node:test";
import assert from "node:assert/strict";
import { parseOpenApiAuth } from "../openapi-auth.js";

test("derives Trello's two static query attachments from one AND requirement", () => {
  const spec = {
    openapi: "3.0.0",
    info: { title: "Trello API" },
    servers: [{ url: "https://api.trello.com/1" }],
    components: {
      securitySchemes: {
        APIKey: { type: "apiKey", in: "query", name: "key" },
        APIToken: { type: "apiKey", in: "query", name: "token" },
      },
    },
    security: [{ APIKey: [], APIToken: [] }],
  };

  const info = parseOpenApiAuth(spec);
  assert.equal(info.title, "Trello API");
  assert.equal(info.baseUrl, "https://api.trello.com/1");
  assert.equal(info.alternatives.length, 1);
  assert.deepEqual(info.alternatives[0].schemes, [
    { acquisition: "static", attachment: { kind: "query", name: "key" }, config: {}, label: "APIKey" },
    { acquisition: "static", attachment: { kind: "query", name: "token" }, config: {}, label: "APIToken" },
  ]);
  assert.deepEqual(info.unsupported, []);
});

test("maps OpenAPI scheme types onto acquisition × attachment", () => {
  const spec = {
    components: {
      securitySchemes: {
        Bearer: { type: "http", scheme: "bearer" },
        Basic: { type: "http", scheme: "basic" },
        ApiHeader: { type: "apiKey", in: "header", name: "X-API-Key" },
        OAuth: {
          type: "oauth2",
          flows: { clientCredentials: { tokenUrl: "https://x/token", scopes: { read: "r" } } },
        },
      },
    },
    // Each object is a separate OR alternative.
    security: [{ Bearer: [] }, { Basic: [] }, { ApiHeader: [] }, { OAuth: [] }],
  };

  const flat = parseOpenApiAuth(spec).alternatives.map((a) => a.schemes[0]);
  assert.deepEqual(flat[0], {
    acquisition: "static",
    attachment: { kind: "header", name: "Authorization", prefix: "Bearer " },
    config: {},
    label: "Bearer",
  });
  assert.deepEqual(flat[1], {
    acquisition: "basic",
    attachment: { kind: "header", name: "Authorization", prefix: "Basic " },
    config: {},
    label: "Basic",
  });
  assert.deepEqual(flat[2], {
    acquisition: "static",
    attachment: { kind: "header", name: "X-API-Key", prefix: "" },
    config: {},
    label: "ApiHeader",
  });
  // A clientCredentials-only oauth2 flow maps to the m2m acquisition + bearer.
  assert.equal(flat[3].acquisition, "oauth_client_credentials");
  assert.deepEqual(flat[3].attachment, { kind: "header", name: "Authorization", prefix: "Bearer " });
  assert.equal(flat[3].config.tokenUrl, "https://x/token");
  assert.equal(flat[3].config.scopes, "read");
});

test("flags security schemes it cannot map", () => {
  const spec = {
    components: { securitySchemes: { Cookie: { type: "apiKey", in: "cookie", name: "sid" } } },
    security: [{ Cookie: [] }],
  };
  const info = parseOpenApiAuth(spec);
  assert.deepEqual(info.alternatives, []);
  assert.deepEqual(info.unsupported, ["Cookie"]);
});
