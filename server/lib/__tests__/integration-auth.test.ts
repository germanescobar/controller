import test from "node:test";
import assert from "node:assert/strict";
import { resolveAuth } from "../integration-auth.js";
import type { AuthScheme, Attachment } from "../integrations.js";

const BEARER: Attachment = { kind: "header", name: "Authorization", prefix: "Bearer " };

function scheme(partial: Partial<AuthScheme> & Pick<AuthScheme, "id" | "acquisition">): AuthScheme {
  return { config: {}, hasSecret: false, ...partial };
}

test("an empty scheme set resolves to no attachment", () => {
  assert.deepEqual(resolveAuth([], {}), {
    status: "ready",
    resolved: { headers: {}, query: {}, env: {} },
  });
});

test("a static value attaches via its header with a prefix (bearer)", () => {
  const result = resolveAuth([scheme({ id: "a", acquisition: "static", attachment: BEARER })], {
    a: "abc",
  });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.status === "ready" ? result.resolved.headers : null, {
    Authorization: "Bearer abc",
  });
});

test("two static query attachments both land in the query string (Trello)", () => {
  const result = resolveAuth(
    [
      scheme({ id: "k", acquisition: "static", attachment: { kind: "query", name: "key" } }),
      scheme({ id: "t", acquisition: "static", attachment: { kind: "query", name: "token" } }),
    ],
    { k: "APIKEY", t: "USERTOKEN" }
  );
  assert.equal(result.status, "ready");
  assert.deepEqual(result.status === "ready" ? result.resolved.query : null, {
    key: "APIKEY",
    token: "USERTOKEN",
  });
});

test("schemes across channels merge (bearer header + apiKey header)", () => {
  const result = resolveAuth(
    [
      scheme({ id: "b", acquisition: "static", attachment: BEARER }),
      scheme({ id: "h", acquisition: "static", attachment: { kind: "header", name: "X-Org", prefix: "" } }),
    ],
    { b: "tok", h: "org123" }
  );
  assert.equal(result.status, "ready");
  assert.deepEqual(result.status === "ready" ? result.resolved.headers : null, {
    Authorization: "Bearer tok",
    "X-Org": "org123",
  });
});

test("basic acquisition encodes username:password then attaches", () => {
  const result = resolveAuth(
    [
      scheme({
        id: "x",
        acquisition: "basic",
        attachment: { kind: "header", name: "Authorization", prefix: "Basic " },
        config: { username: "u" },
      }),
    ],
    { x: "p" }
  );
  const expected = `Basic ${Buffer.from("u:p").toString("base64")}`;
  assert.equal(result.status === "ready" ? result.resolved.headers.Authorization : null, expected);
});

test("a missing secret fails the whole connection with a re-auth signal", () => {
  const result = resolveAuth(
    [
      scheme({ id: "a", acquisition: "static", attachment: BEARER }),
      scheme({ id: "b", acquisition: "static", attachment: { kind: "query", name: "key" } }),
    ],
    { a: "tok" } // b has no secret
  );
  assert.equal(result.status, "reauth_needed");
  assert.equal(result.status === "reauth_needed" ? result.reason : null, "acquire");
});

test("oauth acquisitions signal acquire; signing/cloud are unsupported", () => {
  for (const acquisition of ["oauth", "oauth_client_credentials", "oauth_dynamic"] as const) {
    const r = resolveAuth([scheme({ id: "a", acquisition, attachment: BEARER })], {});
    assert.equal(r.status === "reauth_needed" ? r.reason : null, "acquire");
  }
  for (const acquisition of ["cloud", "hmac", "mtls"] as const) {
    const r = resolveAuth([scheme({ id: "a", acquisition })], {});
    assert.equal(r.status === "reauth_needed" ? r.reason : null, "unsupported");
  }
});
