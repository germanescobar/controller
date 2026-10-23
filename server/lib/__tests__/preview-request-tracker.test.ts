import assert from "node:assert/strict";
import test from "node:test";
import { completedPreviewRequest } from "../../../electron/preview-request-tracker.js";

test("main-frame HTTP errors produce both open status and diagnostics", () => {
  assert.deepEqual(completedPreviewRequest({
    resourceType: "mainFrame",
    statusCode: 404,
    url: "http://localhost:5173/missing",
    webContentsId: 7,
  }), {
    guestId: 7,
    response: { url: "http://localhost:5173/missing", statusCode: 404 },
    failure: "HTTP 404",
  });
});

test("subresource errors only produce diagnostics", () => {
  assert.deepEqual(completedPreviewRequest({
    resourceType: "script",
    statusCode: 500,
    url: "http://localhost:5173/broken.js",
    webContents: { id: 7 },
  }), { guestId: 7, response: null, failure: "HTTP 500" });
});

test("successful main-frame responses remain available for open", () => {
  assert.deepEqual(completedPreviewRequest({
    resourceType: "mainFrame",
    statusCode: 200,
    url: "http://localhost:5173/",
    webContentsId: 7,
  }), {
    guestId: 7,
    response: { url: "http://localhost:5173/", statusCode: 200 },
    failure: null,
  });
  assert.equal(completedPreviewRequest({
    resourceType: "mainFrame",
    statusCode: 404,
    url: "http://localhost:5173/",
  }), null);
});
