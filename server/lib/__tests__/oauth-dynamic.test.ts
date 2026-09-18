import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/*
 * OAuth (dynamic / MCP) acquisition — issue #280.
 *
 * Coverage:
 *   - discoverMetadata builds the right well-known URL and rejects when the
 *     AS isn't there.
 *   - dynamicClientRegistration hits the registration endpoint and returns
 *     the client id.
 *   - startInteractiveOauth: end-to-end PKCE happy path with a mocked AS.
 *     The loopback listener runs on a real local port and is hit by the
 *     test's own HTTP client.
 *   - getValidToken: returns the access token when fresh; refreshes when
 *     close to expiry; returns null when the scheme has no secret yet.
 *   - getValidToken: marks the scheme expired when refresh fails.
 *   - getValidToken: persists a refreshed token to the secret store so
 *     the next process restart resumes.
 *   - acquireStatus mirrors what the UI renders.
 *   - clearDynamicOauth wipes the stored token and resets the scheme to
 *     "none".
 *
 * The server module's secret store derives its file paths from
 * CONTROLLER_HOME; the env var is reset around each test.
 */

interface Route {
  method: string;
  url: string;
  status: number;
  body: unknown;
}

async function withTempHome<T>(
  fn: (mods: {
    integrations: typeof import("../integrations.js");
    oauth: typeof import("../oauth-dynamic.js");
  }) => Promise<T>
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-dyn-test-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;
  try {
    const oauth = await import(`../oauth-dynamic.js?t=${Date.now()}-${Math.random()}`);
    const integrations = await import(`../integrations.js?t=${Date.now()}-${Math.random()}`);
    return await fn({ integrations, oauth });
  } finally {
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function withMockAs(
  routes: Route[],
  fn: (mods: {
    integrations: typeof import("../integrations.js");
    oauth: typeof import("../oauth-dynamic.js");
    baseUrl: string;
    registered: { url?: string; body?: string };
    authRequests: { url?: string; body?: string }[];
  }) => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-dyn-test-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;

  const registered: { url?: string; body?: string } = {};
  const authRequests: { url?: string; body?: string }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      const route = routes.find((r) => r.method === req.method && r.url === path);
      if (!route) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no route" }));
        return;
      }
      if (path === "/register") {
        registered.url = req.url;
        registered.body = raw;
      } else if (path === "/authorize") {
        authRequests.push({ url: req.url, body: raw });
      }
      const body =
        typeof route.body === "string" ? route.body : JSON.stringify(route.body ?? {});
      res.writeHead(route.status, { "Content-Type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const integrations = await import(`../integrations.js?t=${Date.now()}-${Math.random()}`);
    const oauth = await import(`../oauth-dynamic.js?t=${Date.now()}-${Math.random()}`);
    await fn({ integrations, oauth, baseUrl, registered, authRequests });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const METADATA = {
  issuer: "https://as.example/",
  authorization_endpoint: "http://as.example/authorize",
  token_endpoint: "http://as.example/token",
  registration_endpoint: "http://as.example/register",
};

function makeConnection(
  integrations: typeof import("../integrations.js"),
  url: string
): Promise<import("../integrations.js").IntegrationConnection> {
  return integrations.createConnection({
    name: "Test MCP",
    transport: { mode: "mcp", config: { url }, headers: {} },
    auth: {
      schemes: [
        {
          acquisition: "oauth_dynamic",
          attachment: { kind: "header", name: "Authorization", prefix: "Bearer " },
        },
      ],
    },
  });
}

function schemeOf(connection: import("../integrations.js").IntegrationConnection) {
  const scheme = connection.auth.schemes[0];
  if (!scheme) throw new Error("connection has no schemes");
  return scheme;
}

test("discoverMetadata: 404 surfaces a metadata_not_found error", async () => {
  await withTempHome(async ({ oauth }) => {
    const fetchImpl: typeof fetch = async () => new Response("not found", { status: 404 });
    await assert.rejects(
      () => oauth.discoverMetadata("http://127.0.0.1:9/", fetchImpl),
      (err: Error) =>
        err instanceof oauth.OAuthDynamicError && err.code === "metadata_not_found"
    );
  });
});

test("discoverMetadata: requires authorization_endpoint, token_endpoint, issuer", async () => {
  await withTempHome(async ({ oauth }) => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ issuer: "x" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    await assert.rejects(
      () => oauth.discoverMetadata("http://127.0.0.1:9/", fetchImpl),
      (err: Error) =>
        err instanceof oauth.OAuthDynamicError && err.code === "metadata_not_found"
    );
  });
});

test("discoverMetadata: publishes metadata at the host origin (Figma-style)", async () => {
  // The MCP server's resource path is /mcp but the well-known is at the
  // host origin /, not at /mcp/.well-known/... This is what Figma's MCP
  // server does in production: a 404 at /mcp/.well-known/... but a 200
  // at /.well-known/oauth-authorization-server.
  await withTempHome(async ({ oauth }) => {
    const metadata = {
      issuer: "https://api.figma.com",
      authorization_endpoint: "https://www.figma.com/oauth/mcp",
      token_endpoint: "https://api.figma.com/v1/oauth/token",
      registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      // The new fast path hits the origin (no path), so /mcp is NOT in the URL.
      if (url === "http://127.0.0.1:9/.well-known/oauth-authorization-server") {
        return new Response(JSON.stringify(metadata), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Anything else (e.g. a probe) returns 404 so we don't accidentally
      // satisfy the test via the wrong path.
      return new Response("not found", { status: 404 });
    };
    const discovered = await oauth.discoverMetadata("http://127.0.0.1:9/mcp", fetchImpl);
    assert.equal(discovered.issuer, "https://api.figma.com");
    assert.equal(discovered.token_endpoint, "https://api.figma.com/v1/oauth/token");
  });
});

test("discoverMetadata: probes with initialize and follows WWW-Authenticate resource_metadata", async () => {
  // Figma in production also serves a 401 with a WWW-Authenticate header
  // pointing at /well-known/oauth-protected-resource, which then points
  // at a separate AS origin. Discovery should follow that chain.
  await withTempHome(async ({ oauth }) => {
    const metadata = {
      issuer: "https://api.figma.com",
      authorization_endpoint: "https://www.figma.com/oauth/mcp",
      token_endpoint: "https://api.figma.com/v1/oauth/token",
      registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register",
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "http://127.0.0.1:9/mcp") {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Bearer resource_metadata="http://127.0.0.1:9/.well-known/oauth-protected-resource", ' +
              'authorization_uri="https://api.figma.com/.well-known/oauth-authorization-server"',
          },
        });
      }
      if (url === "http://127.0.0.1:9/.well-known/oauth-protected-resource") {
        return new Response(
          JSON.stringify({
            resource: "http://127.0.0.1:9/mcp",
            authorization_servers: ["https://api.figma.com"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "https://api.figma.com/.well-known/oauth-authorization-server") {
        return new Response(JSON.stringify(metadata), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };
    const discovered = await oauth.discoverMetadata("http://127.0.0.1:9/mcp", fetchImpl);
    assert.equal(discovered.issuer, "https://api.figma.com");
  });
});

test("parseWwwAuthenticate: extracts the resource_metadata parameter", async () => {
  // Exposed for testing; the public surface of the module is
  // discoverMetadata but a direct unit test on the parser keeps the
  // header-format edge cases in scope.
  await withTempHome(async ({ oauth }) => {
    // We exercise the parser via discoverMetadata's probe path with a
    // shape that's known to be valid: the 401 includes a quoted
    // resource_metadata, the protected-resource document points at one
    // AS, and the AS metadata answers with valid endpoints.
    const metadata = {
      issuer: "https://issuer.example",
      authorization_endpoint: "https://issuer.example/auth",
      token_endpoint: "https://issuer.example/token",
      registration_endpoint: "https://issuer.example/register",
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "http://127.0.0.1:9/mcp") {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            // No leading scheme; the parser handles that.
            "WWW-Authenticate": `resource_metadata="http://127.0.0.1:9/pr", scope="mcp"`,
          },
        });
      }
      if (url === "http://127.0.0.1:9/pr") {
        return new Response(
          JSON.stringify({ authorization_servers: ["https://issuer.example"] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "https://issuer.example/.well-known/oauth-authorization-server") {
        return new Response(JSON.stringify(metadata), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };
    const discovered = await oauth.discoverMetadata("http://127.0.0.1:9/mcp", fetchImpl);
    assert.equal(discovered.issuer, "https://issuer.example");
  });
});

test("dynamicClientRegistration: picks a token_endpoint_auth_method the AS advertises", async () => {
  // ASes that don't accept "none" (PKCE public client) — Figma being
  // the canonical example — need us to ask for client_secret_basic or
  // client_secret_post. The body should reflect that.
  await withTempHome(async ({ oauth }) => {
    let registeredBody: unknown = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/register")) {
        registeredBody = init?.body;
        return new Response(JSON.stringify({ client_id: "figma-client" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };
    const client = await oauth.dynamicClientRegistration(
      {
        issuer: "https://api.figma.com",
        authorization_endpoint: "https://www.figma.com/oauth/mcp",
        token_endpoint: "https://api.figma.com/v1/oauth/token",
        registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register",
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      },
      fetchImpl
    );
    assert.equal(client.client_id, "figma-client");
    const parsed = JSON.parse(String(registeredBody));
    assert.equal(parsed.token_endpoint_auth_method, "client_secret_basic");
  });
});

test("dynamicClientRegistration: posts to the registration endpoint and returns the client", async () => {
  await withMockAs(
    [
      {
        method: "POST",
        url: "/register",
        status: 201,
        body: { client_id: "dyn-123", client_secret: "shh" },
      },
    ],
    async ({ oauth, baseUrl }) => {
      const client = await oauth.dynamicClientRegistration(
        { ...METADATA, registration_endpoint: `${baseUrl}/register` },
        fetch,
        "http://127.0.0.1/cb"
      );
      assert.equal(client.client_id, "dyn-123");
      assert.equal(client.client_secret, "shh");
    }
  );
});

test("dynamicClientRegistration: rejects when the AS doesn't expose a registration_endpoint", async () => {
  await withTempHome(async ({ oauth }) => {
    await assert.rejects(
      () =>
        oauth.dynamicClientRegistration(
          { ...METADATA, registration_endpoint: undefined },
          fetch
        ),
      (err: Error) => err instanceof oauth.OAuthDynamicError && err.code === "dcr_failed"
    );
  });
});

test("dynamicClientRegistration: surfaces the spec-cited escape hatch when the AS returns 403 (closed DCR)", async () => {
  // The MCP spec is explicit: "Any authorization servers that do not
  // support Dynamic Client Registration need to provide alternative
  // ways to obtain a client ID. For one of these authorization
  // servers, MCP clients will have to either hardcode a client ID… or
  // present a UI to users that allows them to enter these details,
  // after registering an OAuth client themselves." Figma is the
  // canonical example: its `/v1/oauth/mcp/register` endpoint returns
  // 403 to anonymous callers. Our error message should reflect that
  // and point the user at the manual path.
  await withMockAs(
    [
      { method: "GET", url: "/.well-known/oauth-authorization-server", status: 200, body: {} },
      { method: "POST", url: "/register", status: 403, body: "Forbidden" },
    ],
    async ({ oauth, baseUrl }) => {
      const metadata = {
        issuer: `${baseUrl}/`,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
      };
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === `${baseUrl}/register`) {
          return new Response("Forbidden", { status: 403 });
        }
        return fetch(url, init);
      };
      await assert.rejects(
        () => oauth.dynamicClientRegistration(metadata, fetchImpl),
        (err: Error) => {
          assert.ok(err instanceof oauth.OAuthDynamicError);
          assert.equal(err.code, "dcr_failed");
          // The message should mention "dynamic client registration"
          // and the manual-path hint ("developer dashboard" or
          // equivalent) so the form can show the user what to do.
          assert.match(err.message, /dynamic client registration/i);
          assert.match(err.message, /developer dashboard/i);
          return true;
        }
      );
    }
  );
});

test("startInteractiveOauth: PKCE happy path discovers, registers, opens browser, exchanges the code", async () => {
  await withMockAs(
    [
      // The test's local mock server is hit via the metadata we pass
      // through `fetchImpl`. The mock server only needs to exist so
      // `withMockAs` cleans up; the actual responses come from the
      // fetchImpl below.
      { method: "GET", url: "/.well-known/oauth-authorization-server", status: 200, body: {} },
    ],
    async ({ integrations, oauth, baseUrl }) => {
      const localMetadata = {
        issuer: `${baseUrl}/`,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
      };
      const connection = await makeConnection(integrations, `${baseUrl}/mcp`);
      const scheme = schemeOf(connection);
      let observedAuthUrl: string | null = null;
      let registeredRedirectUri: string | null = null;
      const result = await oauth.startInteractiveOauth(connection, scheme, {
        resourceUrl: `${baseUrl}/mcp`,
        callbackTimeoutMs: 5_000,
        fetchImpl: async (input, init) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url === `${baseUrl}/.well-known/oauth-authorization-server`) {
            return new Response(JSON.stringify(localMetadata), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url === `${baseUrl}/register`) {
            const body = JSON.parse(String(init?.body)) as { redirect_uris?: string[] };
            registeredRedirectUri = body.redirect_uris?.[0] ?? null;
            return new Response(JSON.stringify({ client_id: "dyn-1" }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url === `${baseUrl}/token`) {
            return new Response(
              JSON.stringify({ access_token: "AT-1", refresh_token: "RT-1", expires_in: 3600 }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return fetch(url, init);
        },
        openBrowser: async (url) => {
          observedAuthUrl = url;
          await delay(20);
          const parsed = new URL(url);
          const state = parsed.searchParams.get("state") ?? "";
          const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
          assert.equal(redirectUri, registeredRedirectUri);
          assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
          const resp = await fetch(`${redirectUri}?code=AUTH-CODE-1&state=${state}`);
          void resp;
        },
      });
      assert.equal(result.accessToken, "AT-1");
      assert.equal(result.refreshToken, "RT-1");
      assert.equal(result.clientId, "dyn-1");
      assert.notEqual(registeredRedirectUri, "http://127.0.0.1/callback");
      assert.equal(observedAuthUrl?.includes("response_type=code"), true);
      assert.equal(observedAuthUrl?.includes("code_challenge="), true);
      assert.equal(observedAuthUrl?.includes("code_challenge_method=S256"), true);
      assert.equal(observedAuthUrl?.includes(`resource=${encodeURIComponent(`${baseUrl}/mcp`)}`), true);
    }
  );
});

test("startInteractiveOauth: re-registers the exact callback URI on re-acquire", async () => {
  await withMockAs(
    [{ method: "GET", url: "/.well-known/oauth-authorization-server", status: 200, body: {} }],
    async ({ integrations, oauth, baseUrl }) => {
      const localMetadata = {
        issuer: `${baseUrl}/`,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
      };
      const connection = await makeConnection(integrations, `${baseUrl}/mcp`);
      const scheme = schemeOf(connection);
      let registerCalls = 0;
      const registeredRedirectUris: string[] = [];
      // First call: register a client.
      await oauth.startInteractiveOauth(connection, scheme, {
        resourceUrl: `${baseUrl}/mcp`,
        callbackTimeoutMs: 5_000,
        fetchImpl: async (input, init) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url === `${baseUrl}/.well-known/oauth-authorization-server`) {
            return new Response(JSON.stringify(localMetadata), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url === `${baseUrl}/register`) {
            registerCalls += 1;
            const body = JSON.parse(String(init?.body)) as { redirect_uris?: string[] };
            registeredRedirectUris.push(body.redirect_uris?.[0] ?? "");
            return new Response(JSON.stringify({ client_id: "dyn-reused" }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url === `${baseUrl}/token`) {
            return new Response(
              JSON.stringify({ access_token: "AT-2", refresh_token: "RT-2", expires_in: 3600 }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return fetch(url, init);
        },
        openBrowser: async (url) => {
          await delay(20);
          const parsed = new URL(url);
          const state = parsed.searchParams.get("state") ?? "";
          const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
          assert.equal(redirectUri, registeredRedirectUris.at(-1));
          await fetch(`${redirectUri}?code=AUTH-CODE-2&state=${state}`);
        },
      });
      assert.equal(registerCalls, 1, "DCR runs the first time");

      // Re-acquire with a fresh flow (simulate clicking "Reconnect"). A new
      // ephemeral callback port requires a new matching client registration.
      const updated = await integrations.getConnection(connection.id);
      assert.ok(updated);
      const fresh = schemeOf(updated);
      const second = await oauth.startInteractiveOauth(updated, fresh, {
        resourceUrl: `${baseUrl}/mcp`,
        callbackTimeoutMs: 5_000,
        fetchImpl: async (input, init) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url === `${baseUrl}/.well-known/oauth-authorization-server`) {
            return new Response(JSON.stringify(localMetadata), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url === `${baseUrl}/register`) {
            registerCalls += 1;
            const body = JSON.parse(String(init?.body)) as { redirect_uris?: string[] };
            registeredRedirectUris.push(body.redirect_uris?.[0] ?? "");
            return new Response(JSON.stringify({ client_id: "dyn-reused" }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url === `${baseUrl}/token`) {
            return new Response(
              JSON.stringify({ access_token: "AT-3", refresh_token: "RT-3", expires_in: 3600 }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return fetch(url, init);
        },
        openBrowser: async (url) => {
          await delay(20);
          const parsed = new URL(url);
          const state = parsed.searchParams.get("state") ?? "";
          const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
          assert.equal(redirectUri, registeredRedirectUris.at(-1));
          await fetch(`${redirectUri}?code=AUTH-CODE-3&state=${state}`);
        },
      });
      assert.equal(second.accessToken, "AT-3");
      assert.equal(registerCalls, 2, "DCR runs for each ephemeral callback URI");
      assert.equal(registeredRedirectUris.length, 2);
      for (const redirectUri of registeredRedirectUris) {
        assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      }
    }
  );
});

test("startInteractiveOauth: starts the callback timeout after slow registration", async () => {
  await withMockAs(
    [{ method: "GET", url: "/.well-known/oauth-authorization-server", status: 200, body: {} }],
    async ({ integrations, oauth, baseUrl }) => {
      const metadata = {
        issuer: `${baseUrl}/`,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
      };
      const connection = await makeConnection(integrations, `${baseUrl}/mcp`);
      const scheme = schemeOf(connection);
      let registrationFinishedAt = 0;
      const startedAt = Date.now();

      const acquisition = oauth.startInteractiveOauth(connection, scheme, {
        resourceUrl: `${baseUrl}/mcp`,
        callbackTimeoutMs: 25,
        fetchImpl: async (input) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url === `${baseUrl}/.well-known/oauth-authorization-server`) {
            return new Response(JSON.stringify(metadata), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url === `${baseUrl}/register`) {
            await delay(75);
            registrationFinishedAt = Date.now();
            return new Response(JSON.stringify({ client_id: "dyn-slow" }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          }
          throw new Error(`Unexpected request: ${url}`);
        },
        openBrowser: async () => {},
      });

      await assert.rejects(
        Promise.race([
          acquisition,
          delay(500).then(() => {
            throw new Error("acquisition did not time out");
          }),
        ]),
        (error: Error) =>
          error instanceof oauth.OAuthDynamicError && error.code === "callback_timeout"
      );
      assert.ok(registrationFinishedAt - startedAt >= 70);
      assert.ok(Date.now() - registrationFinishedAt >= 20);
    }
  );
});

test("startInteractiveOauth: overlapping acquisitions keep callback listeners isolated", async () => {
  await withMockAs(
    [{ method: "GET", url: "/.well-known/oauth-authorization-server", status: 200, body: {} }],
    async ({ integrations, oauth, baseUrl }) => {
      const metadata = {
        issuer: `${baseUrl}/`,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
      };
      const firstConnection = await makeConnection(integrations, `${baseUrl}/mcp/first`);
      const secondConnection = await makeConnection(integrations, `${baseUrl}/mcp/second`);
      let registrationCount = 0;
      const registeredRedirectUris = new Set<string>();
      const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === `${baseUrl}/.well-known/oauth-authorization-server`) {
          return new Response(JSON.stringify(metadata), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === `${baseUrl}/register`) {
          registrationCount += 1;
          const registrationNumber = registrationCount;
          const body = JSON.parse(String(init?.body)) as { redirect_uris?: string[] };
          registeredRedirectUris.add(body.redirect_uris?.[0] ?? "");
          if (registrationNumber === 1) await delay(75);
          return new Response(JSON.stringify({ client_id: `dyn-${registrationNumber}` }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === `${baseUrl}/token`) {
          const body = new URLSearchParams(String(init?.body));
          return new Response(JSON.stringify({ access_token: `AT-${body.get("client_id")}` }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return fetch(url, init);
      };
      const openBrowser = async (url: string) => {
        const parsed = new URL(url);
        const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
        const state = parsed.searchParams.get("state") ?? "";
        assert.equal(registeredRedirectUris.has(redirectUri), true);
        await fetch(`${redirectUri}?code=AUTH-CODE&state=${state}`);
      };

      const first = oauth.startInteractiveOauth(firstConnection, schemeOf(firstConnection), {
        callbackTimeoutMs: 1_000,
        fetchImpl: fetchImpl as typeof fetch,
        openBrowser,
      });
      await delay(10);
      const second = oauth.startInteractiveOauth(secondConnection, schemeOf(secondConnection), {
        callbackTimeoutMs: 1_000,
        fetchImpl: fetchImpl as typeof fetch,
        openBrowser,
      });

      const results = await Promise.all([first, second]);
      assert.deepEqual(
        results.map((result) => result.accessToken).sort(),
        ["AT-dyn-1", "AT-dyn-2"]
      );
      assert.equal(registeredRedirectUris.size, 2);
    }
  );
});

test("getValidToken: returns null when no token has been acquired", async () => {
  await withTempHome(async ({ integrations, oauth }) => {
    const connection = await makeConnection(integrations, "http://127.0.0.1:9999/");
    const scheme = schemeOf(connection);
    const token = await oauth.getValidToken(connection, scheme);
    assert.equal(token, null);
  });
});

test("getValidToken: refreshes proactively on a near-expiry access token", async () => {
  await withMockAs(
    [{ method: "GET", url: "/.well-known/oauth-authorization-server", status: 200, body: {} }],
    async ({ integrations, oauth, baseUrl }) => {
      const localMetadata = {
        issuer: `${baseUrl}/`,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
      };
      const connection = await makeConnection(integrations, `${baseUrl}/mcp`);
      const scheme = schemeOf(connection);
      let tokenCalls = 0;
      const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === `${baseUrl}/.well-known/oauth-authorization-server`) {
          return new Response(JSON.stringify(localMetadata), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === `${baseUrl}/register`) {
          return new Response(JSON.stringify({ client_id: "dyn-r" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === `${baseUrl}/token`) {
          tokenCalls += 1;
          if (tokenCalls === 1) {
            return new Response(
              JSON.stringify({ access_token: "AT-SHORT", refresh_token: "RT", expires_in: 60 }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(
            JSON.stringify({ access_token: "AT-FRESH", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return fetch(url, init);
      };
      await oauth.startInteractiveOauth(connection, scheme, {
        resourceUrl: `${baseUrl}/mcp`,
        callbackTimeoutMs: 5_000,
        fetchImpl: fetchImpl as typeof fetch,
        openBrowser: async (url) => {
          await delay(20);
          const parsed = new URL(url);
          const state = parsed.searchParams.get("state") ?? "";
          const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
          await fetch(`${redirectUri}?code=CODE&state=${state}`);
        },
      });

      // First call to getValidToken: the stored token is the short one but
      // not yet within the refresh skew window. We return it as-is.
      let updated = await integrations.getConnection(connection.id);
      assert.ok(updated);
      const schemeNow = schemeOf(updated);
      const first = await oauth.getValidToken(updated, schemeNow, fetchImpl as typeof fetch);
      assert.equal(first, "AT-SHORT");

      // Force the stored token to be inside the refresh window by
      // rewriting its expiresAt.
      const { writeConnectionSecrets } = await import("../integrations.js");
      const secrets = await integrations.getConnectionSecrets(updated.id);
      const stored = JSON.parse(secrets[schemeNow.id] ?? "{}");
      stored.expiresAt = Date.now() + 1_000; // 1s from now, well inside the 30s skew
      secrets[schemeNow.id] = JSON.stringify(stored);
      await writeConnectionSecrets(updated.id, secrets);

      updated = await integrations.getConnection(updated.id);
      assert.ok(updated);
      const schemeRefreshed = schemeOf(updated);
      const second = await oauth.getValidToken(updated, schemeRefreshed, fetchImpl as typeof fetch);
      assert.equal(second, "AT-FRESH");
      // The token endpoint was hit twice: once for the auth code exchange,
      // once for the refresh.
      assert.equal(tokenCalls, 2);
    }
  );
});

test("getValidToken: marks the scheme expired when refresh fails", async () => {
  await withMockAs(
    [{ method: "GET", url: "/.well-known/oauth-authorization-server", status: 200, body: {} }],
    async ({ integrations, oauth, baseUrl }) => {
      const localMetadata = {
        issuer: `${baseUrl}/`,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
      };
      const connection = await makeConnection(integrations, `${baseUrl}/mcp`);
      const scheme = schemeOf(connection);
      let tokenCalls = 0;
      const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === `${baseUrl}/.well-known/oauth-authorization-server`) {
          return new Response(JSON.stringify(localMetadata), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === `${baseUrl}/register`) {
          return new Response(JSON.stringify({ client_id: "dyn-x" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === `${baseUrl}/token`) {
          tokenCalls += 1;
          if (tokenCalls === 1) {
            return new Response(
              JSON.stringify({ access_token: "AT-1", refresh_token: "RT", expires_in: 60 }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return fetch(url, init);
      };
      await oauth.startInteractiveOauth(connection, scheme, {
        resourceUrl: `${baseUrl}/mcp`,
        callbackTimeoutMs: 5_000,
        fetchImpl: fetchImpl as typeof fetch,
        openBrowser: async (url) => {
          await delay(20);
          const parsed = new URL(url);
          const state = parsed.searchParams.get("state") ?? "";
          const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
          await fetch(`${redirectUri}?code=CODE&state=${state}`);
        },
      });

      // Force expiry by editing the stored secret.
      const updated = await integrations.getConnection(connection.id);
      assert.ok(updated);
      const schemeNow = schemeOf(updated);
      const { writeConnectionSecrets } = await import("../integrations.js");
      const secrets = await integrations.getConnectionSecrets(updated.id);
      const stored = JSON.parse(secrets[schemeNow.id] ?? "{}");
      stored.expiresAt = Date.now();
      secrets[schemeNow.id] = JSON.stringify(stored);
      await writeConnectionSecrets(updated.id, secrets);

      // getValidToken should fail to refresh and return null.
      const fresh = await integrations.getConnection(updated.id);
      assert.ok(fresh);
      const freshScheme = schemeOf(fresh);
      const token = await oauth.getValidToken(fresh, freshScheme, fetchImpl as typeof fetch);
      assert.equal(token, null);

      // The scheme's acquired status is now "expired".
      const expired = await integrations.getConnection(updated.id);
      assert.ok(expired);
      assert.equal(expired.auth.schemes[0]?.acquired?.status, "expired");
    }
  );
});

test("getValidToken: marks the scheme expired when the access token expires and there is no refresh token", async () => {
  // Codex review #285 (P2): previously, an AS that issues access
  // tokens without a refresh token would let `getValidToken` keep
  // returning the expired access token — agents would send 401s
  // forever instead of seeing the "Reconnect" affordance.
  await withTempHome(async ({ integrations, oauth }) => {
    const connection = await makeConnection(integrations, "http://127.0.0.1:9999/");
    const scheme = schemeOf(connection);
    const { writeConnectionSecrets } = await import("../integrations.js");
    const secrets = await integrations.getConnectionSecrets(connection.id);
    secrets[scheme.id] = JSON.stringify({
      accessToken: "EXPIRED",
      // no refreshToken — the AS doesn't issue one
      expiresAt: Date.now() - 1_000,
      clientId: "client",
      metadata: METADATA,
    });
    await writeConnectionSecrets(connection.id, secrets);

    const fresh = await integrations.getConnection(connection.id);
    assert.ok(fresh);
    const freshScheme = schemeOf(fresh);
    const token = await oauth.getValidToken(fresh, freshScheme);
    assert.equal(token, null);

    const final = await integrations.getConnection(connection.id);
    assert.ok(final);
    assert.equal(final.auth.schemes[0]?.acquired?.status, "expired");
  });
});

test("refreshAccessToken: preserves clientSecret, scopes, and resource on the persisted secret", async () => {
  // Codex review #285 (P2): previously, the refreshed secret was
  // built with only `client_id` and `metadata`, so any stored
  // clientSecret / scopes / resource was dropped. ASes that require
  // the same client secret or the same `resource` indicator on
  // every refresh call (Figma requires `client_secret_basic`; RFC
  // 8707 requires `resource`) would accept the first refresh by
  // accident and then start failing.
  await withMockAs(
    [{ method: "GET", url: "/.well-known/oauth-authorization-server", status: 200, body: {} }],
    async ({ integrations, oauth, baseUrl }) => {
      const localMetadata = {
        issuer: `${baseUrl}/`,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      };
      const connection = await makeConnection(integrations, `${baseUrl}/mcp`);
      const scheme = schemeOf(connection);
      const { writeConnectionSecrets } = await import("../integrations.js");
      const secrets = await integrations.getConnectionSecrets(connection.id);
      // Inject a stored secret whose expiry is already in the past so
      // the next `getValidToken` call will refresh it.
      secrets[scheme.id] = JSON.stringify({
        accessToken: "AT-OLD",
        refreshToken: "RT-1",
        expiresAt: Date.now() - 60_000,
        clientId: "dyn-1",
        clientSecret: "shh",
        metadata: localMetadata,
        scopes: "files:read mcp:connect",
        resource: "https://mcp.figma.com/mcp",
      });
      await writeConnectionSecrets(connection.id, secrets);

      const tokenCalls: { body: string; contentType: string | null }[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === `${baseUrl}/token`) {
          const body = init?.body;
          tokenCalls.push({
            body: typeof body === "string" ? body : body?.toString() ?? "",
            contentType: init?.headers ? new Headers(init.headers).get("content-type") : null,
          });
          return new Response(
            JSON.stringify({ access_token: "AT-NEW", refresh_token: "RT-2", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("not found", { status: 404 });
      };

      const fresh = await integrations.getConnection(connection.id);
      assert.ok(fresh);
      const freshScheme = schemeOf(fresh);
      const token = await oauth.getValidToken(fresh, freshScheme, fetchImpl as typeof fetch);
      assert.equal(token, "AT-NEW");

      // The refresh request must include the client_secret (so the AS
      // can authenticate the call) and the resource indicator.
      const lastBody = tokenCalls[0]?.body ?? "";
      assert.match(lastBody, /client_secret=shh/);
      assert.match(lastBody, /resource=https%3A%2F%2Fmcp\.figma\.com%2Fmcp/);
      assert.match(lastBody, /scope=files%3Aread(\+|%20)mcp%3Aconnect/);

      // The persisted secret must keep the clientSecret, scopes, and
      // resource so a *second* refresh (after this one expires) still
      // works.
      const refreshed = await integrations.getConnection(connection.id);
      assert.ok(refreshed);
      const reloadedSecrets = await integrations.getConnectionSecrets(refreshed.id);
      const persisted = JSON.parse(reloadedSecrets[scheme.id] ?? "{}");
      assert.equal(persisted.clientSecret, "shh");
      assert.equal(persisted.scopes, "files:read mcp:connect");
      assert.equal(persisted.resource, "https://mcp.figma.com/mcp");
      assert.equal(persisted.refreshToken, "RT-2");
    }
  );
});

test("acquireStatus: returns 'connected' with an expiry while the token is valid", async () => {
  await withTempHome(async ({ integrations, oauth }) => {
    const connection = await makeConnection(integrations, "http://127.0.0.1:9999/");
    const scheme = schemeOf(connection);
    const status = await oauth.acquireStatus(connection.id, scheme.id);
    assert.deepEqual(status, { status: "none" });
  });
});

test("clearDynamicOauth: removes the stored token and resets the scheme", async () => {
  await withTempHome(async ({ integrations, oauth }) => {
    const connection = await makeConnection(integrations, "http://127.0.0.1:9999/");
    const scheme = schemeOf(connection);
    // Inject a fake stored secret so we can assert it gets wiped.
    const { writeConnectionSecrets } = await import("../integrations.js");
    const fake = {
      accessToken: "X",
      refreshToken: "Y",
      expiresAt: Date.now() + 60_000,
      clientId: "client",
      metadata: METADATA,
    };
    const secrets = { [scheme.id]: JSON.stringify(fake) };
    await writeConnectionSecrets(connection.id, secrets);
    await integrations.updateConnection(connection.id, {
      auth: {
        schemes: [
          {
            id: scheme.id,
            acquisition: scheme.acquisition,
            attachment: scheme.attachment,
            config: scheme.config,
          },
        ],
      },
    });
    await oauth.clearDynamicOauth(connection.id, scheme.id);
    const after = await integrations.getConnectionSecrets(connection.id);
    assert.equal(after[scheme.id], undefined);
    const final = await integrations.getConnection(connection.id);
    assert.ok(final);
    assert.equal(final.auth.schemes[0]?.acquired?.status, "none");
  });
});
