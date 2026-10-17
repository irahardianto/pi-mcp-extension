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
import { AuthRequiredError, McpOAuthProvider } from "../src/oauth-provider.js";
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
import extension, {
  AuthCancelledError,
  authCancelOption,
  authPasteOption,
  authRetryOption,
  browserOpenCommand,
  startupAuthLaterOption,
  startupAuthNowOption,
  waitForOAuthCallback,
} from "../src/index.js";
import { startFakeOAuthServer } from "./helpers/fake-oauth-server.js";

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

    it("should reject error=access_denied with invalid_state when expectedState is a predicate function and return HTTP 400 from callback server (Issue 24.4)", async () => {
      // Arrange
      const input =
        "http://127.0.0.1:19876/callback?error=access_denied&error_description=User%20rejected%20request&state=wrong-state";

      // Act & Assert (pure parseCallbackUrl)
      assert.throws(
        () =>
          parseCallbackUrl(input, {
            redirectUrl: "http://127.0.0.1:19876/callback",
            expectedState: (state) => state === "expected-state",
          }),
        (err: unknown) =>
          err instanceof CallbackUrlValidationError &&
          err.reason === "invalid_state" &&
          /Invalid or expired state parameter/.test(err.message),
      );

      // Act & Assert (callback HTTP server integration)
      await stopCallbackServer().catch(() => {});
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      const addr = probe.address();
      assert.ok(addr && typeof addr === "object");
      await new Promise<void>((resolve) => probe.close(() => resolve()));

      const port = await ensureCallbackServer(addr.port, { host: "127.0.0.1", allowPortFallback: false });
      try {
        const res = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=wrong-state`);
        assert.strictEqual(res.status, 400);
      } finally {
        await stopCallbackServer().catch(() => {});
      }
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

  describe("Startup OAuth Offer, Silent DCR Guard, and Real HTTP OAuth Fixture (Issue #7, N1, N8)", () => {
    it("should throw AuthRequiredError when clientInformation is called on a silent provider without clientId or stored clientInfo", async () => {
      // Arrange
      const silentProvider = new McpOAuthProvider(testServerName, {}, undefined, testStorage, true);

      // Act & Assert
      await assert.rejects(
        () => silentProvider.clientInformation(),
        AuthRequiredError,
      );
    });

    it("should not retry, launch a browser, or trigger DCR on session_start and should remember Not now for the session when an eager OAuth server has no client info or has an expired token with failing refresh", async () => {
      // Arrange
      const { mkdir, writeFile } = await import("node:fs/promises");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issue7-decline-"));
      const authDir = join(dir, "auth");
      const fakeServer = await startFakeOAuthServer({
        serverName: "eager-oauth",
        failRefresh: true,
      });

      const tools = new Map<string, any>();
      const commands = new Map<string, any>();
      const events = new Map<string, any>();
      const notifications: Array<{ message: string; type?: string }> = [];
      const selectPrompts: string[] = [];
      const statuses: Array<{ key: string; value: string | undefined }> = [];

      const pi = {
        registerTool: (tool: any) => tools.set(tool.name, tool),
        registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
        on: (name: string, handler: any) => events.set(name, handler),
        getActiveTools: () => [],
        setActiveTools: () => {},
      };

      const ctx: any = {
        cwd: dir,
        hasUI: true,
        ui: {
          notify: (message: string, type?: string) => {
            notifications.push({ message, ...(type ? { type } : {}) });
          },
          select: async (title: string) => {
            selectPrompts.push(title);
            return startupAuthLaterOption;
          },
          setStatus: (key: string, value: string | undefined) => {
            statuses.push({ key, value });
          },
        },
      };

      try {
        await mkdir(join(dir, ".pi"));
        await writeFile(
          join(dir, ".pi", "mcp.json"),
          JSON.stringify({
            settings: { maxRetries: 2 },
            mcpServers: {
              "eager-oauth": {
                lifecycle: "eager",
                transport: "streamable-http",
                url: fakeServer.mcpUrl,
                auth: { type: "oauth" },
              },
            },
          }),
        );

        await extension(pi as any, {
          bootstrapCwd: dir,
          globalConfigPath: join(dir, "no-global.json"),
          authStorageDir: authDir,
          browserOpen: fakeServer.browserOpen,
        });

        // Act (Part 1: No stored client info — silent startup must hit N1 guard before DCR)
        await events.get("session_start")({}, ctx);

        // Assert (Part 1)
        assert.strictEqual(fakeServer.dcrCount, 0, "Silent startup must never trigger Dynamic Client Registration");
        assert.strictEqual(fakeServer.browserOpenCount, 0, "Silent startup must not open a browser when Not now is chosen");
        assert.deepStrictEqual(selectPrompts, ["eager-oauth needs authorization"]);
        assert.deepStrictEqual(statuses.at(-1), { key: "pi-mcp", value: "run /mcp:auth eager-oauth" });
        await commands.get("mcp").handler("eager-oauth", ctx);
        const detailAfterNoClient = notifications.at(-1)?.message ?? "";
        assert.match(detailAfterNoClient, /State:\s+stopped/);
        assert.match(detailAfterNoClient, /Retries:\s+0/);

        // Act (Part 2: Seed clientInfo + expired token with failing refresh, and verify session remembers decline without re-prompting)
        const seededProvider = new McpOAuthProvider("eager-oauth", { type: "oauth" }, undefined, authDir);
        await seededProvider.saveClientInformation({ client_id: "seeded-client" });
        await seededProvider.saveTokens({
          access_token: "expired-access-token",
          refresh_token: "expired-refresh-token",
          token_type: "Bearer",
        });
        await events.get("session_start")({}, ctx);

        // Assert (Part 2: Declined server is not prompted again during the same session)
        assert.strictEqual(selectPrompts.length, 1, "Declined server must not re-prompt on subsequent session_start with unchanged config");
        assert.strictEqual(fakeServer.refreshCount, 1, "Silent startup should attempt refresh once with stored clientInfo + refresh_token");
        assert.strictEqual(fakeServer.dcrCount, 0, "Failed refresh must not trigger DCR");
        assert.strictEqual(fakeServer.browserOpenCount, 0, "Failed refresh must not open a browser");
        assert.deepStrictEqual(statuses.at(-1), { key: "pi-mcp", value: "run /mcp:auth eager-oauth" });

        // Act (Part 3: Headless session_start notifies cleanly without duplicate AuthRequiredError: prefix)
        notifications.length = 0;
        await events.get("session_start")({}, { ...ctx, hasUI: false });

        // Assert (Part 3)
        const errorNotification = notifications.find((n) => n.type === "error");
        assert.ok(errorNotification, "Expected error notification when hasUI is false");
        assert.doesNotMatch(errorNotification.message, /AuthRequiredError:/);
        assert.match(errorNotification.message, /^pi-mcp: Failed to start eager-oauth — Authorization required for eager-oauth/);
      } finally {
        await events.get("session_shutdown")?.({}, ctx);
        await fakeServer.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should complete full OAuth flow with single DCR registration, persist tokens, and activate tools when user chooses Authorize now at the startup prompt", async () => {
      // Arrange
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { getAuthStatus } = await import("../src/oauth-provider.js");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issue7-authnow-"));
      const authDir = join(dir, "auth");
      const fakeServer = await startFakeOAuthServer({
        serverName: "eager-dcr",
        toolName: "oauth_echo",
      });

      const tools = new Map<string, any>();
      const commands = new Map<string, any>();
      const events = new Map<string, any>();
      let activeTools: string[] = [];
      const selectPrompts: string[] = [];

      const pi = {
        registerTool: (tool: any) => tools.set(tool.name, tool),
        registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
        on: (name: string, handler: any) => events.set(name, handler),
        getActiveTools: () => activeTools,
        setActiveTools: (names: string[]) => {
          activeTools = names;
        },
      };

      const ctx: any = {
        cwd: dir,
        hasUI: true,
        ui: {
          notify: () => {},
          select: async (title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
            selectPrompts.push(title);
            if (title === "eager-dcr needs authorization") {
              return startupAuthNowOption;
            }
            return new Promise<string | undefined>((resolve) => {
              opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
            });
          },
          setStatus: () => {},
        },
      };

      try {
        await mkdir(join(dir, ".pi"));
        await writeFile(
          join(dir, ".pi", "mcp.json"),
          JSON.stringify({
            settings: { maxRetries: 2 },
            mcpServers: {
              "eager-dcr": {
                lifecycle: "eager",
                transport: "streamable-http",
                url: fakeServer.mcpUrl,
                auth: { type: "oauth" },
              },
            },
          }),
        );

        await extension(pi as any, {
          bootstrapCwd: dir,
          globalConfigPath: join(dir, "no-global.json"),
          authStorageDir: authDir,
          browserOpen: fakeServer.browserOpen,
        });

        // Act
        await events.get("session_start")({}, ctx);
        for (let i = 0; i < 200 && !activeTools.some((name) => name.includes("oauth_echo")); i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        // Assert
        assert.ok(selectPrompts.includes("eager-dcr needs authorization"));
        assert.strictEqual(fakeServer.dcrCount, 1, "Expected exactly 1 Dynamic Client Registration during interactive Authorize now");
        assert.strictEqual(fakeServer.browserOpenCount, 1, "Expected browserOpen to be called once");
        assert.strictEqual(fakeServer.codeExchangeCount, 1, "Expected authorization code to be exchanged once");

        const authStatus = await getAuthStatus("eager-dcr", authDir);
        assert.strictEqual(authStatus?.hasClientInfo, true);
        assert.strictEqual(authStatus?.hasTokens, true);

        const statusResult = await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx);
        const statusRows = JSON.parse(statusResult.content[0].text);
        assert.strictEqual(statusRows[0].state, "ready");
        assert.deepStrictEqual(statusRows[0].tools, { discovered: 1, active: 1 });
        assert.ok(activeTools.some((name) => name.includes("oauth_echo")));
      } finally {
        await events.get("session_shutdown")?.({}, ctx);
        await fakeServer.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should show the second eager server startup prompt only after the first eager server prompt and authorization complete when two eager OAuth servers require authorization", async () => {
      // Arrange
      const { mkdir, writeFile } = await import("node:fs/promises");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issue7-sequential-"));
      const authDir = join(dir, "auth");
      const fakeServer1 = await startFakeOAuthServer({
        serverName: "alpha",
        toolName: "alpha_echo",
      });
      const fakeServer2 = await startFakeOAuthServer({
        serverName: "beta",
        toolName: "beta_echo",
      });

      const tools = new Map<string, any>();
      const events = new Map<string, any>();
      let activeTools: string[] = [];
      const timeline: string[] = [];

      let releaseFirstPrompt!: (choice: string) => void;
      const firstPromptShown = new Promise<void>((resolve) => {
        // resolved when alpha prompt appears
        releaseFirstPrompt = (choice: string) => {
          firstChoiceResolve(choice);
        };
        void resolve;
      });
      let markFirstPromptShown!: () => void;
      const firstPromptVisible = new Promise<void>((resolve) => {
        markFirstPromptShown = resolve;
      });
      let firstChoiceResolve!: (choice: string) => void;
      const firstChoicePromise = new Promise<string>((resolve) => {
        firstChoiceResolve = resolve;
      });
      void firstPromptShown;

      let markSecondPromptShown!: () => void;
      const secondPromptVisible = new Promise<void>((resolve) => {
        markSecondPromptShown = resolve;
      });

      const pi = {
        registerTool: (tool: any) => tools.set(tool.name, tool),
        registerCommand: () => {},
        on: (name: string, handler: any) => events.set(name, handler),
        getActiveTools: () => activeTools,
        setActiveTools: (names: string[]) => {
          activeTools = names;
          if (names.some((n) => n.includes("alpha_echo")) && !timeline.includes("alpha:tools_active")) {
            timeline.push("alpha:tools_active");
          }
        },
      };

      const ctx: any = {
        cwd: dir,
        hasUI: true,
        ui: {
          notify: () => {},
          select: async (title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
            if (title === "alpha needs authorization") {
              timeline.push("alpha:prompt");
              markFirstPromptShown();
              return await firstChoicePromise;
            }
            if (title === "beta needs authorization") {
              timeline.push("beta:prompt");
              markSecondPromptShown();
              return startupAuthLaterOption;
            }
            return new Promise<string | undefined>((resolve) => {
              opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
            });
          },
          setStatus: () => {},
        },
      };

      try {
        await mkdir(join(dir, ".pi"));
        await writeFile(
          join(dir, ".pi", "mcp.json"),
          JSON.stringify({
            settings: { maxRetries: 0 },
            mcpServers: {
              alpha: {
                lifecycle: "eager",
                transport: "streamable-http",
                url: fakeServer1.mcpUrl,
                auth: { type: "oauth" },
              },
              beta: {
                lifecycle: "eager",
                transport: "streamable-http",
                url: fakeServer2.mcpUrl,
                auth: { type: "oauth" },
              },
            },
          }),
        );

        await extension(pi as any, {
          bootstrapCwd: dir,
          globalConfigPath: join(dir, "no-global.json"),
          authStorageDir: authDir,
          browserOpen: async (url: string) => {
            timeline.push("alpha:browser_open");
            await fakeServer1.browserOpen(url);
          },
        });

        // Act
        await events.get("session_start")({}, ctx);
        await firstPromptVisible;

        // Assert that beta has NOT prompted while alpha's prompt is still waiting
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.deepStrictEqual(timeline, ["alpha:prompt"], "Second server must not prompt while first server prompt is open");

        // Now choose Authorize now for alpha and wait for beta's prompt
        releaseFirstPrompt(startupAuthNowOption);
        await secondPromptVisible;

        // Assert that alpha completed browser open and tool activation BEFORE beta's prompt appeared
        assert.deepStrictEqual(timeline, [
          "alpha:prompt",
          "alpha:browser_open",
          "alpha:tools_active",
          "beta:prompt",
        ]);
      } finally {
        await events.get("session_shutdown")?.({}, ctx);
        await fakeServer1.close();
        await fakeServer2.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should complete /mcp:auth and silently refresh with token rotation on reconnect without opening a browser or performing DCR again when the access token expires", async () => {
      // Arrange
      const { mkdir, writeFile } = await import("node:fs/promises");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-n8-refresh-"));
      const authDir = join(dir, "auth");
      const fakeServer = await startFakeOAuthServer({
        serverName: "rotatable",
        toolName: "oauth_echo",
      });

      const tools = new Map<string, any>();
      const commands = new Map<string, any>();
      const events = new Map<string, any>();
      let activeTools: string[] = [];

      const pi = {
        registerTool: (tool: any) => tools.set(tool.name, tool),
        registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
        on: (name: string, handler: any) => events.set(name, handler),
        getActiveTools: () => activeTools,
        setActiveTools: (names: string[]) => {
          activeTools = names;
        },
      };

      const ctx: any = {
        cwd: dir,
        hasUI: true,
        ui: {
          notify: () => {},
          select: async (_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
            new Promise<string | undefined>((resolve) => {
              opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
            }),
          setStatus: () => {},
        },
      };

      try {
        await mkdir(join(dir, ".pi"));
        await writeFile(
          join(dir, ".pi", "mcp.json"),
          JSON.stringify({
            settings: { maxRetries: 0 },
            mcpServers: {
              rotatable: {
                lifecycle: "lazy",
                transport: "streamable-http",
                url: fakeServer.mcpUrl,
                auth: { type: "oauth" },
              },
            },
          }),
        );

        await extension(pi as any, {
          bootstrapCwd: dir,
          globalConfigPath: join(dir, "no-global.json"),
          authStorageDir: authDir,
          browserOpen: fakeServer.browserOpen,
        });
        await events.get("session_start")({}, ctx);

        // Act (Step 1: Interactive /mcp:auth)
        await commands.get("mcp:auth").handler("rotatable", ctx);

        // Assert (Step 1)
        assert.strictEqual(fakeServer.dcrCount, 1);
        assert.strictEqual(fakeServer.browserOpenCount, 1);
        assert.strictEqual(fakeServer.codeExchangeCount, 1);
        assert.strictEqual(fakeServer.refreshCount, 0);

        const inspectProvider = new McpOAuthProvider("rotatable", { type: "oauth" }, undefined, authDir);
        const initialTokens = await inspectProvider.tokens();
        assert.strictEqual(initialTokens?.access_token, "access-token-1");
        assert.strictEqual(initialTokens?.refresh_token, "refresh-token-1");

        // Act (Step 2: Stop server, expire access token on fake OAuth server, and reconnect silently via /mcp:start)
        await commands.get("mcp:stop").handler("rotatable", ctx);
        fakeServer.expireAccessTokens();
        await commands.get("mcp:start").handler("rotatable", ctx);

        // Assert (Step 2: Silent refresh succeeded and rotated tokens on disk without opening browser or calling DCR)
        assert.strictEqual(fakeServer.dcrCount, 1, "Reconnect must reuse stored client_id and not call DCR again");
        assert.strictEqual(fakeServer.browserOpenCount, 1, "Silent refresh must not open a browser");
        assert.strictEqual(fakeServer.refreshCount, 1, "Expected 1 refresh_token grant request");

        const rotatedTokens = await inspectProvider.tokens();
        assert.strictEqual(rotatedTokens?.access_token, "access-token-2");
        assert.strictEqual(rotatedTokens?.refresh_token, "refresh-token-2");
        assert.ok(activeTools.some((name) => name.includes("oauth_echo")));
      } finally {
        await events.get("session_shutdown")?.({}, ctx);
        await fakeServer.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("Origin-Bound OAuth State, DCR Persistence, and Re-Auth Edge Cases (Issues #22, #23)", () => {
    it("should canonicalize server URLs and isolate stored OAuth state across different server origins and paths (Issue 22.1)", async () => {
      const oauthMod = (await import("../src/oauth-provider.js")) as any;
      assert.strictEqual(typeof oauthMod.canonicalServerUrl, "function");
      assert.strictEqual(typeof oauthMod.urlsMatch, "function");
      assert.strictEqual(oauthMod.canonicalServerUrl("https://example.com/mcp///"), "https://example.com/mcp");
      assert.strictEqual(oauthMod.canonicalServerUrl("https://example.com/"), "https://example.com/");
      assert.strictEqual(oauthMod.urlsMatch("https://example.com/mcp/", "https://example.com/mcp"), true);
      assert.strictEqual(oauthMod.urlsMatch("https://example.com/mcp", "https://evil.example.com/mcp"), false);

      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-origin-bound-"));
      try {
        const globalUrl = "https://global.example.com/mcp/";
        const evilUrl = "https://evil.example.com/mcp";

        const globalProvider = new McpOAuthProvider(
          "shared-name",
          { type: "oauth" },
          undefined,
          dir,
          false,
          () => false,
          undefined,
          globalUrl,
        );
        await globalProvider.saveClientInformation({ client_id: "global-client" });
        await globalProvider.saveTokens({ access_token: "global-secret-token", token_type: "Bearer" });
        await globalProvider.saveDiscoveryState({
          authorizationServerUrl: "https://global.example.com",
          resourceMetadata: {
            resource: "https://global.example.com/mcp",
            authorization_servers: ["https://global.example.com"],
          } as any,
        });

        // Same URL (ignoring trailing slash) sees stored state
        const sameOriginProvider = new McpOAuthProvider(
          "shared-name",
          { type: "oauth" },
          undefined,
          dir,
          false,
          () => false,
          undefined,
          "https://global.example.com/mcp",
        );
        assert.strictEqual((await sameOriginProvider.tokens())?.access_token, "global-secret-token");
        assert.strictEqual((await sameOriginProvider.clientInformation())?.client_id, "global-client");
        assert.strictEqual((await oauthMod.getAuthStatus("shared-name", dir, "https://global.example.com/mcp"))?.hasTokens, true);

        // Different URL with same serverName must NOT read global tokens, clientInfo, or discoveryState
        const evilProvider = new McpOAuthProvider(
          "shared-name",
          { type: "oauth" },
          undefined,
          dir,
          false,
          () => false,
          undefined,
          evilUrl,
        );
        assert.strictEqual(await evilProvider.tokens(), undefined);
        assert.strictEqual(await evilProvider.clientInformation(), undefined);
        assert.strictEqual(await evilProvider.discoveryState(), undefined);
        assert.strictEqual(await oauthMod.getAuthStatus("shared-name", dir, evilUrl), null);

        // Adversarial: evilProvider calling invalidateCredentials("tokens" | "verifier") must NOT clobber globalProvider's disk state
        await evilProvider.invalidateCredentials("tokens");
        await evilProvider.invalidateCredentials("verifier");
        assert.strictEqual((await sameOriginProvider.tokens())?.access_token, "global-secret-token");
        assert.strictEqual((await sameOriginProvider.clientInformation())?.client_id, "global-client");
        assert.ok(await sameOriginProvider.discoveryState());
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should discard legacy or mismatched discoveryState resourceMetadata when serverUrl does not match resource (Issue 22.1)", async () => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { statePath } = await import("../src/auth-lock.js");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-legacy-disc-"));
      try {
        await mkdir(dir, { recursive: true });
        // Legacy state file without top-level serverUrl, bound to old-host in discoveryState
        await writeFile(
          statePath("legacy-srv", dir),
          JSON.stringify({
            clientInfo: { client_id: "legacy-client" },
            tokens: { access_token: "legacy-token", token_type: "Bearer" },
            discoveryState: {
              authorizationServerUrl: "https://old-host.example.com",
              resourceMetadata: {
                resource: "https://old-host.example.com/mcp",
                authorization_servers: ["https://old-host.example.com"],
              },
            },
          }),
          "utf8",
        );

        const newUrlProvider = new McpOAuthProvider(
          "legacy-srv",
          { type: "oauth" },
          undefined,
          dir,
          false,
          () => false,
          undefined,
          "https://new-host.example.com/mcp",
        );
        assert.strictEqual(await newUrlProvider.tokens(), undefined);
        assert.strictEqual(await newUrlProvider.clientInformation(), undefined);
        assert.strictEqual(await newUrlProvider.discoveryState(), undefined);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should preserve DCR metadata fields and invalidate expired client_secret or changed redirect_uris (Issue 22.2)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-dcr-meta-"));
      try {
        const p1 = new McpOAuthProvider(
          "dcr-srv",
          { type: "oauth", redirectUrl: "http://127.0.0.1:19876/callback" },
          undefined,
          dir,
        );
        const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
        await p1.saveClientInformation({
          client_id: "dcr-1",
          client_secret: "secret-1",
          client_id_issued_at: 1700000000,
          client_secret_expires_at: futureExpiry,
          token_endpoint_auth_method: "client_secret_post",
          redirect_uris: ["http://127.0.0.1:19876/callback"],
        } as any);

        const loaded = (await p1.clientInformation()) as any;
        assert.strictEqual(loaded?.client_id, "dcr-1");
        assert.strictEqual(loaded?.client_secret, "secret-1");
        assert.strictEqual(loaded?.client_id_issued_at, 1700000000);
        assert.strictEqual(loaded?.client_secret_expires_at, futureExpiry);
        assert.strictEqual(loaded?.token_endpoint_auth_method, "client_secret_post");
        assert.deepStrictEqual(loaded?.redirect_uris, ["http://127.0.0.1:19876/callback"]);

        // Interactive provider with a different redirectUrl (e.g. fallback port) returns undefined to trigger fresh DCR
        const pChangedRedirect = new McpOAuthProvider(
          "dcr-srv",
          { type: "oauth", redirectUrl: "http://127.0.0.1:19877/callback" },
          undefined,
          dir,
          false,
        );
        assert.strictEqual(await pChangedRedirect.clientInformation(), undefined);

        // Expired client_secret: returns undefined in interactive mode, throws AuthRequiredError in silent mode
        const pastExpiry = Math.floor(Date.now() / 1000) - 60;
        await p1.saveClientInformation({
          client_id: "dcr-expired",
          client_secret: "secret-expired",
          client_secret_expires_at: pastExpiry,
        } as any);
        assert.strictEqual(await p1.clientInformation(), undefined);

        const pSilent = new McpOAuthProvider("dcr-srv", { type: "oauth" }, undefined, dir, true);
        await assert.rejects(() => pSilent.clientInformation(), AuthRequiredError);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should classify 401, 403 insufficient_scope, and wrapped protocol errors accurately without false-positiving on unrelated 401 substrings (Issues 23.3, 23.4)", async () => {
      const { isOAuthUnauthorizedError } = await import("../src/server-manager.js");
      const { McpError } = await import("../src/errors.js");

      // True positives
      assert.strictEqual(isOAuthUnauthorizedError(new AuthRequiredError("srv")), true);
      assert.strictEqual(isOAuthUnauthorizedError(Object.assign(new Error("Streamable HTTP error"), { code: 401 })), true);
      assert.strictEqual(
        isOAuthUnauthorizedError(
          Object.assign(new Error("Streamable HTTP error: Server returned 403 after trying upscoping"), { code: 403 }),
        ),
        true,
      );
      assert.strictEqual(isOAuthUnauthorizedError(new Error("Error POSTing to endpoint (HTTP 401): Unauthorized")), true);
      assert.strictEqual(isOAuthUnauthorizedError(new Error("Streamable HTTP error: Server returned 401 after successful authentication")), true);
      assert.strictEqual(
        isOAuthUnauthorizedError(Object.assign(new Error("MCP error -32000: HTTP 401 Unauthorized"), { code: -32000 })),
        true,
      );
      assert.strictEqual(isOAuthUnauthorizedError(new Error("HTTP 403 insufficient_scope")), true);
      assert.strictEqual(
        isOAuthUnauthorizedError(
          new McpError(
            "Failed to list tools from srv: Streamable HTTP error: Server returned 401",
            "srv",
            "protocol",
            Object.assign(new Error("Server returned 401"), { code: 401 }),
          ),
        ),
        true,
      );

      // False positives that MUST return false
      assert.strictEqual(isOAuthUnauthorizedError(new McpError("401 Unauthorized from tool output", "srv", "tool")), false);
      assert.strictEqual(
        isOAuthUnauthorizedError(Object.assign(new Error("Error POSTing to endpoint: worker 401 failed"), { code: 500 })),
        false,
      );
      assert.strictEqual(
        isOAuthUnauthorizedError(Object.assign(new Error("Error POSTing to endpoint: Forbidden"), { code: 403 })),
        false,
      );
      assert.strictEqual(isOAuthUnauthorizedError(new Error("Error POSTing to endpoint (HTTP 500): node 401 error")), false);
      assert.strictEqual(isOAuthUnauthorizedError(new Error("HTTP 502 Bad Gateway from backend-401")), false);
      assert.strictEqual(isOAuthUnauthorizedError(new Error("Request 401 timed out after 30000ms")), false);

      // Cyclic cause chain must terminate and return false
      const cycA: any = new Error("outer");
      const cycB: any = new Error("inner");
      cycA.cause = cycB;
      cycB.cause = cycA;
      assert.strictEqual(isOAuthUnauthorizedError(cycA), false);
    });

    it("should fall back to POST on 405 in discoverManualAuthChallenge and forward custom headers via createHeadersFetch (Issue 23.5)", async () => {
      const challengeMod = (await import("../src/auth-challenge.js")) as any;
      assert.strictEqual(typeof challengeMod.createHeadersFetch, "function");

      const seenMethods: string[] = [];
      const seenHeaders: Headers[] = [];
      const challenge = await discoverManualAuthChallenge("https://example.com/mcp", {
        headers: { "X-Custom-Tenant": "acme" },
        fetchFn: async (_url, init) => {
          seenMethods.push(init?.method ?? "GET");
          seenHeaders.push(new Headers(init?.headers));
          if (init?.method === "GET") {
            return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
          }
          return new Response("Unauthorized", {
            status: 401,
            headers: {
              "WWW-Authenticate":
                'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource" scope="mcp:read mcp:write"',
            },
          });
        },
      });

      assert.deepStrictEqual(seenMethods, ["GET", "POST"]);
      assert.strictEqual(seenHeaders[1]?.get("x-custom-tenant"), "acme");
      assert.strictEqual(seenHeaders[1]?.get("content-type"), "application/json");
      assert.strictEqual(
        challenge.resourceMetadataUrl?.toString(),
        "https://example.com/.well-known/oauth-protected-resource",
      );
      assert.strictEqual(challenge.scope, "mcp:read mcp:write");

      // Verify createHeadersFetch merges baseHeaders and lets per-request headers override
      let capturedMerged: Headers | undefined;
      const wrappedFetch = challengeMod.createHeadersFetch(
        { "X-Base": "1", "X-Override": "base" },
        async (_input: any, init?: RequestInit) => {
          capturedMerged = new Headers(init?.headers);
          return new Response("ok", { status: 200 });
        },
      );
      await wrappedFetch("https://example.com/token", { headers: { "X-Override": "request" } });
      assert.strictEqual(capturedMerged?.get("x-base"), "1");
      assert.strictEqual(capturedMerged?.get("x-override"), "request");
    });

    it("should invalidate rejected tokens and open browser when AS refresh succeeds but resource server still returns 401, and recover from mid-session 401 on tool execution (Issues 23.1, 23.2)", async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issue23-reauth-"));
      const authDir = join(dir, "auth");
      let base = "";
      let refreshGrantCount = 0;
      let rejectRefreshedTokenOnMcp = true;
      let expireInteractiveTokenMidSession = false;

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
              authorization_endpoint: `${base}/authorize`,
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
          req.on("data", (chunk) => { body += chunk.toString(); });
          req.on("end", () => {
            const params = new URLSearchParams(body);
            res.setHeader("content-type", "application/json");
            if (params.get("grant_type") === "refresh_token") {
              refreshGrantCount++;
              // AS ALWAYS succeeds on refresh_token (even if called multiple times!), issuing a token that the resource server rejects when rejectRefreshedTokenOnMcp is true
              res.end(
                JSON.stringify({
                  access_token: "as-refreshed-but-rs-rejected",
                  refresh_token: "refresh-still-valid-at-as",
                  token_type: "Bearer",
                }),
              );
            } else {
              res.end(
                JSON.stringify({
                  access_token: "fresh-browser-token",
                  refresh_token: "refresh-still-valid-at-as",
                  token_type: "Bearer",
                }),
              );
            }
          });
          return;
        }
        if (req.url === "/mcp") {
          if (req.method === "GET") {
            res.writeHead(405, { Allow: "POST" });
            res.end();
            return;
          }
          const authHeader = req.headers.authorization;
          const validToken =
            authHeader === "Bearer fresh-browser-token" && !expireInteractiveTokenMidSession
              ? true
              : authHeader === "Bearer as-refreshed-but-rs-rejected" && !rejectRefreshedTokenOnMcp;
          if (!validToken) {
            res.writeHead(401, { "WWW-Authenticate": "Bearer" });
            res.end("Unauthorized");
            return;
          }
          let body = "";
          req.on("data", (chunk) => { body += chunk.toString(); });
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
                    serverInfo: { name: "reauth-srv", version: "1.0.0" },
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
                        name: "protected_action",
                        description: "Protected action",
                        inputSchema: { type: "object", properties: {} },
                      },
                    ],
                  },
                }),
              );
            } else if (msg.method === "tools/call") {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: { content: [{ type: "text", text: "ok" }] },
                }),
              );
            }
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const address = listener.address();
      assert.ok(address && typeof address === "object");
      base = `http://127.0.0.1:${address.port}`;

      const tools = new Map<string, any>();
      const events = new Map<string, any>();
      let activeTools: string[] = [];
      let browserOpenCalls = 0;

      const pi = {
        registerTool: (tool: any) => tools.set(tool.name, tool),
        registerCommand: () => {},
        on: (name: string, handler: any) => events.set(name, handler),
        getActiveTools: () => activeTools,
        setActiveTools: (names: string[]) => { activeTools = names; },
      };
      const ctx: any = {
        cwd: dir,
        hasUI: true,
        ui: {
          notify: () => {},
          select: (_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
            new Promise<string | undefined>((resolve) => {
              opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
            }),
        },
      };

      try {
        await mkdir(join(dir, ".pi"));
        await writeFile(
          join(dir, ".pi", "mcp.json"),
          JSON.stringify({
            settings: { maxRetries: 0 },
            mcpServers: {
              reauth: {
                lifecycle: "lazy",
                transport: "streamable-http",
                url: `${base}/mcp`,
                auth: { type: "oauth", clientId: "reauth-client" },
              },
            },
          }),
        );

        // Seed initial expired token + refresh token that AS accepts but RS rejects
        const seeder = new McpOAuthProvider(
          "reauth",
          { type: "oauth", clientId: "reauth-client" },
          undefined,
          authDir,
          false,
          () => false,
          undefined,
          `${base}/mcp`,
        );
        await seeder.saveTokens({
          access_token: "initial-expired",
          refresh_token: "refresh-still-valid-at-as",
          token_type: "Bearer",
        });

        await extension(pi as any, {
          bootstrapCwd: dir,
          globalConfigPath: join(dir, "no-global.json"),
          authStorageDir: authDir,
          browserOpen: (url: string) => {
            browserOpenCalls++;
            const authUrl = new URL(url);
            const state = authUrl.searchParams.get("state")!;
            const redirectUri = authUrl.searchParams.get("redirect_uri")!;
            void fetch(`${redirectUri}?code=browser-code-${browserOpenCalls}&state=${encodeURIComponent(state)}`);
          },
        });
        await events.get("session_start")({}, ctx);

        // Act (Part 1 — Issue 23.1: mcp_connect must invalidate rejected tokens after silent refresh 401 and open the browser)
        await tools.get("mcp_connect").execute("", { name: "reauth" }, undefined, undefined, ctx);

        // Assert (Part 1)
        assert.strictEqual(browserOpenCalls, 1, "authorize() must open browser instead of silently refreshing again");
        assert.ok(activeTools.includes("mcp_reauth_protected_action"));

        // Act (Part 2 — Issue 23.2: Mid-session 401 during tool call transitions server to stopped + AuthRequiredError and deactivates tools)
        expireInteractiveTokenMidSession = true;
        await assert.rejects(() =>
          tools.get("mcp_reauth_protected_action").execute("", {}, undefined, undefined, ctx),
        );

        // Assert (Part 2: tools deactivated and mcp_status reports Authorization required)
        assert.strictEqual(activeTools.includes("mcp_reauth_protected_action"), false);
        const statusRes = await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx);
        const statusRows = JSON.parse(statusRes.content[0].text);
        assert.strictEqual(statusRows[0].state, "stopped");
        assert.strictEqual(statusRows[0].auth, "authorization may be required");
        assert.match(statusRows[0].error, /Authorization required/);
      } finally {
        await events.get("session_shutdown")?.({}, ctx);
        listener.closeAllConnections();
        await new Promise<void>((resolve) => listener.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should hand off active startup prompt authQueue turn to /mcp:auth, cancel queued startup prompts on /mcp:stop, deduplicate prompts across session_start, and sync declined status bar (Issues 24.2, 24.3)", async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issue24-3-"));
      const authDir = join(dir, "auth");
      const fakeAlpha = await startFakeOAuthServer({ serverName: "alpha", toolName: "alpha_echo" });
      const fakeBeta = await startFakeOAuthServer({ serverName: "beta", toolName: "beta_echo" });
      const fakeGamma = await startFakeOAuthServer({ serverName: "gamma", toolName: "gamma_echo" });

      const tools = new Map<string, any>();
      const commands = new Map<string, any>();
      const events = new Map<string, any>();
      let activeTools: string[] = [];
      const timeline: string[] = [];
      const statuses: Array<string | undefined> = [];

      let markAlphaPromptOpen!: () => void;
      const alphaPromptOpen = new Promise<void>((resolve) => {
        markAlphaPromptOpen = resolve;
      });
      let markGammaPromptOpen!: () => void;
      const gammaPromptOpen = new Promise<void>((resolve) => {
        markGammaPromptOpen = resolve;
      });
      let resolveGammaPrompt!: (choice: string) => void;

      const pi = {
        registerTool: (tool: any) => tools.set(tool.name, tool),
        registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
        on: (name: string, handler: any) => events.set(name, handler),
        getActiveTools: () => activeTools,
        setActiveTools: (names: string[]) => {
          activeTools = names;
          if (names.some((n) => n.includes("alpha_echo")) && !timeline.includes("alpha:tools_active")) {
            timeline.push("alpha:tools_active");
          }
        },
      };

      const ctx: any = {
        cwd: dir,
        hasUI: true,
        ui: {
          notify: () => {},
          setStatus: (_key: string, val?: string) => {
            statuses.push(val);
          },
          select: async (title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
            if (title === "alpha needs authorization") {
              timeline.push("alpha:prompt");
              markAlphaPromptOpen();
              return new Promise<string | undefined>((resolve) => {
                opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
              });
            }
            if (title === "beta needs authorization") {
              timeline.push("beta:prompt");
              return startupAuthLaterOption;
            }
            if (title === "gamma needs authorization") {
              timeline.push("gamma:prompt");
              markGammaPromptOpen();
              return new Promise<string | undefined>((resolve) => {
                resolveGammaPrompt = resolve;
                opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
              });
            }
            return new Promise<string | undefined>((resolve) => {
              opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
            });
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
              alpha: {
                lifecycle: "eager",
                transport: "streamable-http",
                url: fakeAlpha.mcpUrl,
                auth: { type: "oauth" },
              },
              beta: {
                lifecycle: "eager",
                transport: "streamable-http",
                url: fakeBeta.mcpUrl,
                auth: { type: "oauth" },
              },
              gamma: {
                lifecycle: "eager",
                transport: "streamable-http",
                url: fakeGamma.mcpUrl,
                auth: { type: "oauth" },
              },
            },
          }),
        );

        await extension(pi as any, {
          bootstrapCwd: dir,
          globalConfigPath: join(dir, "no-global.json"),
          authStorageDir: authDir,
          browserOpen: async (url: string) => {
            timeline.push("browser_open");
            if (url.startsWith(fakeAlpha.baseUrl)) {
              await fakeAlpha.browserOpen(url);
            } else if (url.startsWith(fakeBeta.baseUrl)) {
              await fakeBeta.browserOpen(url);
            } else {
              await fakeGamma.browserOpen(url);
            }
          },
        });

        await events.get("session_start")({}, ctx);
        await alphaPromptOpen;

        // 1. Trigger a duplicate session_start while alpha's prompt is open and beta/gamma are queued:
        // must NOT enqueue duplicate startup prompts for alpha, beta, or gamma.
        await events.get("session_start")({}, ctx);

        // 2. Cancel beta's queued startup prompt via `/mcp:stop beta` while alpha's prompt is still open
        await commands.get("mcp:stop").handler("beta", ctx);

        // 3. Run `/mcp:auth alpha` while alpha's startup prompt is open:
        // alpha's interactive OAuth must execute IMMEDIATELY inside alpha's current authQueue turn
        // BEFORE gamma's startup prompt opens!
        const authAlphaPromise = commands.get("mcp:auth").handler("alpha", ctx);
        await gammaPromptOpen;
        await authAlphaPromise;

        assert.deepStrictEqual(
          timeline,
          ["alpha:prompt", "browser_open", "alpha:tools_active", "gamma:prompt"],
          "Expected /mcp:auth alpha to complete in alpha's current turn, beta's stopped prompt to be skipped, and gamma's prompt to open only after alpha finishes",
        );

        // 4. Decline gamma, then also decline beta on a fresh session_start to test multi-server declined status bar sync
        resolveGammaPrompt(startupAuthLaterOption);
        for (let i = 0; i < 50 && statuses.at(-1) !== "run /mcp:auth gamma"; i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.strictEqual(statuses.at(-1), "run /mcp:auth gamma");

        // Now trigger session_start again so stopped beta fails silent auth and prompts -> decline beta too
        await events.get("session_start")({}, ctx);
        for (let i = 0; i < 50 && statuses.at(-1) !== "run /mcp:auth beta"; i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.strictEqual(statuses.at(-1), "run /mcp:auth beta");

        // Connect beta via /mcp:auth beta -> status bar must update from beta back to remaining declined server gamma!
        await commands.get("mcp:auth").handler("beta", ctx);
        assert.strictEqual(
          statuses.at(-1),
          "run /mcp:auth gamma",
          "Connecting one declined server must update status bar to remaining declined server",
        );

        // Connect gamma via /mcp:auth gamma -> status bar must clear to undefined!
        await commands.get("mcp:auth").handler("gamma", ctx);
        assert.strictEqual(statuses.at(-1), undefined);
      } finally {
        await events.get("session_shutdown")?.({}, ctx);
        await fakeAlpha.close();
        await fakeBeta.close();
        await fakeGamma.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should forward AbortSignal into discoverManualAuthChallenge and abort authorize() before calling SDK auth() when cancelled during challenge discovery (Issue 24.2)", async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issue24-2-"));
      const authDir = join(dir, "auth");

      let mcpRequests = 0;
      let metadataRequests = 0;
      let browserOpenCount = 0;
      let releaseChallenge!: () => void;
      const challengeGate = new Promise<void>((resolve) => {
        releaseChallenge = resolve;
      });
      let markChallengeEntered!: () => void;
      const challengeEntered = new Promise<void>((resolve) => {
        markChallengeEntered = resolve;
      });

      const listener = createServer(async (req, res) => {
        if (req.url === "/mcp") {
          mcpRequests++;
          // First request is silent startServer() -> 401 immediately so authorize() is entered.
          // Second request is discoverManualAuthChallenge() inside authorize() -> hold until aborted!
          if (mcpRequests >= 2) {
            markChallengeEntered();
            await challengeGate;
          }
          if (!res.destroyed) {
            res.writeHead(401, { "WWW-Authenticate": "Bearer" });
            res.end("Unauthorized");
          }
          return;
        }
        if (req.url?.includes(".well-known") && mcpRequests >= 2) {
          metadataRequests++;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const addr = listener.address();
      assert.ok(addr && typeof addr === "object");

      const tools = new Map<string, any>();
      const events = new Map<string, any>();
      const pi = {
        registerTool: (t: any) => tools.set(t.name, t),
        registerCommand: () => {},
        on: (n: string, h: any) => events.set(n, h),
        getActiveTools: () => [],
        setActiveTools: () => {},
      };
      const ctx: any = {
        cwd: dir,
        hasUI: true,
        ui: {
          notify: () => {},
          select: async () => authCancelOption,
        },
      };

      try {
        await mkdir(join(dir, ".pi"), { recursive: true });
        await writeFile(
          join(dir, ".pi", "mcp.json"),
          JSON.stringify({
            settings: { maxRetries: 0 },
            mcpServers: {
              challengeSrv: {
                lifecycle: "lazy",
                transport: "streamable-http",
                url: `http://127.0.0.1:${addr.port}/mcp`,
                auth: { type: "oauth", clientId: "cid" },
              },
            },
          }),
        );

        await extension(pi as any, {
          bootstrapCwd: dir,
          globalConfigPath: join(dir, "no-global.json"),
          authStorageDir: authDir,
          browserOpen: () => {
            browserOpenCount++;
          },
        });
        await events.get("session_start")({}, ctx);

        const controller = new AbortController();
        const connectPromise = tools
          .get("mcp_connect")
          .execute("", { name: "challengeSrv" }, controller.signal, undefined, ctx);

        await challengeEntered;
        controller.abort();
        releaseChallenge();

        await assert.rejects(connectPromise, /cancelled/i);
        assert.strictEqual(metadataRequests, 0, "SDK auth() metadata discovery must not run after abort during challenge discovery");
        assert.strictEqual(browserOpenCount, 0, "Browser must not open after abort during challenge discovery");
      } finally {
        releaseChallenge();
        await events.get("session_shutdown")?.({}, ctx);
        listener.closeAllConnections();
        await new Promise<void>((resolve) => listener.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});



