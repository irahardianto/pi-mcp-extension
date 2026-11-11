import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpError } from "../src/errors.js";
import { statePath } from "../src/auth-lock.js";
import {
  applyStoredStateInvalidation,
  assertIssuerBindingCompatible,
  buildInteractiveStoredClientInfo,
  buildNewSilentStoredClientInfo,
  buildOAuthClientMetadata,
  buildStaticClientInformation,
  DEFAULT_CALLBACK_PORT,
  DEFAULT_REDIRECT_URL,
  hasRedirectUriMismatch,
  isClientSecretExpired,
  isPeerRotatedTokens,
  mergeSilentStoredClientInfo,
  numberOrUndefined,
  redirectUrisOrUndefined,
  resolveProviderRedirectUrl,
  stampStateServerUrl,
  stringOrUndefined,
  toOAuthClientInformation,
  toOAuthTokens,
  toStoredTokens,
  withoutStaticClientId,
} from "../src/oauth-policy.js";
import { AuthRequiredError, McpOAuthProvider } from "../src/oauth-provider.js";
import {
  loadStoredRedirectUrisSync,
  type StoredClientInfo,
  type StoredState,
  type StoredTokens,
} from "../src/oauth-state-store.js";

function baseStoredClient(overrides: Partial<StoredClientInfo> = {}): StoredClientInfo {
  return {
    client_id: "dcr-client",
    client_secret: undefined,
    client_id_issued_at: undefined,
    client_secret_expires_at: undefined,
    token_endpoint_auth_method: undefined,
    redirect_uris: undefined,
    issuer: undefined,
    ...overrides,
  };
}

function baseStoredTokens(overrides: Partial<StoredTokens> = {}): StoredTokens {
  return {
    access_token: "at-1",
    token_type: "Bearer",
    refresh_token: "rt-1",
    expires_in: 3600,
    scope: "read",
    saved_at: "2026-01-01T00:00:00.000Z",
    issuer: "https://auth.example.com",
    ...overrides,
  };
}

describe("oauth-policy pure helpers", () => {
  it("exports the default loopback callback constants", () => {
    assert.equal(DEFAULT_CALLBACK_PORT, 19876);
    assert.equal(DEFAULT_REDIRECT_URL, "http://127.0.0.1:19876/callback");
  });

  it("evaluates client_secret expiration deterministically with injectable nowMs", () => {
    const nowMs = 1_700_000_000_000;
    assert.equal(isClientSecretExpired(baseStoredClient(), nowMs), false);
    assert.equal(
      isClientSecretExpired(
        baseStoredClient({ client_secret: "sec", client_secret_expires_at: 0 }),
        nowMs,
      ),
      false,
    );
    assert.equal(
      isClientSecretExpired(
        baseStoredClient({ client_secret: "sec", client_secret_expires_at: 1_700_000_001 }),
        nowMs,
      ),
      false,
    );
    assert.equal(
      isClientSecretExpired(
        baseStoredClient({ client_secret: "sec", client_secret_expires_at: 1_700_000_000 }),
        nowMs,
      ),
      true,
    );
    assert.equal(
      isClientSecretExpired(baseStoredClient({ client_secret: "sec", client_secret_expires_at: 1 })),
      true,
    );
  });

  it("detects redirect_uri mismatches only when stored redirect_uris are non-empty", () => {
    assert.equal(hasRedirectUriMismatch(baseStoredClient(), DEFAULT_REDIRECT_URL), false);
    assert.equal(
      hasRedirectUriMismatch(baseStoredClient({ redirect_uris: [] }), DEFAULT_REDIRECT_URL),
      false,
    );
    assert.equal(
      hasRedirectUriMismatch(
        baseStoredClient({ redirect_uris: [DEFAULT_REDIRECT_URL] }),
        DEFAULT_REDIRECT_URL,
      ),
      false,
    );
    assert.equal(
      hasRedirectUriMismatch(
        baseStoredClient({ redirect_uris: ["http://127.0.0.1:19999/callback"] }),
        DEFAULT_REDIRECT_URL,
      ),
      true,
    );
  });

  it("converts StoredClientInfo into OAuthClientInformationMixed omitting undefined fields", () => {
    const minimal = toOAuthClientInformation(baseStoredClient());
    assert.deepEqual(minimal, { client_id: "dcr-client" });

    const full = toOAuthClientInformation(
      baseStoredClient({
        client_secret: "sec",
        client_id_issued_at: 100,
        client_secret_expires_at: 200,
        token_endpoint_auth_method: "client_secret_post",
        redirect_uris: [DEFAULT_REDIRECT_URL],
        issuer: "https://auth.example.com",
      }),
    );
    assert.deepEqual(full, {
      client_id: "dcr-client",
      client_secret: "sec",
      client_id_issued_at: 100,
      client_secret_expires_at: 200,
      token_endpoint_auth_method: "client_secret_post",
      redirect_uris: [DEFAULT_REDIRECT_URL],
      issuer: "https://auth.example.com",
    });
  });

  it("narrows primitive extras and strips DCR fields when a static clientId is configured", () => {
    assert.equal(withoutStaticClientId(true, "secret"), undefined);
    assert.equal(withoutStaticClientId(false, "secret"), "secret");
    assert.equal(numberOrUndefined(42), 42);
    assert.equal(numberOrUndefined("42"), undefined);
    assert.equal(stringOrUndefined("basic"), "basic");
    assert.equal(stringOrUndefined(123), undefined);
    assert.deepEqual(redirectUrisOrUndefined([new URL(DEFAULT_REDIRECT_URL)]), [
      DEFAULT_REDIRECT_URL,
    ]);
    assert.equal(redirectUrisOrUndefined("not-an-array"), undefined);

    const dcrInfo = buildInteractiveStoredClientInfo(
      {
        client_id: "dcr-id",
        client_secret: "dcr-secret",
        client_id_issued_at: 10,
        client_secret_expires_at: 20,
        token_endpoint_auth_method: "client_secret_basic",
        redirect_uris: [DEFAULT_REDIRECT_URL],
      },
      false,
      "https://issuer.example.com",
    );
    assert.equal(dcrInfo.client_secret, "dcr-secret");
    assert.deepEqual(dcrInfo.redirect_uris, [DEFAULT_REDIRECT_URL]);
    assert.equal(dcrInfo.issuer, "https://issuer.example.com");

    const staticInfo = buildInteractiveStoredClientInfo(
      {
        client_id: "static-id",
        client_secret: "config-secret-must-not-hit-disk",
        client_id_issued_at: 10,
        client_secret_expires_at: 20,
        token_endpoint_auth_method: "client_secret_basic",
        redirect_uris: [DEFAULT_REDIRECT_URL],
      },
      true,
      "https://issuer.example.com",
    );
    assert.equal(staticInfo.client_id, "static-id");
    assert.equal(staticInfo.client_secret, undefined);
    assert.equal(staticInfo.redirect_uris, undefined);
    assert.equal(staticInfo.issuer, "https://issuer.example.com");
  });

  it("resolves redirectUrl and clientMetadata across silent and interactive modes", () => {
    const storedUris = ["http://127.0.0.1:21000/callback", "http://127.0.0.1:21001/callback"];
    assert.equal(
      resolveProviderRedirectUrl("silent", undefined, {}, storedUris),
      "http://127.0.0.1:21000/callback",
    );
    assert.equal(
      resolveProviderRedirectUrl("interactive", "http://127.0.0.1:22000/callback", {}, storedUris),
      "http://127.0.0.1:22000/callback",
    );
    assert.equal(
      resolveProviderRedirectUrl("silent", undefined, {
        redirectUrl: "http://127.0.0.1:23000/callback",
      }),
      "http://127.0.0.1:23000/callback",
    );
    assert.equal(resolveProviderRedirectUrl("silent", undefined, {}), DEFAULT_REDIRECT_URL);

    const silentMeta = buildOAuthClientMetadata(
      "demo",
      { clientSecret: "sec", scope: "mcp:tools" },
      "silent",
      undefined,
      storedUris,
    );
    assert.deepEqual(silentMeta, {
      client_name: "pi-mcp/demo",
      redirect_uris: storedUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
      scope: "mcp:tools",
    });

    const interactiveMeta = buildOAuthClientMetadata(
      "demo",
      { clientName: "custom-app" },
      "interactive",
      "http://127.0.0.1:24000/callback",
      storedUris,
    );
    assert.deepEqual(interactiveMeta, {
      client_name: "custom-app",
      redirect_uris: ["http://127.0.0.1:24000/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  it("builds static clientInformation and enforces issuer binding compatibility", () => {
    const matched = buildStaticClientInformation(
      { clientId: "static-1", clientSecret: "sec-1" },
      baseStoredClient({ client_id: "static-1", issuer: "https://issuer.example.com" }),
    );
    assert.deepEqual(matched, {
      client_id: "static-1",
      client_secret: "sec-1",
      issuer: "https://issuer.example.com",
    });

    const mismatched = buildStaticClientInformation(
      { clientId: "static-1" },
      baseStoredClient({ client_id: "other-id", issuer: "https://issuer.example.com" }),
    );
    assert.deepEqual(mismatched, { client_id: "static-1" });

    assert.doesNotThrow(() =>
      assertIssuerBindingCompatible("srv", undefined, "https://issuer-a.example.com"),
    );
    assert.doesNotThrow(() =>
      assertIssuerBindingCompatible("srv", "https://issuer-a.example.com", undefined),
    );
    assert.doesNotThrow(() =>
      assertIssuerBindingCompatible(
        "srv",
        "https://issuer-a.example.com",
        "https://issuer-a.example.com",
      ),
    );
    assert.throws(
      () =>
        assertIssuerBindingCompatible(
          "srv",
          "https://issuer-a.example.com",
          "https://issuer-b.example.com",
        ),
      (err: unknown) =>
        err instanceof McpError &&
        err.code === "auth" &&
        err.message.includes("--reset"),
    );
  });

  it("merges and constructs silent StoredClientInfo without writing static client_secret to disk", () => {
    const mergedDcr = mergeSilentStoredClientInfo(
      baseStoredClient({ client_secret: "dcr-sec", redirect_uris: [DEFAULT_REDIRECT_URL] }),
      {},
      "https://issuer.example.com",
    );
    assert.equal(mergedDcr.client_secret, "dcr-sec");
    assert.equal(mergedDcr.issuer, "https://issuer.example.com");

    const mergedStatic = mergeSilentStoredClientInfo(
      baseStoredClient({ client_id: "static-id", client_secret: "accidental-secret" }),
      { clientId: "static-id", clientSecret: "static-sec" },
      "https://issuer.example.com",
    );
    assert.equal(mergedStatic.client_secret, undefined);

    const newStatic = buildNewSilentStoredClientInfo(
      { client_id: "static-id", client_secret: "static-sec" },
      { clientId: "static-id", clientSecret: "static-sec" },
      "https://issuer.example.com",
    );
    assert.equal(newStatic.client_secret, undefined);
    assert.equal(newStatic.issuer, "https://issuer.example.com");

    const newDcr = buildNewSilentStoredClientInfo(
      { client_id: "dcr-id", client_secret: "dcr-sec" },
      {},
      "https://issuer.example.com",
    );
    assert.equal(newDcr.client_secret, "dcr-sec");
  });

  it("detects peer-rotated tokens and maps between StoredTokens and OAuthTokens", () => {
    const baseline = baseStoredTokens();
    assert.equal(isPeerRotatedTokens(undefined, baseline), false);
    assert.equal(isPeerRotatedTokens(baseline, { ...baseline }), false);
    assert.equal(
      isPeerRotatedTokens(baseStoredTokens({ refresh_token: "rt-2" }), baseline),
      true,
    );
    assert.equal(
      isPeerRotatedTokens(baseStoredTokens({ access_token: "at-2" }), baseline),
      true,
    );

    const sdkTokens = toOAuthTokens(baseline);
    assert.deepEqual(sdkTokens, {
      access_token: "at-1",
      token_type: "Bearer",
      refresh_token: "rt-1",
      expires_in: 3600,
      scope: "read",
      issuer: "https://auth.example.com",
    });

    const roundTrip = toStoredTokens(sdkTokens, "2026-02-02T00:00:00.000Z");
    assert.equal(roundTrip.saved_at, "2026-02-02T00:00:00.000Z");
    assert.equal(roundTrip.issuer, "https://auth.example.com");
  });

  it("stamps canonical serverUrl and applies scoped StoredState invalidation", () => {
    const state: StoredState = {
      clientInfo: baseStoredClient(),
      tokens: baseStoredTokens(),
      discoveryState: { authorizationServerUrl: "https://auth.example.com" },
    };
    stampStateServerUrl(state, undefined);
    assert.equal(state.serverUrl, undefined);
    stampStateServerUrl(state, "https://mcp.example.com/api///");
    assert.equal(state.serverUrl, "https://mcp.example.com/api");

    assert.equal(applyStoredStateInvalidation(state, "verifier"), false);
    assert.equal(applyStoredStateInvalidation(state, "client"), true);
    assert.equal(state.clientInfo, undefined);
    assert.equal(applyStoredStateInvalidation(state, "client"), false);

    assert.equal(applyStoredStateInvalidation(state, "tokens"), true);
    assert.equal(state.tokens, undefined);
    assert.equal(applyStoredStateInvalidation(state, "tokens"), false);

    assert.equal(applyStoredStateInvalidation(state, "discovery"), true);
    assert.equal(state.discoveryState, undefined);
    assert.equal(applyStoredStateInvalidation(state, "all"), false);
  });
});

describe("McpOAuthProvider state() guards and CSRF retry preservation", () => {
  it("rejects provider.state() in silent mode and when cancelled in interactive mode", async () => {
    const silentProvider = new McpOAuthProvider({
      serverName: "silent-srv",
      authConfig: {},
      mode: "silent",
    });
    silentProvider.setState("csrf-state");
    await assert.rejects(
      () => silentProvider.state(),
      (err: unknown) => err instanceof AuthRequiredError && err.message.includes("silent-srv"),
    );

    let cancelled = false;
    const interactiveProvider = new McpOAuthProvider({
      serverName: "interactive-srv",
      authConfig: {},
      mode: "interactive",
      isCancelled: () => cancelled,
    });
    interactiveProvider.setState("csrf-state-123");
    assert.equal(await interactiveProvider.state(), "csrf-state-123");

    cancelled = true;
    await assert.rejects(
      () => interactiveProvider.state(),
      (err: unknown) =>
        err instanceof AuthRequiredError && err.message.includes("Authorization cancelled"),
    );
  });

  it("preserves _oauthState across interactive invalidateCredentials('all') for SDK authInternal retries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-oauth-state-retry-"));
    try {
      const provider = new McpOAuthProvider({
        serverName: "retry-srv",
        authConfig: {},
        storageDir: dir,
        mode: "interactive",
      });
      provider.setState("csrf-token-keep-alive");
      await provider.saveClientInformation({ client_id: "stale-client" });

      // Simulate MCP SDK authInternal() catching InvalidClientError:
      // it calls invalidateCredentials("all") and immediately retries authInternal() -> provider.state()
      await provider.invalidateCredentials("all");
      assert.equal(await provider.state(), "csrf-token-keep-alive");
      assert.equal(await provider.clientInformation(), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses unified origin-discard logic in loadStoredRedirectUrisSync for legacy resourceMetadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-sync-origin-"));
    try {
      const path = statePath("sync-srv", dir);
      await writeFile(
        path,
        JSON.stringify({
          clientInfo: {
            client_id: "cid",
            redirect_uris: ["http://127.0.0.1:25000/callback"],
          },
          discoveryState: {
            resourceMetadata: {
              resource: "https://mcp.example.com/team-a",
            },
          },
        }),
        "utf8",
      );

      assert.deepEqual(
        loadStoredRedirectUrisSync("sync-srv", dir, "https://mcp.example.com/team-a/v1"),
        ["http://127.0.0.1:25000/callback"],
      );
      assert.equal(
        loadStoredRedirectUrisSync("sync-srv", dir, "https://mcp.example.com/team-b"),
        undefined,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
