/**
 * Tests for OAuth security and functionality fixes.
 *
 * These tests verify that the critical vulnerabilities identified in the
 * security audit have been properly remediated:
 *
 * 1. CSRF State Mismatch - oauthState is properly passed to the authorization URL
 * 2. Race condition - auth() return value is checked instead of catching UnauthorizedError
 * 3. XSS vulnerability - HTML errors are properly escaped
 * 4. Token expiry checking - expired tokens are properly detected
 * 5. Port tracking - actual server port is correctly tracked
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpOAuthProvider } from "../src/oauth-provider.js";
import type { AuthConfig } from "../src/oauth-provider.js";
import { Agent, createServer, request } from "node:http";
import {
  callbackServerConfigFromRedirectUrl,
  DEFAULT_PORT,
  ensureCallbackServer,
  stopCallbackServer,
  waitForCallback,
} from "../src/callback-server.js";
import { discoverManualAuthChallenge } from "../src/auth-challenge.js";
import { AuthCancelledError, authCancelOption, authRetryOption, browserOpenCommand, waitForOAuthCallback } from "../src/index.js";

describe("OAuth Security Fixes", () => {
  const testServerName = "test-oauth-server";
  let provider: McpOAuthProvider;
  let testHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  before(async () => {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    testHome = await mkdtemp(join(tmpdir(), "pi-mcp-oauth-test-"));
    process.env.HOME = testHome;
    process.env.USERPROFILE = testHome;
  });

  after(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await rm(testHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Create a fresh provider for each test
    provider = new McpOAuthProvider(testServerName, {});
  });

  afterEach(async () => {
    // Clean up any test state
    await provider.invalidateCredentials("all");
  });

  describe("Critical Fix #1: CSRF State Parameter", () => {
    it("should allow setting and retrieving the OAuth state parameter", async () => {
      const testState = "test-state-12345";
      provider.setState(testState);

      const retrievedState = await provider.state();
      assert.strictEqual(retrievedState, testState);
    });

    it("should return empty string when no state is set", async () => {
      const state = await provider.state();
      assert.strictEqual(state, "");
    });

    it("should persist state across multiple calls", async () => {
      const testState = "persistent-state-67890";
      provider.setState(testState);

      assert.strictEqual(await provider.state(), testState);
      assert.strictEqual(await provider.state(), testState);
    });

    it("should allow updating the state parameter", async () => {
      provider.setState("first-state");
      assert.strictEqual(await provider.state(), "first-state");

      provider.setState("second-state");
      assert.strictEqual(await provider.state(), "second-state");
    });
  });

  describe("Token Handling", () => {
    it("should expose configured scope through client metadata", () => {
      provider = new McpOAuthProvider(testServerName, { scope: "read write" });

      assert.strictEqual(provider.clientMetadata.scope, "read write");
    });

    it("should always return expired tokens (to allow SDK silent refresh)", async () => {
      // CRITICAL: tokens() must ALWAYS return stored tokens, even if expired.
      // The SDK's auth() function checks tokens?.refresh_token to attempt silent
      // refresh. Returning undefined for expired tokens would break that flow
      // and force the user to re-authenticate via browser every time.
      //
      // Correct flow when we return expired tokens:
      //   transport sends expired access_token → 401
      //   → auth() sees refresh_token → silent refresh → success → retry

      // Simulate a token that was saved 2 hours ago with a 1 hour expiry
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      const savedAt = new Date(oneHourAgo).toISOString();

      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const { createHash } = await import("node:crypto");

      const authDir = join(homedir(), ".pi", "agent", "mcp-auth");
      const hash = createHash("sha256")
        .update(testServerName)
        .digest("hex")
        .slice(0, 16);
      const filePath = join(authDir, `${hash}.json`);

      await mkdir(authDir, { recursive: true });
      await writeFile(filePath, JSON.stringify({
        tokens: {
          access_token: "expired-token",
          token_type: "Bearer",
          refresh_token: "refresh-token-value",
          expires_in: 3600, // 1 hour
          saved_at: savedAt,
        }
      }, null, 2), "utf8");

      // MUST return the expired tokens (with refresh_token) so SDK can refresh
      const tokens = await provider.tokens();
      assert.ok(tokens, "Expired tokens MUST be returned to allow silent refresh");
      assert.strictEqual(tokens?.access_token, "expired-token");
      assert.strictEqual(tokens?.refresh_token, "refresh-token-value");

      // Cleanup
      await provider.invalidateCredentials("all");
    });

    it("should return valid tokens that haven't expired", async () => {
      // Set up a token with recent save time
      const justNow = new Date().toISOString();

      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const { createHash } = await import("node:crypto");

      const authDir = join(homedir(), ".pi", "agent", "mcp-auth");
      const hash = createHash("sha256")
        .update(testServerName)
        .digest("hex")
        .slice(0, 16);
      const filePath = join(authDir, `${hash}.json`);

      await mkdir(authDir, { recursive: true });
      await writeFile(filePath, JSON.stringify({
        tokens: {
          access_token: "valid-token",
          token_type: "Bearer",
          expires_in: 3600, // 1 hour
          saved_at: justNow,
        }
      }, null, 2), "utf8");

      // Check if the token is returned
      const tokens = await provider.tokens();
      assert.ok(tokens, "Valid tokens should be returned");
      assert.strictEqual(tokens?.access_token, "valid-token");

      // Cleanup
      await provider.invalidateCredentials("all");
    });

    it("should return undefined when no tokens exist", async () => {
      const tokens = await provider.tokens();
      assert.strictEqual(tokens, undefined, "Should return undefined when no tokens stored");
    });

    it("should restrict the auth directory and state file permissions", async () => {
      await provider.saveTokens({
        access_token: "permission-test-token",
        token_type: "Bearer",
      });

      const { stat } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const { createHash } = await import("node:crypto");
      const authDir = join(homedir(), ".pi", "agent", "mcp-auth");
      const hash = createHash("sha256").update(testServerName).digest("hex").slice(0, 16);
      const [directoryStats, fileStats] = await Promise.all([
        stat(authDir),
        stat(join(authDir, `${hash}.json`)),
      ]);

      assert.strictEqual(directoryStats.isDirectory(), true);
      assert.strictEqual(fileStats.isFile(), true);
      if (process.platform !== "win32") {
        assert.strictEqual(directoryStats.mode & 0o777, 0o700);
        assert.strictEqual(fileStats.mode & 0o777, 0o600);
      }
    });
  });

  describe("Manual Auth Challenge Discovery", () => {
    it("should extract path-prefixed resource metadata and scope from a 401 challenge", async () => {
      const resourceMetadataUrl = "https://mcp.example.com/team/service/.well-known/oauth-protected-resource/mcp";
      const response = new Response("", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}" scope="openid profile email"`,
        },
      });

      const challenge = await discoverManualAuthChallenge(
        "https://mcp.example.com/team/service/mcp",
        { fetchFn: async () => response },
      );

      assert.strictEqual(challenge.resourceMetadataUrl?.toString(), resourceMetadataUrl);
      assert.strictEqual(challenge.scope, "openid profile email");
    });

    it("should extract scope from a 403 insufficient-scope challenge", async () => {
      const response = new Response("", {
        status: 403,
        headers: {
          "WWW-Authenticate": 'Bearer error="insufficient_scope" scope="openid profile email"',
        },
      });

      const challenge = await discoverManualAuthChallenge(
        "https://example.com/mcp",
        { fetchFn: async () => response },
      );

      assert.strictEqual(challenge.scope, "openid profile email");
      assert.strictEqual(challenge.resourceMetadataUrl, undefined);
    });

    it("should ignore scope from a 403 that is not an insufficient-scope challenge", async () => {
      const response = new Response("", {
        status: 403,
        headers: {
          "WWW-Authenticate": 'Bearer error="access_denied" scope="admin"',
        },
      });

      const challenge = await discoverManualAuthChallenge(
        "https://example.com/mcp",
        { fetchFn: async () => response },
      );

      assert.deepStrictEqual(challenge, {});
    });

    it("should abort challenge discovery after the configured timeout", async () => {
      const hangingFetch = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
        return new Promise<Response>((_resolve, reject) => {
          const guardTimer = setTimeout(() => reject(new Error("Challenge timeout did not abort the request")), 1000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(guardTimer);
            reject(init.signal?.reason);
          }, { once: true });
        });
      };

      await assert.rejects(
        () => discoverManualAuthChallenge("https://example.com/mcp", { fetchFn: hangingFetch, timeoutMs: 10 }),
        (error: unknown) => error instanceof DOMException && error.name === "TimeoutError",
      );
    });

    it("should include configured static headers in challenge discovery", async () => {
      let requestHeaders: Headers | undefined;
      await discoverManualAuthChallenge("https://example.com/mcp", {
        headers: { "X-Tenant": "example-team" },
        fetchFn: async (_input, init) => {
          requestHeaders = new Headers(init?.headers);
          return new Response("ok", { status: 200 });
        },
      });

      assert.strictEqual(requestHeaders?.get("x-tenant"), "example-team");
      assert.strictEqual(requestHeaders?.get("accept"), "application/json, text/event-stream");
    });

    it("should return an empty challenge when the server does not require auth", async () => {
      const challenge = await discoverManualAuthChallenge(
        "https://example.com/mcp",
        { fetchFn: async () => new Response("ok", { status: 200 }) },
      );

      assert.deepStrictEqual(challenge, {});
    });
  });

  describe("Medium Fix #5: Port Tracking", () => {
    async function getFreePort(): Promise<number> {
      const listener = createServer();
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const address = listener.address();
      assert.ok(address && typeof address === "object");
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      return address.port;
    }

    it("should track the actual server port when it differs from preferred", async () => {
      await stopCallbackServer().catch(() => {});
      const blocker = createServer();
      await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
      const address = blocker.address();
      assert.ok(address && typeof address === "object");

      try {
        const actualPort = await ensureCallbackServer(address.port);
        assert.ok(actualPort > address.port);
        assert.ok(actualPort <= address.port + 24);
      } finally {
        await stopCallbackServer().catch(() => {});
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });


    it("should derive fixed callback server settings from a local redirect URL", () => {
      const config = callbackServerConfigFromRedirectUrl("http://localhost:8787/callback");

      assert.deepStrictEqual(config, {
        preferredPort: 8787,
        host: "localhost",
        allowPortFallback: false,
      });
    });

    it("should keep fallback scanning when no local redirect URL is configured", () => {
      const config = callbackServerConfigFromRedirectUrl();

      assert.strictEqual(config.preferredPort, DEFAULT_PORT);
      assert.strictEqual(config.allowPortFallback, true);
    });

    it("should reject non-local redirect URLs for the manual flow", () => {
      assert.throws(
        () => callbackServerConfigFromRedirectUrl("https://example.com/callback"),
        /must use HTTP with localhost, 127\.0\.0\.1, or ::1/,
      );
    });

    it("should reject redirect URLs with fragments, credentials, or port zero", () => {
      assert.throws(
        () => callbackServerConfigFromRedirectUrl("http://localhost:8787/callback#fragment"),
        /must not include a fragment/,
      );
      assert.throws(
        () => callbackServerConfigFromRedirectUrl("http://user:password@localhost:8787/callback"),
        /must not include credentials/,
      );
      assert.throws(
        () => callbackServerConfigFromRedirectUrl("http://localhost:0/callback"),
        /must use a fixed non-zero port/,
      );
    });

    it("should fail instead of incrementing the port for fixed redirect URLs", async () => {
      await stopCallbackServer().catch(() => {});

      const blocker = createServer((_req, res) => {
        res.end("busy");
      });
      await new Promise<void>((resolve) => {
        blocker.listen(0, "127.0.0.1", () => resolve());
      });
      const address = blocker.address();
      assert.ok(address && typeof address === "object");

      try {
        await assert.rejects(
          () => ensureCallbackServer(address.port, { host: "127.0.0.1", allowPortFallback: false }),
          /requires this exact port/,
        );
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });


    it("should rebind from a fallback callback listener to a fixed redirect listener when no auth is pending", async () => {
      await stopCallbackServer().catch(() => {});

      const fallbackPreferredPort = await getFreePort();
      const fallbackPort = await ensureCallbackServer(fallbackPreferredPort, { host: "127.0.0.1", allowPortFallback: true });
      assert.strictEqual(fallbackPort, fallbackPreferredPort);

      const fixedPort = await getFreePort();
      const reboundPort = await ensureCallbackServer(fixedPort, { host: "127.0.0.1", allowPortFallback: false });
      assert.strictEqual(reboundPort, fixedPort);

      await stopCallbackServer();
    });

    it("should rebind from a fixed redirect listener to a fallback listener when no auth is pending", async () => {
      await stopCallbackServer().catch(() => {});

      const fixedPort = await getFreePort();
      const fixedListenerPort = await ensureCallbackServer(fixedPort, { host: "127.0.0.1", allowPortFallback: false });
      assert.strictEqual(fixedListenerPort, fixedPort);

      const fallbackPreferredPort = await getFreePort();
      const fallbackPort = await ensureCallbackServer(fallbackPreferredPort, { host: "127.0.0.1", allowPortFallback: true });
      assert.strictEqual(fallbackPort, fallbackPreferredPort);

      await stopCallbackServer();
    });


    it("should stop the callback server when a browser keeps the callback socket open", async () => {
      await stopCallbackServer().catch(() => {});

      const port = await getFreePort();
      const state = "keepalive-state";
      await ensureCallbackServer(port, { host: "127.0.0.1", allowPortFallback: false });
      const callbackPromise = waitForCallback(state);

      const agent = new Agent({ keepAlive: true });
      try {
        await new Promise<void>((resolve, reject) => {
          const req = request(
            {
              hostname: "127.0.0.1",
              port,
              path: `/callback?code=test-code&state=${state}`,
              agent,
            },
            (res) => {
              res.resume();
              res.on("end", resolve);
            },
          );
          req.on("error", reject);
          req.end();
        });

        assert.strictEqual(await callbackPromise, "test-code");

        await Promise.race([
          stopCallbackServer(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("stopCallbackServer timed out")), 1000)),
        ]);
      } finally {
        agent.destroy();
        await stopCallbackServer().catch(() => {});
      }
    });

    it("should return the same port on subsequent calls", async () => {
      await stopCallbackServer().catch(() => {});

      const preferredPort = await getFreePort();
      const port1 = await ensureCallbackServer(preferredPort);
      const port2 = await ensureCallbackServer(preferredPort);

      assert.strictEqual(port1, port2, "Subsequent calls should return the same port");

      await stopCallbackServer();
    });
  });

  describe("IPv4 Binding (Medium Fix #12)", () => {
    it("should use 127.0.0.1 in redirect URL", () => {
      const provider = new McpOAuthProvider(testServerName, {});
      const redirectUrl = String(provider.redirectUrl);

      assert.match(redirectUrl, /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
        "Redirect URL should use 127.0.0.1, not localhost");
    });

    it("should respect custom redirect URL if provided", () => {
      const customUrl = "https://example.com/callback";
      const provider = new McpOAuthProvider(testServerName, { redirectUrl: customUrl });
      const redirectUrl = String(provider.redirectUrl);

      assert.strictEqual(redirectUrl, customUrl, "Custom redirect URL should be preserved");
    });
  });


  describe("Browser Opening", () => {
    it("should pass authorization URLs as literal process arguments", () => {
      const url = 'https://example.com/authorize?state=$(touch /tmp/pi-mcp-owned)&x="quoted"';
      const command = browserOpenCommand(url);

      assert.ok(command.args.includes(url));
      assert.ok(command.args.every((arg) => !arg.includes("open ")));
    });
  });

  describe("Manual OAuth Wait Controls", () => {
    function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
      });
      return { promise, resolve, reject };
    }

    it("should return the callback code and dismiss the retry/cancel dialog", async () => {
      const callback = deferred<string>();
      let dialogAborted = false;
      const ui = {
        select: async (_title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
          return new Promise<string | undefined>((resolve) => {
            opts?.signal?.addEventListener("abort", () => {
              dialogAborted = true;
              resolve(undefined);
            });
          });
        },
      };

      const resultPromise = waitForOAuthCallback(
        "test-server",
        callback.promise,
        () => assert.fail("Browser should not reopen when callback completes"),
        { hasUI: true, ui },
      );

      callback.resolve("auth-code");

      assert.strictEqual(await resultPromise, "auth-code");
      assert.strictEqual(dialogAborted, true);
    });

    it("should reopen the browser when the user chooses retry", async () => {
      const callback = deferred<string>();
      let selectCalls = 0;
      let reopenCount = 0;
      const ui = {
        select: async (_title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
          selectCalls += 1;
          if (selectCalls === 1) {
            return authRetryOption;
          }
          return new Promise<string | undefined>((resolve) => {
            opts?.signal?.addEventListener("abort", () => resolve(undefined));
          });
        },
      };

      const resultPromise = waitForOAuthCallback(
        "test-server",
        callback.promise,
        () => {
          reopenCount += 1;
        },
        { hasUI: true, ui },
      );

      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(reopenCount, 1);

      callback.resolve("auth-code-after-retry");

      assert.strictEqual(await resultPromise, "auth-code-after-retry");
    });

    it("should cancel authentication when the user chooses cancel", async () => {
      const callback = deferred<string>();
      const ui = {
        select: async () => authCancelOption,
      };

      await assert.rejects(
        () => waitForOAuthCallback(
          "test-server",
          callback.promise,
          () => assert.fail("Browser should not reopen when auth is cancelled"),
          { hasUI: true, ui: ui as any },
        ),
        AuthCancelledError,
      );
    });

    it("should wait for the callback without opening a selector when UI is unavailable", async () => {
      const callback = deferred<string>();
      let selectCalled = false;
      const ui = {
        select: async () => {
          selectCalled = true;
          return undefined;
        },
      };

      const resultPromise = waitForOAuthCallback(
        "test-server",
        callback.promise,
        () => assert.fail("Browser should not reopen without UI"),
        { hasUI: false, ui },
      );
      callback.resolve("headless-auth-code");

      assert.strictEqual(await resultPromise, "headless-auth-code");
      assert.strictEqual(selectCalled, false);
    });
  });

  describe("Minor Fix #9: resetAuth simplification", () => {
    it("should delete the state file when resetting auth", async () => {
      const { resetAuth, getAuthStatus } = await import("../src/oauth-provider.js");

      // First, create some state
      await provider.saveTokens({
        access_token: "test-token",
        token_type: "Bearer",
        expires_in: 3600,
      });

      // Verify the state exists
      const tokensBefore = await provider.tokens();
      assert.ok(tokensBefore, "Tokens should exist before reset");

      const statusBefore = await getAuthStatus(testServerName);
      assert.ok(statusBefore?.hasTokens, "Auth status should show tokens before reset");

      // Reset auth
      await resetAuth(testServerName);

      // Verify the state is gone by checking auth status
      const statusAfter = await getAuthStatus(testServerName);
      assert.strictEqual(statusAfter, null, "Auth status should be null after reset");

      // Verify tokens are gone
      const tokensAfter = await provider.tokens();
      assert.strictEqual(tokensAfter, undefined, "Tokens should not exist after reset");
    });
  });
});
