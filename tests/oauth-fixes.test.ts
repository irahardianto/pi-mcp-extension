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
import { CallbackUrlValidationError, isSafeAuthorizationUrl, parseCallbackUrl } from "../src/callback-url.js";
import extension, { AuthCancelledError, authCancelOption, authPasteOption, authRetryOption, browserOpenCommand, waitForOAuthCallback } from "../src/index.js";

describe("OAuth Security Fixes", () => {
  const testServerName = "test-oauth-server";
  let provider: McpOAuthProvider;
  let testStorage: string;

  before(async () => {
    testStorage = await mkdtemp(join(tmpdir(), "pi-mcp-oauth-test-"));
  });

  after(async () => {
    await rm(testStorage, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Create a fresh provider for each test
    provider = new McpOAuthProvider(testServerName, {}, undefined, testStorage);
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
      provider = new McpOAuthProvider(testServerName, { scope: "read write" }, undefined, testStorage);

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
      const { createHash } = await import("node:crypto");

      const authDir = testStorage;
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
      const { createHash } = await import("node:crypto");

      const authDir = testStorage;
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
      const { createHash } = await import("node:crypto");
      const authDir = testStorage;
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

    it("should return an empty challenge when the server responds with 405 Method Not Allowed", async () => {
      // Arrange
      const response = new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "POST",
          "WWW-Authenticate": 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource" scope="read"',
        },
      });

      // Act
      const challenge = await discoverManualAuthChallenge(
        "https://example.com/mcp",
        { fetchFn: async () => response },
      );

      // Assert
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

    it("should reject redirect URLs when no explicit port or port 80 is provided", () => {
      // Arrange
      const urlWithoutPort = "http://127.0.0.1/callback";
      const urlWithPort80 = "http://127.0.0.1:80/callback";

      // Act & Assert
      assert.throws(
        () => callbackServerConfigFromRedirectUrl(urlWithoutPort),
        /Manual OAuth redirect URL must include an explicit port \(e\.g\. http:\/\/127\.0\.0\.1:19876\/callback\)/,
      );
      assert.throws(
        () => callbackServerConfigFromRedirectUrl(urlWithPort80),
        /Manual OAuth redirect URL must include an explicit port \(e\.g\. http:\/\/127\.0\.0\.1:19876\/callback\)/,
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
      const provider = new McpOAuthProvider(testServerName, {}, undefined, testStorage);
      const redirectUrl = String(provider.redirectUrl);

      assert.match(redirectUrl, /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
        "Redirect URL should use 127.0.0.1, not localhost");
    });

    it("should respect custom redirect URL if provided", () => {
      const customUrl = "https://example.com/callback";
      const provider = new McpOAuthProvider(testServerName, { redirectUrl: customUrl }, undefined, testStorage);
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

    it("fails promptly without a selector when UI is unavailable", async () => {
      const callback = deferred<string>();
      const ui = { select: async () => assert.fail("Headless auth must not open a selector") };
      await assert.rejects(
        waitForOAuthCallback("test-server", callback.promise, () => assert.fail("No browser"), { hasUI: false, ui }),
        /requires an interactive Pi session/,
      );
    });

    it("should resolve with authorization code and call onPasteResolved when user pastes a valid redirect URL", async () => {
      // Arrange
      const callback = deferred<string>();
      let pasteResolvedCalled = false;
      const ui = {
        select: async () => authPasteOption,
        input: async () => "http://127.0.0.1:19876/callback?code=pasted-code-123&state=expected-state-abc",
      };

      // Act
      const code = await waitForOAuthCallback(
        "test-server",
        callback.promise,
        () => assert.fail("Browser should not reopen during paste"),
        { hasUI: true, ui },
        {
          redirectUrl: "http://127.0.0.1:19876/callback",
          expectedState: "expected-state-abc",
          onPasteResolved: () => {
            pasteResolvedCalled = true;
          },
        },
      );

      // Assert
      assert.strictEqual(code, "pasted-code-123");
      assert.strictEqual(pasteResolvedCalled, true);
    });

    it("should notify an error and re-prompt when user pastes invalid redirect URLs before pasting a valid redirect URL", async () => {
      // Arrange
      const callback = deferred<string>();
      const notifications: Array<{ message: string; type?: string }> = [];
      const pastedInputs = [
        "not-a-valid-url",
        "http://127.0.0.1:99999/callback?code=abc&state=state-1",
        "http://127.0.0.1:19876/wrong?code=abc&state=state-1",
        "http://127.0.0.1:19876/callback?code=abc&state=wrong-state",
        "http://127.0.0.1:19876/callback?code=valid-after-retries&state=state-1",
      ];
      let inputIndex = 0;
      const ui = {
        select: async () => authPasteOption,
        input: async () => pastedInputs[inputIndex++],
        notify: (message: string, type?: "info" | "warning" | "error") => {
          notifications.push({ message, ...(type ? { type } : {}) });
        },
      };

      // Act
      const code = await waitForOAuthCallback(
        "test-server",
        callback.promise,
        () => assert.fail("Browser should not reopen"),
        { hasUI: true, ui },
        {
          redirectUrl: "http://127.0.0.1:19876/callback",
          expectedState: "state-1",
        },
      );

      // Assert
      assert.strictEqual(code, "valid-after-retries");
      assert.strictEqual(inputIndex, 5);
      assert.strictEqual(notifications.length, 4);
      assert.ok(notifications.every((n) => n.type === "error" && n.message.startsWith("pi-mcp: Invalid redirect URL — ")));
    });

    it("should reject with OAuth error description when user pastes a redirect URL containing error=access_denied", async () => {
      // Arrange
      const callback = deferred<string>();
      let pasteResolvedCalled = false;
      const ui = {
        select: async () => authPasteOption,
        input: async () =>
          "http://127.0.0.1:19876/callback?error=access_denied&error_description=User%20denied%20access&state=state-1",
      };

      // Act & Assert
      await assert.rejects(
        () =>
          waitForOAuthCallback(
            "test-server",
            callback.promise,
            () => assert.fail("Browser should not reopen"),
            { hasUI: true, ui },
            {
              redirectUrl: "http://127.0.0.1:19876/callback",
              expectedState: "state-1",
              onPasteResolved: () => {
                pasteResolvedCalled = true;
              },
            },
          ),
        /User denied access/,
      );
      assert.strictEqual(pasteResolvedCalled, true);
    });
  });

  describe("Authorization URL Scheme Validation (isSafeAuthorizationUrl)", () => {
    it("should allow https authorization URLs when validating browser target", () => {
      // Arrange
      const httpsUrl = "https://auth.example.com/oauth/authorize?client_id=abc&state=xyz";

      // Act
      const result = isSafeAuthorizationUrl(httpsUrl);

      // Assert
      assert.strictEqual(result, true);
    });

    it("should allow loopback http authorization URLs when hostname is 127.0.0.1, localhost, or [::1]", () => {
      // Arrange
      const urls = [
        "http://127.0.0.1:8080/authorize",
        "http://localhost:8080/authorize",
        "http://[::1]:8080/authorize",
      ];

      // Act & Assert
      for (const url of urls) {
        assert.strictEqual(isSafeAuthorizationUrl(url), true, `Expected ${url} to be allowed`);
      }
    });

    it("should reject file, smb, javascript, non-loopback http, and malformed URLs when validating browser target", () => {
      // Arrange
      const unsafeUrls = [
        "file:///etc/passwd",
        "smb://server/share",
        "javascript:alert(1)",
        "http://example.com/auth",
        "custom-scheme://open",
        "::not-a-valid-url::",
      ];

      // Act & Assert
      for (const url of unsafeUrls) {
        assert.strictEqual(isSafeAuthorizationUrl(url), false, `Expected ${url} to be rejected`);
      }
    });
  });

  describe("Callback URL Parsing (parseCallbackUrl)", () => {
    it("should return code and state when redirect URL is valid and includes extra query parameters and URL-encoded values", () => {
      // Arrange
      const redirectUrl = "http://127.0.0.1:19876/callback";
      const input =
        "  http://127.0.0.1:19876/callback?iss=https%3A%2F%2Fauth.example.com&code=code%2Fwith%2Bspecial%3Dchars&state=state%20123&scope=read%20write  ";

      // Act
      const parsed = parseCallbackUrl(input, {
        redirectUrl,
        expectedState: "state 123",
      });

      // Assert
      assert.deepStrictEqual(parsed, {
        state: "state 123",
        code: "code/with+special=chars",
      });
    });

    it("should throw CallbackUrlValidationError with invalid_state when state does not match expectedState", () => {
      // Arrange
      const input = "http://127.0.0.1:19876/callback?code=abc&state=wrong-state";

      // Act & Assert
      assert.throws(
        () =>
          parseCallbackUrl(input, {
            redirectUrl: "http://127.0.0.1:19876/callback",
            expectedState: "expected-state",
          }),
        (err: unknown) =>
          err instanceof CallbackUrlValidationError &&
          err.reason === "invalid_state" &&
          /Invalid or expired state parameter/.test(err.message),
      );
    });

    it("should throw CallbackUrlValidationError with missing_state when state parameter is absent", () => {
      // Arrange
      const input = "http://127.0.0.1:19876/callback?code=abc";

      // Act & Assert
      assert.throws(
        () =>
          parseCallbackUrl(input, {
            redirectUrl: "http://127.0.0.1:19876/callback",
            expectedState: "expected-state",
          }),
        (err: unknown) =>
          err instanceof CallbackUrlValidationError &&
          err.reason === "missing_state" &&
          /Missing required state parameter/.test(err.message),
      );
    });

    it("should throw CallbackUrlValidationError with wrong_path when pathname does not match /callback", () => {
      // Arrange
      const input = "http://127.0.0.1:19876/other-path?code=abc&state=expected-state";

      // Act & Assert
      assert.throws(
        () =>
          parseCallbackUrl(input, {
            redirectUrl: "http://127.0.0.1:19876/callback",
            expectedState: "expected-state",
          }),
        (err: unknown) =>
          err instanceof CallbackUrlValidationError &&
          err.reason === "wrong_path" &&
          /Redirect URL path must be \/callback/.test(err.message),
      );
    });

    it("should throw CallbackUrlValidationError with wrong_origin when port or origin does not match expected redirectUrl", () => {
      // Arrange
      const wrongPortUrl = "http://127.0.0.1:29999/callback?code=abc&state=expected-state";
      const wrongHostUrl = "http://localhost:19876/callback?code=abc&state=expected-state";

      // Act & Assert
      for (const input of [wrongPortUrl, wrongHostUrl]) {
        assert.throws(
          () =>
            parseCallbackUrl(input, {
              redirectUrl: "http://127.0.0.1:19876/callback",
              expectedState: "expected-state",
            }),
          (err: unknown) =>
            err instanceof CallbackUrlValidationError &&
            err.reason === "wrong_origin" &&
            /Redirect URL origin must match http:\/\/127\.0\.0\.1:19876/.test(err.message),
        );
      }
    });

    it("should throw CallbackUrlValidationError with missing_code when neither code nor error is present", () => {
      // Arrange
      const input = "http://127.0.0.1:19876/callback?state=expected-state";

      // Act & Assert
      assert.throws(
        () =>
          parseCallbackUrl(input, {
            redirectUrl: "http://127.0.0.1:19876/callback",
            expectedState: "expected-state",
          }),
        (err: unknown) =>
          err instanceof CallbackUrlValidationError &&
          err.reason === "missing_code" &&
          /No authorization code provided/.test(err.message),
      );
    });

    it("should return state and error description when error=access_denied and error_description are present with valid state", () => {
      // Arrange
      const input =
        "http://127.0.0.1:19876/callback?error=access_denied&error_description=User%20rejected%20request&state=expected-state";

      // Act
      const parsed = parseCallbackUrl(input, {
        redirectUrl: "http://127.0.0.1:19876/callback",
        expectedState: "expected-state",
      });

      // Assert
      assert.deepStrictEqual(parsed, {
        state: "expected-state",
        error: "User rejected request",
      });
    });
  });

  describe("Headless, SSH, and Safe Browser Launch Integration", () => {
    async function createMockOAuthMcpServer(options: { authorizationEndpoint?: string } = {}) {
      let base = "";
      const listener = createServer((req, res) => {
        if (req.url === "/.well-known/oauth-protected-resource/mcp" || req.url === "/.well-known/oauth-protected-resource") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }));
          return;
        }
        if (req.url === "/.well-known/oauth-authorization-server") {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              issuer: base,
              authorization_endpoint: options.authorizationEndpoint ?? `${base}/authorize`,
              token_endpoint: `${base}/token`,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              code_challenge_methods_supported: ["S256"],
            }),
          );
          return;
        }
        if (req.url === "/token" && req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk.toString();
          });
          req.on("end", () => {
            const params = new URLSearchParams(body);
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({
                access_token: `token-for-${params.get("code")}`,
                token_type: "Bearer",
              }),
            );
          });
          return;
        }
        if (req.url === "/mcp") {
          if (req.method === "GET") {
            res.writeHead(405, { Allow: "POST" });
            res.end();
            return;
          }
          if (!req.headers.authorization?.startsWith("Bearer token-for-")) {
            res.writeHead(401, { "WWW-Authenticate": "Bearer" });
            res.end("Unauthorized");
            return;
          }
          let body = "";
          req.on("data", (chunk) => {
            body += chunk.toString();
          });
          req.on("end", () => {
            const msg = JSON.parse(body);
            if (msg.method === "initialize") {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: {
                    protocolVersion: "2025-03-26",
                    capabilities: { tools: {} },
                    serverInfo: { name: "mock-oauth", version: "1.0.0" },
                  },
                }),
              );
            } else if (msg.method === "notifications/initialized") {
              res.writeHead(202);
              res.end();
            } else if (msg.method === "tools/list") {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: {
                    tools: [
                      {
                        name: "ssh_tool",
                        description: "SSH tool",
                        inputSchema: { type: "object", properties: {} },
                      },
                    ],
                  },
                }),
              );
            } else {
              res.writeHead(400);
              res.end();
            }
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const callbackProbe = createServer();
      await new Promise<void>((resolve) => callbackProbe.listen(0, "127.0.0.1", resolve));
      const callbackAddress = callbackProbe.address();
      assert.ok(callbackAddress && typeof callbackAddress === "object");
      await new Promise<void>((resolve) => callbackProbe.close(() => resolve()));

      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const address = listener.address();
      assert.ok(address && typeof address === "object");
      base = `http://127.0.0.1:${address.port}`;

      return {
        base,
        redirectUrl: `http://127.0.0.1:${callbackAddress.port}/callback`,
        close: async () => {
          listener.closeAllConnections();
          await new Promise<void>((resolve) => listener.close(() => resolve()));
        },
      };
    }

    it("should complete authorization end-to-end via Paste redirect URL when the local HTTP callback server is never hit", async () => {
      // Arrange
      const { mkdir, writeFile } = await import("node:fs/promises");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-paste-e2e-"));
      const mock = await createMockOAuthMcpServer();
      const commands = new Map<string, any>();
      const events = new Map<string, any>();
      const notifications: Array<{ message: string; type?: string }> = [];
      let capturedAuthUrl: URL | undefined;
      const inputs = [
        "http://127.0.0.1:1/callback?code=wrong-port&state=bad",
        () => {
          assert.ok(capturedAuthUrl);
          const state = capturedAuthUrl.searchParams.get("state")!;
          const redirectUri = capturedAuthUrl.searchParams.get("redirect_uri")!;
          return `${redirectUri}?code=pasted-ssh-code&state=${encodeURIComponent(state)}`;
        },
      ];
      let inputCalls = 0;
      const ctx: any = {
        cwd: dir,
        hasUI: true,
        ui: {
          notify: (message: string, type?: string) => notifications.push({ message, ...(type ? { type } : {}) }),
          select: async () => authPasteOption,
          input: async () => {
            const entry = inputs[inputCalls++];
            return typeof entry === "function" ? entry() : entry;
          },
        },
      };

      try {
        await mkdir(join(dir, ".pi"));
        await writeFile(
          join(dir, ".pi", "mcp.json"),
          JSON.stringify({
            settings: { maxRetries: 0 },
            mcpServers: {
              remote: {
                lifecycle: "lazy",
                transport: "streamable-http",
                url: `${mock.base}/mcp`,
                auth: { type: "oauth", clientId: "ssh-client", redirectUrl: mock.redirectUrl },
              },
            },
          }),
        );

        await extension(
          {
            registerTool: () => {},
            registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
            on: (name: string, handler: any) => events.set(name, handler),
            getActiveTools: () => [],
            setActiveTools: () => {},
          } as any,
          {
            bootstrapCwd: dir,
            globalConfigPath: join(dir, "no-global.json"),
            authStorageDir: join(dir, "auth"),
            browserOpen: (url: string) => {
              capturedAuthUrl = new URL(url);
            },
          },
        );
        await events.get("session_start")({}, ctx);

        // Act
        await commands.get("mcp:auth").handler("remote", ctx);

        // Assert
        assert.strictEqual(inputCalls, 2);
        assert.ok(
          notifications.some((n) => n.type === "info" && n.message.includes("Authorize remote:") && n.message.includes("ssh -L")),
          "Expected notification containing the authorization URL and SSH port-forwarding hint",
        );
        assert.ok(
          notifications.some((n) => n.type === "error" && n.message.includes("Invalid redirect URL")),
          "Expected error notification for the first invalid pasted redirect URL",
        );
        assert.ok(
          notifications.some((n) => n.type === "info" && n.message.includes("pi-mcp: remote ready")),
          "Expected server to complete authentication and start",
        );
      } finally {
        await events.get("session_shutdown")?.({}, ctx);
        await mock.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should refuse file: and smb: authorization URLs before invoking browserOpen", async () => {
      // Arrange
      const { mkdir, writeFile } = await import("node:fs/promises");
      for (const maliciousAuthEndpoint of ["file:///etc/passwd", "smb://attacker.example.com/share"]) {
        const dir = await mkdtemp(join(tmpdir(), "pi-mcp-unsafe-scheme-"));
        const mock = await createMockOAuthMcpServer({ authorizationEndpoint: maliciousAuthEndpoint });
        const commands = new Map<string, any>();
        const events = new Map<string, any>();
        const notifications: Array<{ message: string; type?: string }> = [];
        let browserOpenCalled = false;
        const ctx: any = {
          cwd: dir,
          hasUI: true,
          ui: {
            notify: (message: string, type?: string) => notifications.push({ message, ...(type ? { type } : {}) }),
            select: async () => authCancelOption,
          },
        };

        try {
          await mkdir(join(dir, ".pi"));
          await writeFile(
            join(dir, ".pi", "mcp.json"),
            JSON.stringify({
              settings: { maxRetries: 0 },
              mcpServers: {
                malicious: {
                  lifecycle: "lazy",
                  transport: "streamable-http",
                  url: `${mock.base}/mcp`,
                  auth: { type: "oauth", clientId: "client-1", redirectUrl: mock.redirectUrl },
                },
              },
            }),
          );

          await extension(
            {
              registerTool: () => {},
              registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
              on: (name: string, handler: any) => events.set(name, handler),
              getActiveTools: () => [],
              setActiveTools: () => {},
            } as any,
            {
              bootstrapCwd: dir,
              globalConfigPath: join(dir, "no-global.json"),
              authStorageDir: join(dir, "auth"),
              browserOpen: () => {
                browserOpenCalled = true;
              },
            },
          );
          await events.get("session_start")({}, ctx);

          // Act
          await commands.get("mcp:auth").handler("malicious", ctx);

          // Assert
          assert.strictEqual(browserOpenCalled, false, `browserOpen must not be called for ${maliciousAuthEndpoint}`);
          assert.ok(
            notifications.some((n) => n.type === "error" && /Refusing to open unsafe authorization URL/.test(n.message)),
            `Expected unsafe authorization URL error notification for ${maliciousAuthEndpoint}`,
          );
        } finally {
          await events.get("session_shutdown")?.({}, ctx);
          await mock.close();
          await rm(dir, { recursive: true, force: true });
        }
      }
    });

    it("should notify an error with the authorization URL and still complete via paste-back when browserOpen throws or rejects", async () => {
      // Arrange
      const { mkdir, writeFile } = await import("node:fs/promises");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-browser-fail-"));
      const mock = await createMockOAuthMcpServer();
      const commands = new Map<string, any>();
      const events = new Map<string, any>();
      const notifications: Array<{ message: string; type?: string }> = [];
      let capturedAuthUrl: URL | undefined;
      const ctx: any = {
        cwd: dir,
        hasUI: true,
        ui: {
          notify: (message: string, type?: string) => notifications.push({ message, ...(type ? { type } : {}) }),
          select: async () => authPasteOption,
          input: async () => {
            assert.ok(capturedAuthUrl);
            const state = capturedAuthUrl.searchParams.get("state")!;
            const redirectUri = capturedAuthUrl.searchParams.get("redirect_uri")!;
            return `${redirectUri}?code=headless-code&state=${encodeURIComponent(state)}`;
          },
        },
      };

      try {
        await mkdir(join(dir, ".pi"));
        await writeFile(
          join(dir, ".pi", "mcp.json"),
          JSON.stringify({
            settings: { maxRetries: 0 },
            mcpServers: {
              headless: {
                lifecycle: "lazy",
                transport: "streamable-http",
                url: `${mock.base}/mcp`,
                auth: { type: "oauth", clientId: "headless-client", redirectUrl: mock.redirectUrl },
              },
            },
          }),
        );

        await extension(
          {
            registerTool: () => {},
            registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
            on: (name: string, handler: any) => events.set(name, handler),
            getActiveTools: () => [],
            setActiveTools: () => {},
          } as any,
          {
            bootstrapCwd: dir,
            globalConfigPath: join(dir, "no-global.json"),
            authStorageDir: join(dir, "auth"),
            browserOpen: async (url: string) => {
              capturedAuthUrl = new URL(url);
              throw new Error("spawn xdg-open ENOENT");
            },
          },
        );
        await events.get("session_start")({}, ctx);

        // Act
        await commands.get("mcp:auth").handler("headless", ctx);

        // Assert
        assert.ok(
          notifications.some(
            (n) =>
              n.type === "error" &&
              n.message.includes("Failed to open browser for headless (spawn xdg-open ENOENT)") &&
              n.message.includes(authPasteOption),
          ),
          "Expected error notification with authorization URL and Paste redirect URL hint when browserOpen fails",
        );
        assert.ok(
          notifications.some((n) => n.type === "info" && n.message.includes("pi-mcp: headless ready")),
          "Expected flow to stay pending and complete via Paste redirect URL after browser launch failure",
        );
      } finally {
        await events.get("session_shutdown")?.({}, ctx);
        await mock.close();
        await rm(dir, { recursive: true, force: true });
      }
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

      const statusBefore = await getAuthStatus(testServerName, testStorage);
      assert.ok(statusBefore?.hasTokens, "Auth status should show tokens before reset");

      // Reset auth
      await resetAuth(testServerName, testStorage);

      // Verify the state is gone by checking auth status
      const statusAfter = await getAuthStatus(testServerName, testStorage);
      assert.strictEqual(statusAfter, null, "Auth status should be null after reset");

      // Verify tokens are gone
      const tokensAfter = await provider.tokens();
      assert.strictEqual(tokensAfter, undefined, "Tokens should not exist after reset");
    });

    it("should surface EACCES when resetting auth in a read-only directory on POSIX", async (t) => {
      if (process.platform === "win32" || process.getuid?.() === 0) {
        t.skip("POSIX non-root directory permission semantics required");
        return;
      }

      // Arrange
      const { chmod } = await import("node:fs/promises");
      const { resetAuth } = await import("../src/oauth-provider.js");
      const roStorage = await mkdtemp(join(tmpdir(), "pi-mcp-oauth-ro-"));
      const roProvider = new McpOAuthProvider(testServerName, {}, undefined, roStorage);
      await roProvider.saveTokens({
        access_token: "test-token",
        token_type: "Bearer",
      });
      await chmod(roStorage, 0o500);

      try {
        // Act & Assert
        await assert.rejects(
          () => resetAuth(testServerName, roStorage),
          (err: NodeJS.ErrnoException) => err.code === "EACCES" || err.code === "EPERM",
        );
      } finally {
        await chmod(roStorage, 0o700);
        await rm(roStorage, { recursive: true, force: true });
      }
    });
  });
});
