/**
 * Unit tests for src/transport-factory.ts: pure stdio `cwd` resolution (Pi 1.3.0
 * `McpStdioServerConfig.cwd`: relative paths resolve against the session working directory,
 * a leading `~` expands to the home directory), and static-header handling for OAuth servers
 * (a configured `Authorization` header must never reach an OAuth transport).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTransport, resolveStdioCwd } from "../src/transport-factory.js";
import { ServerConfigSchema } from "../src/config.js";
import { stripAuthorizationHeader } from "../src/auth-challenge.js";

describe("resolveStdioCwd", () => {
  it("keeps the session cwd when the server config has no cwd", () => {
    assert.equal(resolveStdioCwd(undefined, "/work/session"), "/work/session");
    assert.equal(resolveStdioCwd(undefined, undefined), undefined);
  });

  it("resolves a relative cwd against the session cwd", () => {
    assert.equal(resolveStdioCwd("./sub", "/work/session"), resolve("/work/session", "./sub"));
    assert.equal(resolveStdioCwd("../shared", "/work/session"), resolve("/work/session", "../shared"));
  });

  it("keeps an absolute cwd as given", () => {
    assert.equal(resolveStdioCwd("/opt/server", "/work/session"), resolve("/opt/server"));
  });

  it("expands a leading ~ to the home directory", () => {
    assert.equal(resolveStdioCwd("~", "/work/session"), homedir());
    assert.equal(resolveStdioCwd("~/mcp/state", "/work/session"), join(homedir(), "mcp/state"));
  });

  it("falls back to the process cwd when the session cwd is unknown", () => {
    assert.equal(resolveStdioCwd("./sub", undefined), resolve(process.cwd(), "./sub"));
  });
});

describe("stripAuthorizationHeader", () => {
  it("removes Authorization in any casing and keeps the other headers", () => {
    assert.deepEqual(
      stripAuthorizationHeader({ Authorization: "Bearer stale", "X-Tenant": "acme" }),
      { "X-Tenant": "acme" },
    );
    assert.deepEqual(stripAuthorizationHeader({ authorization: "Bearer stale" }), undefined);
    assert.deepEqual(stripAuthorizationHeader({ AuThOrIzAtIoN: "Bearer stale" }), undefined);
  });

  it("returns undefined for a missing or empty header set", () => {
    assert.equal(stripAuthorizationHeader(undefined), undefined);
    assert.equal(stripAuthorizationHeader({}), undefined);
  });
});

interface HeaderInspectingTransport {
  _commonHeaders: () => Promise<Headers>;
  _authProvider: { saveTokens: (tokens: { access_token: string; token_type: string }) => Promise<void> };
}

const OAUTH_ACCESS_TOKEN = "oauth-token-from-provider";
const OAUTH_BEARER = `Bearer ${OAUTH_ACCESS_TOKEN}`;
const STATIC_BEARER = "Bearer stale-static-header";

/**
 * Build a real SDK transport through `createTransport`, seed it with an OAuth access token, and
 * return the headers the SDK would actually send (`_commonHeaders()` is what every SDK HTTP
 * request path uses). `_commonHeaders()` is private API, so the cast is confined to this helper.
 */
async function sentHeaders(
  transport: "streamable-http" | "sse",
  headers: Record<string, string>,
  oauth: boolean,
): Promise<Headers> {
  const storageDir = await mkdtemp(join(tmpdir(), "pi-mcp-transport-headers-"));
  try {
    const config = ServerConfigSchema.parse({
      transport,
      url: "http://127.0.0.1:9999/mcp",
      headers,
      ...(oauth ? { auth: { type: "oauth" } } : {}),
    });
    const created = createTransport("srv", config, undefined, storageDir) as unknown as HeaderInspectingTransport;
    if (oauth) {
      await created._authProvider.saveTokens({ access_token: OAUTH_ACCESS_TOKEN, token_type: "Bearer" });
    }
    return await created._commonHeaders();
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
}

describe("createTransport with OAuth configured", () => {
  for (const transport of ["streamable-http", "sse"] as const) {
    it(`${transport}: a static Authorization header never replaces the OAuth bearer`, async () => {
      const sent = await sentHeaders(transport, { Authorization: STATIC_BEARER }, true);
      // The SDK spreads requestInit headers over the OAuth bearer, so an exact-case
      // Authorization key used to win outright and the access token was never sent.
      assert.equal(sent.get("authorization"), OAUTH_BEARER);
    });

    it(`${transport}: a static authorization header is not comma-joined with the OAuth bearer`, async () => {
      const sent = await sentHeaders(transport, { authorization: STATIC_BEARER }, true);
      // A lowercase key survived the spread as a second entry and `new Headers()` joined both
      // values into one malformed header.
      assert.equal(sent.get("authorization"), OAUTH_BEARER);
    });

    it(`${transport}: other static headers are still sent`, async () => {
      const sent = await sentHeaders(transport, { Authorization: STATIC_BEARER, "X-Tenant": "acme" }, true);
      assert.equal(sent.get("authorization"), OAUTH_BEARER);
      assert.equal(sent.get("x-tenant"), "acme");
    });

    it(`${transport}: a static Authorization header is untouched for header-auth servers`, async () => {
      const sent = await sentHeaders(transport, { Authorization: STATIC_BEARER }, false);
      assert.equal(sent.get("authorization"), STATIC_BEARER);
    });
  }
});
