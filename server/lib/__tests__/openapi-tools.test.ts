import test from "node:test";
import assert from "node:assert/strict";
import { parseTools, findTool, buildCallRequest } from "../openapi-tools.js";

const SPEC = {
  paths: {
    "/cards/{id}": {
      get: {
        operationId: "getCard",
        summary: "Get a card",
        parameters: [
          { name: "id", in: "path", required: true },
          { name: "fields", in: "query", required: false },
        ],
      },
    },
    "/cards": {
      post: { operationId: "createCard", summary: "Create a card", requestBody: { content: {} } },
    },
  },
};

test("parseTools turns operations into tools with params and body flags", () => {
  const tools = parseTools(SPEC);
  assert.equal(tools.length, 2);
  const get = findTool(tools, "getCard")!;
  assert.equal(get.method, "GET");
  assert.equal(get.path, "/cards/{id}");
  assert.equal(get.hasBody, false);
  assert.deepEqual(
    get.parameters.map((p) => `${p.name}:${p.in}:${p.required}`),
    ["id:path:true", "fields:query:false"]
  );
  assert.equal(findTool(tools, "createCard")!.hasBody, true);
});

test("buildCallRequest substitutes path params and collects query", () => {
  const tools = parseTools(SPEC);
  const req = buildCallRequest(findTool(tools, "getCard")!, { id: "abc", fields: "name" });
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/cards/abc");
  assert.deepEqual(req.query, { fields: "name" });
});

test("buildCallRequest reports missing required params", () => {
  const tools = parseTools(SPEC);
  assert.throws(() => buildCallRequest(findTool(tools, "getCard")!, {}), /Missing required argument/);
});

test("buildCallRequest passes args.body for operations with a request body", () => {
  const tools = parseTools(SPEC);
  const req = buildCallRequest(findTool(tools, "createCard")!, { body: { name: "x" } });
  assert.deepEqual(req.body, { name: "x" });
});
