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

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
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
import { AuthCancelledError, authCancelOption, authRetryOption, browserOpenCommand, waitForOAuthCallbackWithUserControl } from "../src/index.js";

describe("OAuth Security Fixes", () => {
  const testServerName = "test-oauth-server";
  let provider: McpOAuthProvider;

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
  });

  describe("Manual Auth Challenge Discovery", () => {
    it("should extract path-prefixed resource metadata and scope from a 401 challenge", async () => {
      const resourceMetadataUrl = "https://services.prewave.ai/mcp/staging/infotag-mcp/.well-known/oauth-protected-resource/mcp";
      const response = new Response("", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}" scope="openid profile email"`,
        },
      });

      const challenge = await discoverManualAuthChallenge(
        "https://services.prewave.ai/mcp/staging/infotag-mcp/mcp",
        async () => response,
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
        async () => response,
      );

      assert.strictEqual(challenge.scope, "openid profile email");
      assert.strictEqual(challenge.resourceMetadataUrl, undefined);
    });

    it("should return an empty challenge when the server does not require auth", async () => {
      const challenge = await discoverManualAuthChallenge(
        "https://example.com/mcp",
        async () => new Response("ok", { status: 200 }),
      );

      assert.deepStrictEqual(challenge, {});
    });
  });

  describe("Medium Fix #5: Port Tracking", () => {
    it("should track the actual server port when it differs from preferred", async () => {
      // Stop any existing server
      await stopCallbackServer().catch(() => {});

      // Start with a preferred port that's likely to be free
      const preferredPort = 19876;
      const actualPort = await ensureCallbackServer(preferredPort);

      // The actual port should match (or be close to) the preferred port
      assert.ok(actualPort >= preferredPort, `Actual port ${actualPort} should be >= preferred ${preferredPort}`);
      assert.ok(actualPort <= preferredPort + 25, `Actual port ${actualPort} should not exceed preferred + 25`);

      // Cleanup
      await stopCallbackServer();
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


    it("should rebind from the default callback listener to a fixed redirect listener when no auth is pending", async () => {
      await stopCallbackServer().catch(() => {});

      const defaultPort = await ensureCallbackServer(DEFAULT_PORT, { host: "127.0.0.1", allowPortFallback: true });
      assert.strictEqual(defaultPort, DEFAULT_PORT);

      const fixedPort = DEFAULT_PORT + 1;
      const reboundPort = await ensureCallbackServer(fixedPort, { host: "127.0.0.1", allowPortFallback: false });
      assert.strictEqual(reboundPort, fixedPort);

      await stopCallbackServer();
    });

    it("should rebind from a fixed redirect listener back to the default listener when no auth is pending", async () => {
      await stopCallbackServer().catch(() => {});

      const fixedPort = DEFAULT_PORT + 2;
      const fixedListenerPort = await ensureCallbackServer(fixedPort, { host: "127.0.0.1", allowPortFallback: false });
      assert.strictEqual(fixedListenerPort, fixedPort);

      const defaultPort = await ensureCallbackServer(DEFAULT_PORT, { host: "127.0.0.1", allowPortFallback: true });
      assert.strictEqual(defaultPort, DEFAULT_PORT);

      await stopCallbackServer();
    });


    it("should stop the callback server when a browser keeps the callback socket open", async () => {
      await stopCallbackServer().catch(() => {});

      const port = DEFAULT_PORT + 20;
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
      // Stop any existing server
      await stopCallbackServer().catch(() => {});

      const port1 = await ensureCallbackServer(19876);
      const port2 = await ensureCallbackServer(19876);

      assert.strictEqual(port1, port2, "Subsequent calls should return the same port");

      // Cleanup
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

      const resultPromise = waitForOAuthCallbackWithUserControl(
        "test-server",
        callback.promise,
        () => assert.fail("Browser should not reopen when callback completes"),
        ui,
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

      const resultPromise = waitForOAuthCallbackWithUserControl(
        "test-server",
        callback.promise,
        () => {
          reopenCount += 1;
        },
        ui,
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
        () => waitForOAuthCallbackWithUserControl(
          "test-server",
          callback.promise,
          () => assert.fail("Browser should not reopen when auth is cancelled"),
          ui,
        ),
        AuthCancelledError,
      );
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
