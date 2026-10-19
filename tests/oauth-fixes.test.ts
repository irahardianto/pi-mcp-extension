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
import { Agent, createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import {
  CallbackServer,
  callbackServerConfigFromRedirectUrl,
  DEFAULT_PORT,
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
import {
  asExtensionAPI,
  createMockContext,
  createStrictMap,
  type MockCommand,
  type MockTool,
} from "./helpers/mock-extension.js";
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
    provider = new McpOAuthProvider({ serverName: testServerName, authConfig: {}, storageDir: testStorage });
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
      provider = new McpOAuthProvider({ serverName: testServerName, authConfig: { scope: "read write" }, storageDir: testStorage });

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
      // WHY: Windows NTFS does not support POSIX octal file permission bits (0o600/0o700).
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
            reject(init.signal?.reason as unknown);
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
      const callbackServer = new CallbackServer();
      const blocker = createServer();
      await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
      const address = blocker.address();
      assert.ok(address && typeof address === "object");

      try {
        const actualPort = await callbackServer.ensure(address.port);
        assert.ok(actualPort > address.port);
        assert.ok(actualPort <= address.port + 24);
      } finally {
        await callbackServer.stop();
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
      const callbackServer = new CallbackServer();

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
          () => callbackServer.ensure(address.port, { host: "127.0.0.1", allowPortFallback: false }),
          /requires this exact port/,
        );
      } finally {
        await callbackServer.stop();
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });


    it("should rebind from a fallback callback listener to a fixed redirect listener when no auth is pending", async () => {
      const callbackServer = new CallbackServer();

      try {
        const fallbackPreferredPort = await getFreePort();
        const fallbackPort = await callbackServer.ensure(fallbackPreferredPort, { host: "127.0.0.1", allowPortFallback: true });
        assert.strictEqual(fallbackPort, fallbackPreferredPort);

        const fixedPort = await getFreePort();
        const reboundPort = await callbackServer.ensure(fixedPort, { host: "127.0.0.1", allowPortFallback: false });
        assert.strictEqual(reboundPort, fixedPort);
      } finally {
        await callbackServer.stop();
      }
    });

    it("should rebind from a fixed redirect listener to a fallback listener when no auth is pending", async () => {
      const callbackServer = new CallbackServer();

      try {
        const fixedPort = await getFreePort();
        const fixedListenerPort = await callbackServer.ensure(fixedPort, { host: "127.0.0.1", allowPortFallback: false });
        assert.strictEqual(fixedListenerPort, fixedPort);

        const fallbackPreferredPort = await getFreePort();
        const fallbackPort = await callbackServer.ensure(fallbackPreferredPort, { host: "127.0.0.1", allowPortFallback: true });
        assert.strictEqual(fallbackPort, fallbackPreferredPort);
      } finally {
        await callbackServer.stop();
      }
    });


    it("should stop the callback server when a browser keeps the callback socket open", async () => {
      const callbackServer = new CallbackServer();

      const port = await getFreePort();
      const state = "keepalive-state";
      await callbackServer.ensure(port, { host: "127.0.0.1", allowPortFallback: false });
      const callbackPromise = callbackServer.waitForCallback(state);

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
          callbackServer.stop(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("callbackServer.stop() timed out")), 1000)),
        ]);
      } finally {
        agent.destroy();
        await callbackServer.stop();
      }
    });

    it("should return the same port on subsequent calls", async () => {
      const callbackServer = new CallbackServer();

      try {
        const preferredPort = await getFreePort();
        const port1 = await callbackServer.ensure(preferredPort);
        const port2 = await callbackServer.ensure(preferredPort);

        assert.strictEqual(port1, port2, "Subsequent calls should return the same port");
      } finally {
        await callbackServer.stop();
      }
    });

    it("should isolate listeners and pending auth state across separate CallbackServer instances", async () => {
      const serverA = new CallbackServer();
      const serverB = new CallbackServer();

      try {
        const preferredPortA = await getFreePort();
        const preferredPortB = await getFreePort();
        const portA = await serverA.ensure(preferredPortA, { host: "127.0.0.1", allowPortFallback: true });
        const portB = await serverB.ensure(preferredPortB, { host: "127.0.0.1", allowPortFallback: true });

        assert.notStrictEqual(portA, portB);
        assert.strictEqual(serverA.isRunning(), true);
        assert.strictEqual(serverB.isRunning(), true);

        const waitA = serverA.waitForCallback("state-a");
        const waitB = serverB.waitForCallback("state-b");
        assert.strictEqual(serverA.pendingCount(), 1);
        assert.strictEqual(serverB.pendingCount(), 1);

        // Sending state-a to serverB must be rejected as invalid_state (400) without resolving waitA
        const crossRes = await fetch(`http://127.0.0.1:${portB}/callback?code=code-a&state=state-a`);
        assert.strictEqual(crossRes.status, 400);
        assert.strictEqual(serverA.pendingCount(), 1);

        // Stopping serverA must not stop serverB or cancel serverB's pending auth
        const waitARejected = assert.rejects(waitA, /OAuth callback server stopped/);
        await serverA.stop();
        await waitARejected;
        assert.strictEqual(serverA.isRunning(), false);
        assert.strictEqual(serverB.isRunning(), true);
        assert.strictEqual(serverB.pendingCount(), 1);

        const resB = await fetch(`http://127.0.0.1:${portB}/callback?code=code-b&state=state-b`);
        assert.strictEqual(resB.status, 200);
        assert.strictEqual(await waitB, "code-b");
        assert.strictEqual(serverB.pendingCount(), 0);
      } finally {
        await serverA.stop();
        await serverB.stop();
      }
    });
  });

  describe("IPv4 Binding (Medium Fix #12)", () => {
    it("should use 127.0.0.1 in redirect URL", () => {
      const provider = new McpOAuthProvider({ serverName: testServerName, authConfig: {}, storageDir: testStorage });
      const redirectUrl = String(provider.redirectUrl);

      assert.match(redirectUrl, /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
        "Redirect URL should use 127.0.0.1, not localhost");
    });

    it("should respect custom redirect URL if provided", () => {
      const customUrl = "https://example.com/callback";
      const provider = new McpOAuthProvider({ serverName: testServerName, authConfig: { redirectUrl: customUrl }, storageDir: testStorage });
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
          { hasUI: true, ui },
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
      const callbackServer = new CallbackServer();
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      const addr = probe.address();
      assert.ok(addr && typeof addr === "object");
      await new Promise<void>((resolve) => probe.close(() => resolve()));

      const port = await callbackServer.ensure(addr.port, { host: "127.0.0.1", allowPortFallback: false });
      try {
        const res = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=wrong-state`);
        assert.strictEqual(res.status, 400);
      } finally {
        await callbackServer.stop();
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
      const commands = createStrictMap<string, MockCommand>();
      const events = createStrictMap<string, (event: unknown, ctx: unknown) => unknown>();
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
      const ctx = createMockContext({
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
      });

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
          asExtensionAPI({
            registerTool: () => {},
            registerCommand: (name: string, cmd: MockCommand) => commands.set(name, cmd),
            on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => events.set(name, handler),
            getActiveTools: () => [],
            setActiveTools: () => {},
          }),
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
        await events.get("session_shutdown")({}, ctx);
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
        const commands = createStrictMap<string, MockCommand>();
        const events = createStrictMap<string, (event: unknown, ctx: unknown) => unknown>();
        const notifications: Array<{ message: string; type?: string }> = [];
        let browserOpenCalled = false;
        const ctx = createMockContext({
          cwd: dir,
          hasUI: true,
          ui: {
            notify: (message: string, type?: string) => notifications.push({ message, ...(type ? { type } : {}) }),
            select: async () => authCancelOption,
          },
        });

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
            asExtensionAPI({
              registerTool: () => {},
              registerCommand: (name: string, cmd: MockCommand) => commands.set(name, cmd),
              on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => events.set(name, handler),
              getActiveTools: () => [],
              setActiveTools: () => {},
            }),
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
          await events.get("session_shutdown")({}, ctx);
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
      const commands = createStrictMap<string, MockCommand>();
      const events = createStrictMap<string, (event: unknown, ctx: unknown) => unknown>();
      const notifications: Array<{ message: string; type?: string }> = [];
      let capturedAuthUrl: URL | undefined;
      const ctx = createMockContext({
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
      });

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
          asExtensionAPI({
            registerTool: () => {},
            registerCommand: (name: string, cmd: MockCommand) => commands.set(name, cmd),
            on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => events.set(name, handler),
            getActiveTools: () => [],
            setActiveTools: () => {},
          }),
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
        await events.get("session_shutdown")({}, ctx);
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

    it(
      "should surface EACCES when resetting auth in a read-only directory on POSIX",
      {
        skip:
          (process.platform === "win32" || process.getuid?.() === 0) &&
          "WHY: POSIX non-root directory permission semantics required (0o500 chmod is ignored on Windows)",
      },
      async () => {

      // Arrange
      const { chmod } = await import("node:fs/promises");
      const { resetAuth } = await import("../src/oauth-provider.js");
      const roStorage = await mkdtemp(join(tmpdir(), "pi-mcp-oauth-ro-"));
      const roProvider = new McpOAuthProvider({ serverName: testServerName, authConfig: {}, storageDir: roStorage });
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
      const silentProvider = new McpOAuthProvider({ serverName: testServerName, authConfig: {}, storageDir: testStorage, mode: "silent" });

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

      const tools = createStrictMap<string, MockTool>();
      const commands = createStrictMap<string, MockCommand>();
      const events = createStrictMap<string, (event: unknown, ctx: unknown) => unknown>();
      const notifications: Array<{ message: string; type?: string }> = [];
      const selectPrompts: string[] = [];
      const statuses: Array<{ key: string; value: string | undefined }> = [];

      const pi = asExtensionAPI({
        registerTool: (tool: MockTool) => tools.set(tool.name, tool),
        registerCommand: (name: string, cmd: MockCommand) => commands.set(name, cmd),
        on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => events.set(name, handler),
        getActiveTools: () => [],
        setActiveTools: () => {},
      });

      const ctx = createMockContext({
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
      });

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

        await extension(pi, {
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
        const seededProvider = new McpOAuthProvider({ serverName: "eager-oauth", authConfig: { type: "oauth" }, storageDir: authDir });
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
        await events.get("session_shutdown")({}, ctx);
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

      const tools = createStrictMap<string, MockTool>();
      const commands = createStrictMap<string, MockCommand>();
      const events = createStrictMap<string, (event: unknown, ctx: unknown) => unknown>();
      let activeTools: string[] = [];
      const selectPrompts: string[] = [];

      const pi = asExtensionAPI({
        registerTool: (tool: MockTool) => tools.set(tool.name, tool),
        registerCommand: (name: string, cmd: MockCommand) => commands.set(name, cmd),
        on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => events.set(name, handler),
        getActiveTools: () => activeTools,
        setActiveTools: (names: string[]) => {
          activeTools = names;
        },
      });

      const ctx = createMockContext({
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
      });

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

        await extension(pi, {
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
        await events.get("session_shutdown")({}, ctx);
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

      const tools = createStrictMap<string, MockTool>();
      const events = createStrictMap<string, (event: unknown, ctx: unknown) => unknown>();
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

      const pi = asExtensionAPI({
        registerTool: (tool: MockTool) => tools.set(tool.name, tool),
        registerCommand: () => {},
        on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => events.set(name, handler),
        getActiveTools: () => activeTools,
        setActiveTools: (names: string[]) => {
          activeTools = names;
          if (names.some((n) => n.includes("alpha_echo")) && !timeline.includes("alpha:tools_active")) {
            timeline.push("alpha:tools_active");
          }
        },
      });

      const ctx = createMockContext({
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
      });

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

        await extension(pi, {
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
        await events.get("session_shutdown")({}, ctx);
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

      const tools = createStrictMap<string, MockTool>();
      const commands = createStrictMap<string, MockCommand>();
      const events = createStrictMap<string, (event: unknown, ctx: unknown) => unknown>();
      let activeTools: string[] = [];

      const pi = asExtensionAPI({
        registerTool: (tool: MockTool) => tools.set(tool.name, tool),
        registerCommand: (name: string, cmd: MockCommand) => commands.set(name, cmd),
        on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => events.set(name, handler),
        getActiveTools: () => activeTools,
        setActiveTools: (names: string[]) => {
          activeTools = names;
        },
      });

      const ctx = createMockContext({
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
      });

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

        await extension(pi, {
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

        const inspectProvider = new McpOAuthProvider({ serverName: "rotatable", authConfig: { type: "oauth" }, storageDir: authDir });
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
        await events.get("session_shutdown")({}, ctx);
        await fakeServer.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("Origin-Bound OAuth State, DCR Persistence, and Re-Auth Edge Cases (Issues #22, #23)", () => {
    it("should canonicalize server URLs and isolate stored OAuth state across different server origins and paths (Issue 22.1)", async () => {
      const oauthMod = {
        ...(await import("../src/oauth-provider.js")),
        ...(await import("../src/oauth-state-store.js")),
      };
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

        const globalProvider = new McpOAuthProvider({
          serverName: "shared-name",
          authConfig: { type: "oauth" },
          storageDir: dir,
          serverUrl: globalUrl,
        });
        await globalProvider.saveClientInformation({ client_id: "global-client" });
        await globalProvider.saveTokens({ access_token: "global-secret-token", token_type: "Bearer" });
        await globalProvider.saveDiscoveryState({
          authorizationServerUrl: "https://global.example.com",
          resourceMetadata: {
            resource: "https://global.example.com/mcp",
            authorization_servers: ["https://global.example.com"],
          },
        });

        // Same URL (ignoring trailing slash) sees stored state
        const sameOriginProvider = new McpOAuthProvider({
          serverName: "shared-name",
          authConfig: { type: "oauth" },
          storageDir: dir,
          serverUrl: "https://global.example.com/mcp",
        });
        assert.strictEqual((await sameOriginProvider.tokens())?.access_token, "global-secret-token");
        assert.strictEqual((await sameOriginProvider.clientInformation())?.client_id, "global-client");
        assert.strictEqual((await oauthMod.getAuthStatus("shared-name", dir, "https://global.example.com/mcp"))?.hasTokens, true);

        // Different URL with same serverName must NOT read global tokens, clientInfo, or discoveryState
        const evilProvider = new McpOAuthProvider({
          serverName: "shared-name",
          authConfig: { type: "oauth" },
          storageDir: dir,
          serverUrl: evilUrl,
        });
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

        const newUrlProvider = new McpOAuthProvider({
          serverName: "legacy-srv",
          authConfig: { type: "oauth" },
          storageDir: dir,
          serverUrl: "https://new-host.example.com/mcp",
        });
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
        const p1 = new McpOAuthProvider({
          serverName: "dcr-srv",
          authConfig: { type: "oauth", redirectUrl: "http://127.0.0.1:19876/callback" },
          storageDir: dir,
        });
        const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
        await p1.saveClientInformation({
          client_id: "dcr-1",
          client_secret: "secret-1",
          client_id_issued_at: 1700000000,
          client_secret_expires_at: futureExpiry,
          token_endpoint_auth_method: "client_secret_post",
          redirect_uris: ["http://127.0.0.1:19876/callback"],
        });

        const loaded = (await p1.clientInformation()) as
          | (Record<string, unknown> & { token_endpoint_auth_method?: string; redirect_uris?: string[] })
          | undefined;
        assert.strictEqual(loaded?.client_id, "dcr-1");
        assert.strictEqual(loaded?.client_secret, "secret-1");
        assert.strictEqual(loaded?.client_id_issued_at, 1700000000);
        assert.strictEqual(loaded?.client_secret_expires_at, futureExpiry);
        assert.strictEqual(loaded?.token_endpoint_auth_method, "client_secret_post");
        assert.deepStrictEqual(loaded?.redirect_uris, ["http://127.0.0.1:19876/callback"]);

        // Interactive provider with a different redirectUrl (e.g. fallback port) returns undefined to trigger fresh DCR
        const pChangedRedirect = new McpOAuthProvider({
          serverName: "dcr-srv",
          authConfig: { type: "oauth", redirectUrl: "http://127.0.0.1:19877/callback" },
          storageDir: dir,
        });
        assert.strictEqual(await pChangedRedirect.clientInformation(), undefined);

        // Expired client_secret: returns undefined in interactive mode, throws AuthRequiredError in silent mode
        const pastExpiry = Math.floor(Date.now() / 1000) - 60;
        await p1.saveClientInformation({
          client_id: "dcr-expired",
          client_secret: "secret-expired",
          client_secret_expires_at: pastExpiry,
        });
        assert.strictEqual(await p1.clientInformation(), undefined);

        const pSilent = new McpOAuthProvider({ serverName: "dcr-srv", authConfig: { type: "oauth" }, storageDir: dir, mode: "silent" });
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
      assert.strictEqual(isOAuthUnauthorizedError(new Error("401")), true);
      assert.strictEqual(isOAuthUnauthorizedError(new Error("HTTP 401")), true);
      assert.strictEqual(isOAuthUnauthorizedError(new Error("HTTP/1.1 401 Unauthorized")), true);
      assert.strictEqual(isOAuthUnauthorizedError(new Error("status 401")), true);
      assert.strictEqual(isOAuthUnauthorizedError(new Error("status code: 401")), true);
      assert.strictEqual(isOAuthUnauthorizedError(new Error("(401)")), true);
      assert.strictEqual(isOAuthUnauthorizedError(new Error("Non-200 status code (401)")), true);
      assert.strictEqual(isOAuthUnauthorizedError(new Error("SSE error: Non-200 status code (401)")), true);
      assert.strictEqual(isOAuthUnauthorizedError(new Error("401 Unauthorized")), true);
      assert.strictEqual(isOAuthUnauthorizedError(new Error("returned 401")), true);
      assert.strictEqual(isOAuthUnauthorizedError(new Error('Bearer error="invalid_token"')), true);
      assert.strictEqual(isOAuthUnauthorizedError(new Error("Error POSTing to endpoint (HTTP 401): Unauthorized")), true);
      assert.strictEqual(isOAuthUnauthorizedError(new Error("Error POSTing to endpoint: 401")), true);
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
      assert.strictEqual(isOAuthUnauthorizedError(new Error("Worker queue error: 401 items failed")), false);
      assert.strictEqual(
        isOAuthUnauthorizedError(new Error("Downstream service reported Unauthorized connection to database")),
        false,
      );
      assert.strictEqual(isOAuthUnauthorizedError(new Error("Unauthorized access to local file")), false);
      assert.strictEqual(isOAuthUnauthorizedError(new Error("Line: 401 SyntaxError: Unexpected token")), false);
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
      const cycA = new Error("outer") as Error & { cause?: unknown };
      const cycB = new Error("inner") as Error & { cause?: unknown };
      cycA.cause = cycB;
      cycB.cause = cycA;
      assert.strictEqual(isOAuthUnauthorizedError(cycA), false);
    });

    it("should fall back to POST on 405 in discoverManualAuthChallenge and forward custom headers via createHeadersFetch (Issue 23.5)", async () => {
      const challengeMod = await import("../src/auth-challenge.js");
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
        async (_input: unknown, init?: RequestInit) => {
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

      const tools = createStrictMap<string, MockTool>();
      const events = createStrictMap<string, (event: unknown, ctx: unknown) => unknown>();
      let activeTools: string[] = [];
      let browserOpenCalls = 0;

      const pi = asExtensionAPI({
        registerTool: (tool: MockTool) => tools.set(tool.name, tool),
        registerCommand: () => {},
        on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => events.set(name, handler),
        getActiveTools: () => activeTools,
        setActiveTools: (names: string[]) => { activeTools = names; },
      });
      const ctx = createMockContext({
        cwd: dir,
        hasUI: true,
        ui: {
          notify: () => {},
          select: (_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
            new Promise<string | undefined>((resolve) => {
              opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
            }),
        },
      });

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
        const seeder = new McpOAuthProvider({
          serverName: "reauth",
          authConfig: { type: "oauth", clientId: "reauth-client" },
          storageDir: authDir,
          isCancelled: () => false,
          serverUrl: `${base}/mcp`,
        });
        await seeder.saveTokens({
          access_token: "initial-expired",
          refresh_token: "refresh-still-valid-at-as",
          token_type: "Bearer",
        });

        await extension(pi, {
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
        await events.get("session_shutdown")({}, ctx);
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

      const tools = createStrictMap<string, MockTool>();
      const commands = createStrictMap<string, MockCommand>();
      const events = createStrictMap<string, (event: unknown, ctx: unknown) => unknown>();
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

      const pi = asExtensionAPI({
        registerTool: (tool: MockTool) => tools.set(tool.name, tool),
        registerCommand: (name: string, cmd: MockCommand) => commands.set(name, cmd),
        on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => events.set(name, handler),
        getActiveTools: () => activeTools,
        setActiveTools: (names: string[]) => {
          activeTools = names;
          if (names.some((n) => n.includes("alpha_echo")) && !timeline.includes("alpha:tools_active")) {
            timeline.push("alpha:tools_active");
          }
        },
      });

      const ctx = createMockContext({
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
      });

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

        await extension(pi, {
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
        await events.get("session_shutdown")({}, ctx);
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

      const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
      };
      const listener = createServer((req, res) => {
        void handleRequest(req, res);
      });
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const addr = listener.address();
      assert.ok(addr && typeof addr === "object");

      const tools = createStrictMap<string, MockTool>();
      const events = createStrictMap<string, (event: unknown, ctx: unknown) => unknown>();
      const pi = asExtensionAPI({
        registerTool: (t: MockTool) => tools.set(t.name, t),
        registerCommand: () => {},
        on: (n: string, h: (event: unknown, ctx: unknown) => unknown) => events.set(n, h),
        getActiveTools: () => [],
        setActiveTools: () => {},
      });
      const ctx = createMockContext({
        cwd: dir,
        hasUI: true,
        ui: {
          notify: () => {},
          select: async () => authCancelOption,
        },
      });

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

        await extension(pi, {
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
        await events.get("session_shutdown")({}, ctx);
        listener.closeAllConnections();
        await new Promise<void>((resolve) => listener.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("GHSA-6qxp-vccf-f47h: SDK authorization-server issuer binding", () => {
    it("should persist issuer to disk and return it from tokens() across fresh provider instances", async () => {
      const { readFile } = await import("node:fs/promises");
      const { createHash } = await import("node:crypto");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issuer-tokens-"));
      const authDir = dir;
      try {
        const p1 = new McpOAuthProvider({ serverName: "srv-tokens", authConfig: {}, storageDir: authDir });
        await p1.saveTokens({
          access_token: "at-123",
          token_type: "Bearer",
          refresh_token: "rt-123",
          expires_in: 3600,
          scope: "mcp:tools",
          issuer: "https://auth.example.com",
        });

        // 1. Verify JSON file on disk has issuer property
        const hash = createHash("sha256").update("srv-tokens").digest("hex").slice(0, 16);
        const raw = await readFile(join(authDir, `${hash}.json`), "utf8");
        const parsed = JSON.parse(raw);
        assert.strictEqual(parsed.tokens?.issuer, "https://auth.example.com");

        // 2. Fresh provider instance loading from disk returns issuer
        const p2 = new McpOAuthProvider({ serverName: "srv-tokens", authConfig: {}, storageDir: authDir });
        const loadedTokens = await p2.tokens();
        assert.ok(loadedTokens);
        assert.strictEqual(loadedTokens?.access_token, "at-123");
        assert.strictEqual(loadedTokens?.issuer, "https://auth.example.com");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should persist issuer to disk and return it from clientInformation() across fresh provider instances preserving DCR metadata", async () => {
      const { readFile } = await import("node:fs/promises");
      const { createHash } = await import("node:crypto");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issuer-client-"));
      const authDir = dir;
      try {
        const p1 = new McpOAuthProvider({ serverName: "srv-client", authConfig: {}, storageDir: authDir });
        await p1.saveClientInformation({
          client_id: "cid-456",
          client_secret: "sec-456",
          client_id_issued_at: 1700000000,
          client_secret_expires_at: 0,
          token_endpoint_auth_method: "client_secret_post",
          redirect_uris: ["http://127.0.0.1:19876/callback"],
          issuer: "https://auth.example.com",
        });

        // 1. Verify JSON file on disk has issuer property and DCR metadata
        const hash = createHash("sha256").update("srv-client").digest("hex").slice(0, 16);
        const raw = await readFile(join(authDir, `${hash}.json`), "utf8");
        const parsed = JSON.parse(raw);
        assert.strictEqual(parsed.clientInfo?.issuer, "https://auth.example.com");
        assert.strictEqual(parsed.clientInfo?.token_endpoint_auth_method, "client_secret_post");
        assert.deepStrictEqual(parsed.clientInfo?.redirect_uris, ["http://127.0.0.1:19876/callback"]);

        // 2. Fresh provider instance loading from disk returns issuer and DCR metadata
        const p2 = new McpOAuthProvider({ serverName: "srv-client", authConfig: {}, storageDir: authDir });
        const loadedClient = await p2.clientInformation();
        assert.ok(loadedClient);
        assert.strictEqual(loadedClient?.client_id, "cid-456");
        assert.strictEqual(loadedClient?.client_secret, "sec-456");
        assert.strictEqual(loadedClient?.issuer, "https://auth.example.com");
        if (loadedClient && "token_endpoint_auth_method" in loadedClient) {
          assert.strictEqual(loadedClient.token_endpoint_auth_method, "client_secret_post");
        } else {
          assert.fail("token_endpoint_auth_method should be present");
        }
        if (loadedClient && "redirect_uris" in loadedClient) {
          assert.deepStrictEqual(loadedClient.redirect_uris, ["http://127.0.0.1:19876/callback"]);
        } else {
          assert.fail("redirect_uris should be present");
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should allow pre-upgrade unstamped credentials without issuer and preserve them gracefully", async () => {
      const { writeFile } = await import("node:fs/promises");
      const { createHash } = await import("node:crypto");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issuer-legacy-"));
      const authDir = dir;
      try {
        const hash = createHash("sha256").update("legacy-srv").digest("hex").slice(0, 16);
        await writeFile(
          join(authDir, `${hash}.json`),
          JSON.stringify({
            clientInfo: {
              client_id: "legacy-cid",
              client_secret: "legacy-sec",
            },
            tokens: {
              access_token: "legacy-at",
              refresh_token: "legacy-rt",
              token_type: "Bearer",
            },
          }),
          "utf8",
        );

        const provider = new McpOAuthProvider({ serverName: "legacy-srv", authConfig: {}, storageDir: authDir });
        const tokens = await provider.tokens();
        assert.ok(tokens);
        assert.strictEqual(tokens?.access_token, "legacy-at");
        assert.strictEqual(tokens?.issuer, undefined);

        const client = await provider.clientInformation();
        assert.ok(client);
        assert.strictEqual(client?.client_id, "legacy-cid");
        assert.strictEqual(client?.issuer, undefined);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should discard stored tokens when the authorization server issuer mismatches (SDK discardIfIssuerMismatch integration)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issuer-mismatch-"));
      const authDir = dir;
      try {
        const provider = new McpOAuthProvider({ serverName: "mismatch-srv", authConfig: {}, storageDir: authDir });
        // Stored tokens were issued by auth-one
        await provider.saveTokens({
          access_token: "compromised-at",
          refresh_token: "compromised-rt",
          token_type: "Bearer",
          issuer: "https://auth-one.example.com",
        });

        // Use SDK's auth() with a mock server pointing to auth-two
        const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");

        let refreshRequested = false;
        const mockFetch: typeof fetch = async (url, init) => {
          const u = String(url);
          if (u.includes("/.well-known/oauth-protected-resource")) {
            return new Response(JSON.stringify({
              resource: "https://mcp.example.com/srv",
              authorization_servers: ["https://auth-two.example.com"],
            }), { status: 200, headers: { "content-type": "application/json" } });
          }
          if (u.includes("/.well-known/oauth-authorization-server") || u.includes("/.well-known/openid-configuration")) {
            return new Response(JSON.stringify({
              issuer: "https://auth-two.example.com",
              authorization_endpoint: "https://auth-two.example.com/authorize",
              token_endpoint: "https://auth-two.example.com/token",
              registration_endpoint: "https://auth-two.example.com/register",
              response_types_supported: ["code"],
            }), { status: 200, headers: { "content-type": "application/json" } });
          }
          if (u === "https://auth-two.example.com/token") {
            const body = String(init?.body ?? "");
            if (body.includes("grant_type=refresh_token")) {
              refreshRequested = true;
            }
            return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
          }
          if (u === "https://auth-two.example.com/register") {
            return new Response(JSON.stringify({
              client_id: "new-client-at-two",
              client_secret: "new-secret-at-two",
              redirect_uris: ["http://127.0.0.1:19876/callback"],
            }), { status: 201, headers: { "content-type": "application/json" } });
          }
          return new Response("Not found", { status: 404 });
        };

        // When auth() runs, because the stored token has issuer auth-one, it MUST NOT
        // post the refresh token to auth-two's token endpoint.
        let redirectedUrl: URL | undefined;
        const redirectProvider = new McpOAuthProvider({
          serverName: "mismatch-srv",
          authConfig: {},
          onAuthRequired: (url) => { redirectedUrl = url; },
          storageDir: authDir,
        });

        const result = await auth(redirectProvider, {
          serverUrl: "https://mcp.example.com/srv",
          fetchFn: mockFetch,
        });

        assert.strictEqual(result, "REDIRECT");
        assert.strictEqual(refreshRequested, false, "Stored refresh token from auth-one must never be sent to auth-two");
        assert.ok(redirectedUrl);
        assert.strictEqual(redirectedUrl?.origin, "https://auth-two.example.com");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should preserve issuer across silent peer token refresh rotation", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issuer-peer-"));
      const authDir = dir;
      try {
        const seeder = new McpOAuthProvider({ serverName: "peer-srv", authConfig: {}, storageDir: authDir });
        await seeder.saveTokens({
          access_token: "initial-at",
          refresh_token: "initial-rt",
          token_type: "Bearer",
          issuer: "https://auth.example.com",
        });

        // Process B in silent mode reads initial tokens
        const processB = new McpOAuthProvider({ serverName: "peer-srv", authConfig: {}, storageDir: authDir, mode: "silent" });
        const tokensB1 = await processB.tokens();
        assert.strictEqual(tokensB1?.access_token, "initial-at");
        assert.strictEqual(tokensB1?.issuer, "https://auth.example.com");

        // Process A rotates tokens on disk
        const processA = new McpOAuthProvider({ serverName: "peer-srv", authConfig: {}, storageDir: authDir, mode: "silent" });
        await processA.saveTokens({
          access_token: "rotated-at",
          refresh_token: "rotated-rt",
          token_type: "Bearer",
          issuer: "https://auth.example.com",
        });

        // Process B encounters 401 and calls invalidateCredentials("tokens")
        await processB.invalidateCredentials("tokens");

        // Process B's tokens should now have rotated tokens AND retain issuer
        const tokensB2 = await processB.tokens();
        assert.strictEqual(tokensB2?.access_token, "rotated-at");
        assert.strictEqual(tokensB2?.refresh_token, "rotated-rt");
        assert.strictEqual(tokensB2?.issuer, "https://auth.example.com");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should preserve clientInfo issuer when tokens are invalidated and clear issuer when all are invalidated", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issuer-inval-"));
      const authDir = dir;
      try {
        const { invalidateStoredTokens } = await import("../src/oauth-provider.js");
        const p = new McpOAuthProvider({ serverName: "inval-srv", authConfig: {}, storageDir: authDir });
        await p.saveClientInformation({
          client_id: "cid-1",
          issuer: "https://auth.example.com",
        });
        await p.saveTokens({
          access_token: "at-1",
          token_type: "Bearer",
          issuer: "https://auth.example.com",
        });

        // Invalidate tokens only via invalidateStoredTokens
        await invalidateStoredTokens("inval-srv", authDir);

        const p2 = new McpOAuthProvider({ serverName: "inval-srv", authConfig: {}, storageDir: authDir });
        assert.strictEqual(await p2.tokens(), undefined);
        const clientAfterTokensInval = await p2.clientInformation();
        assert.strictEqual(clientAfterTokensInval?.client_id, "cid-1");
        assert.strictEqual(clientAfterTokensInval?.issuer, "https://auth.example.com");

        // Now invalidate all
        await p2.invalidateCredentials("all");
        assert.strictEqual(await p2.tokens(), undefined);
        assert.strictEqual(await p2.clientInformation(), undefined);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should enforce origin binding alongside authorization-server issuer binding", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issuer-origin-"));
      const authDir = dir;
      try {
        const serverUrl = "https://mcp.example.com/team-a";
        const evilUrl = "https://mcp.example.com/team-b";
        const p = new McpOAuthProvider({
          serverName: "origin-srv",
          authConfig: {},
          storageDir: authDir,
          isCancelled: () => false,
          serverUrl,
        });
        await p.saveClientInformation({
          client_id: "cid-orig",
          issuer: "https://auth.example.com",
        });
        await p.saveTokens({
          access_token: "at-orig",
          token_type: "Bearer",
          issuer: "https://auth.example.com",
        });

        // When loaded with matching serverUrl: returns credentials with issuer
        const matchProvider = new McpOAuthProvider({
          serverName: "origin-srv",
          authConfig: {},
          storageDir: authDir,
          isCancelled: () => false,
          serverUrl,
        });
        const matchTokens = await matchProvider.tokens();
        const matchClient = await matchProvider.clientInformation();
        assert.strictEqual(matchTokens?.access_token, "at-orig");
        assert.strictEqual(matchTokens?.issuer, "https://auth.example.com");
        assert.strictEqual(matchClient?.issuer, "https://auth.example.com");

        // When loaded with mismatched serverUrl: returns undefined (origin binding)
        const evilProvider = new McpOAuthProvider({
          serverName: "origin-srv",
          authConfig: {},
          storageDir: authDir,
          isCancelled: () => false,
          serverUrl: evilUrl,
        });
        assert.strictEqual(await evilProvider.tokens(), undefined);
        assert.strictEqual(await evilProvider.clientInformation(), undefined);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should persist both tokens.issuer and clientInfo.issuer on disk after silent refresh with legacy unstamped state", async () => {
      const { readFile, writeFile } = await import("node:fs/promises");
      const { createHash } = await import("node:crypto");
      const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-silent-refresh-bind-"));
      const authDir = dir;
      try {
        const hash = createHash("sha256").update("legacy-refresh-srv").digest("hex").slice(0, 16);
        await writeFile(
          join(authDir, `${hash}.json`),
          JSON.stringify({
            clientInfo: {
              client_id: "legacy-cid",
              client_secret: "legacy-sec",
            },
            tokens: {
              access_token: "expired-at",
              refresh_token: "valid-rt",
              token_type: "Bearer",
            },
          }),
          "utf8",
        );

        const mockFetch: typeof fetch = async (url, init) => {
          const u = String(url);
          if (u.includes("/.well-known/oauth-protected-resource")) {
            return new Response(JSON.stringify({
              resource: "https://mcp.example.com/srv",
              authorization_servers: ["https://auth.example.com"],
            }), { status: 200, headers: { "content-type": "application/json" } });
          }
          if (u.includes("/.well-known/oauth-authorization-server") || u.includes("/.well-known/openid-configuration")) {
            return new Response(JSON.stringify({
              issuer: "https://auth.example.com",
              authorization_endpoint: "https://auth.example.com/authorize",
              token_endpoint: "https://auth.example.com/token",
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
            }), { status: 200, headers: { "content-type": "application/json" } });
          }
          if (u === "https://auth.example.com/token") {
            const body = String(init?.body ?? "");
            if (body.includes("grant_type=refresh_token")) {
              return new Response(JSON.stringify({
                access_token: "refreshed-at",
                refresh_token: "refreshed-rt",
                token_type: "Bearer",
                expires_in: 3600,
              }), { status: 200, headers: { "content-type": "application/json" } });
            }
          }
          return new Response("Not found", { status: 404 });
        };

        const silentProvider = new McpOAuthProvider({
          serverName: "legacy-refresh-srv",
          authConfig: {},
          storageDir: authDir,
          mode: "silent",
        });

        const result = await auth(silentProvider, {
          serverUrl: "https://mcp.example.com/srv",
          fetchFn: mockFetch,
        });

        assert.strictEqual(result, "AUTHORIZED");

        // Verify that disk state has BOTH tokens.issuer AND clientInfo.issuer persisted
        const raw = await readFile(join(authDir, `${hash}.json`), "utf8");
        const parsed = JSON.parse(raw);
        assert.strictEqual(parsed.tokens?.issuer, "https://auth.example.com");
        assert.strictEqual(parsed.clientInfo?.issuer, "https://auth.example.com");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should reject new DCR registration with different client_id in silent mode and not write to disk", async () => {
      const { readdir } = await import("node:fs/promises");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-silent-new-dcr-"));
      const authDir = dir;
      try {
        const silentProvider = new McpOAuthProvider({
          serverName: "new-dcr-srv",
          authConfig: {},
          storageDir: authDir,
          mode: "silent",
        });
        await assert.rejects(
          () => silentProvider.saveClientInformation({
            client_id: "new-unregistered-cid",
            issuer: "https://auth.example.com",
          }),
          AuthRequiredError,
        );

        // State directory should remain empty (no state file written)
        const files = await readdir(authDir);
        assert.deepStrictEqual(files, []);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should bind issuer on static clientId from config on first use and allow clean rebinding after reset", async () => {
      const { readFile } = await import("node:fs/promises");
      const { createHash } = await import("node:crypto");
      const { resetAuth } = await import("../src/oauth-provider.js");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-static-bind-"));
      const authDir = dir;
      try {
        const p1 = new McpOAuthProvider({
          serverName: "static-srv",
          authConfig: { clientId: "cfg-client-id", clientSecret: "cfg-secret" },
          storageDir: authDir,
        });

        // Before first save, clientInformation returns static config without issuer
        const initialClient = await p1.clientInformation();
        assert.strictEqual(initialClient?.client_id, "cfg-client-id");
        assert.strictEqual(initialClient?.issuer, undefined);

        // First successful use binds issuer (even if SDK passes client_secret)
        await p1.saveClientInformation({
          client_id: "cfg-client-id",
          client_secret: "cfg-secret",
          issuer: "https://auth-one.example.com",
        });

        // Config-supplied client_secret must never be persisted to the disk state file
        const hash = createHash("sha256").update("static-srv").digest("hex").slice(0, 16);
        const rawState = await readFile(join(authDir, `${hash}.json`), "utf8");
        const parsedState = JSON.parse(rawState);
        assert.strictEqual(parsedState.clientInfo?.client_id, "cfg-client-id");
        assert.strictEqual(parsedState.clientInfo?.issuer, "https://auth-one.example.com");
        assert.strictEqual(parsedState.clientInfo?.client_secret, undefined);
        assert.strictEqual("client_secret" in (parsedState.clientInfo ?? {}), false);

        // Silent path with static clientId must also never persist client_secret to disk
        const silentStatic = new McpOAuthProvider({
          serverName: "static-silent-srv",
          authConfig: { clientId: "cfg-silent-id", clientSecret: "cfg-silent-sec" },
          storageDir: authDir,
          mode: "silent",
        });
        await silentStatic.saveClientInformation({
          client_id: "cfg-silent-id",
          client_secret: "cfg-silent-sec",
          issuer: "https://auth-silent.example.com",
        });
        const silentHash = createHash("sha256").update("static-silent-srv").digest("hex").slice(0, 16);
        const rawSilentState = await readFile(join(authDir, `${silentHash}.json`), "utf8");
        const parsedSilentState = JSON.parse(rawSilentState);
        assert.strictEqual(parsedSilentState.clientInfo?.client_id, "cfg-silent-id");
        assert.strictEqual(parsedSilentState.clientInfo?.issuer, "https://auth-silent.example.com");
        assert.strictEqual(parsedSilentState.clientInfo?.client_secret, undefined);
        assert.strictEqual("client_secret" in (parsedSilentState.clientInfo ?? {}), false);

        // Fresh provider returns bound issuer
        const p2 = new McpOAuthProvider({
          serverName: "static-srv",
          authConfig: { clientId: "cfg-client-id", clientSecret: "cfg-secret" },
          storageDir: authDir,
        });
        const boundClient = await p2.clientInformation();
        assert.strictEqual(boundClient?.client_id, "cfg-client-id");
        assert.strictEqual(boundClient?.issuer, "https://auth-one.example.com");

        // After /mcp:auth <server> --reset equivalent (resetAuth)
        await resetAuth("static-srv", authDir);

        const p3 = new McpOAuthProvider({
          serverName: "static-srv",
          authConfig: { clientId: "cfg-client-id", clientSecret: "cfg-secret" },
          storageDir: authDir,
        });
        const resetClient = await p3.clientInformation();
        assert.strictEqual(resetClient?.client_id, "cfg-client-id");
        assert.strictEqual(resetClient?.issuer, undefined);

        // A different authorization server can now bind cleanly
        await p3.saveClientInformation({
          client_id: "cfg-client-id",
          issuer: "https://auth-two.example.com",
        });
        const reboundClient = await p3.clientInformation();
        assert.strictEqual(reboundClient?.client_id, "cfg-client-id");
        assert.strictEqual(reboundClient?.issuer, "https://auth-two.example.com");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("should never re-stamp an already stamped client with a different issuer", async () => {
      const { readFile } = await import("node:fs/promises");
      const { createHash } = await import("node:crypto");
      const { McpError } = await import("../src/errors.js");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-no-restamp-"));
      const authDir = dir;
      try {
        const p = new McpOAuthProvider({
          serverName: "stamped-srv",
          authConfig: {},
          storageDir: authDir,
        });
        await p.saveClientInformation({
          client_id: "cid-fixed",
          issuer: "https://auth-one.example.com",
        });

        // Attempting to save with a different issuer must reject with McpError mentioning --reset
        await assert.rejects(
          () =>
            p.saveClientInformation({
              client_id: "cid-fixed",
              issuer: "https://auth-two.example.com",
            }),
          (err: unknown) => {
            assert.ok(err instanceof McpError);
            assert.strictEqual(err.code, "auth");
            assert.match(err.message, /\/mcp:auth stamped-srv --reset/);
            return true;
          },
        );

        const client1 = await p.clientInformation();
        assert.strictEqual(client1?.issuer, "https://auth-one.example.com");

        // Same invariant in silent mode: must reject with McpError and not re-stamp with different issuer
        const silentP = new McpOAuthProvider({
          serverName: "stamped-srv",
          authConfig: {},
          storageDir: authDir,
          mode: "silent",
        });
        await assert.rejects(
          () =>
            silentP.saveClientInformation({
              client_id: "cid-fixed",
              issuer: "https://auth-two.example.com",
            }),
          (err: unknown) => {
            assert.ok(err instanceof McpError);
            assert.strictEqual(err.code, "auth");
            assert.match(err.message, /\/mcp:auth stamped-srv --reset/);
            return true;
          },
        );

        const client2 = await silentP.clientInformation();
        assert.strictEqual(client2?.issuer, "https://auth-one.example.com");

        // Direct disk assertion: disk state retains original issuer in both cases
        const hash = createHash("sha256").update("stamped-srv").digest("hex").slice(0, 16);
        const raw = await readFile(join(authDir, `${hash}.json`), "utf8");
        const parsed = JSON.parse(raw);
        assert.strictEqual(parsed.clientInfo?.issuer, "https://auth-one.example.com");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("Issue #64: remove global callback port and use options object for McpOAuthProvider", () => {
    it("two providers for different servers in one process do not affect each other's redirectUrl", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issue-64-isolation-"));
      try {
        const providerA = new McpOAuthProvider({
          serverName: "server-a",
          authConfig: {},
          storageDir: dir,
          redirectUrl: "http://127.0.0.1:20001/callback",
        });
        const providerB = new McpOAuthProvider({
          serverName: "server-b",
          authConfig: {},
          storageDir: dir,
          redirectUrl: "http://127.0.0.1:20002/callback",
        });
        const providerSilent = new McpOAuthProvider({
          serverName: "server-c",
          authConfig: {},
          storageDir: dir,
          mode: "silent",
        });

        // Ensure that providerA, providerB, and providerSilent all have independent redirect URLs
        assert.strictEqual(providerA.redirectUrl, "http://127.0.0.1:20001/callback");
        assert.strictEqual(providerB.redirectUrl, "http://127.0.0.1:20002/callback");
        assert.strictEqual(providerSilent.redirectUrl, "http://127.0.0.1:19876/callback");

        assert.deepStrictEqual(providerA.clientMetadata.redirect_uris, ["http://127.0.0.1:20001/callback"]);
        assert.deepStrictEqual(providerB.clientMetadata.redirect_uris, ["http://127.0.0.1:20002/callback"]);
        assert.deepStrictEqual(providerSilent.clientMetadata.redirect_uris, ["http://127.0.0.1:19876/callback"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("silent provider reports registered redirect_uris in clientMetadata and redirectUrl", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issue-64-silent-dcr-"));
      try {
        const seeder = new McpOAuthProvider({
          serverName: "dcr-server",
          authConfig: {},
          storageDir: dir,
        });
        await seeder.saveClientInformation({
          client_id: "registered-client-id",
          redirect_uris: ["http://127.0.0.1:31415/callback", "http://localhost:31415/callback"],
          issuer: "https://auth.example.com",
        });

        const silent = new McpOAuthProvider({
          serverName: "dcr-server",
          authConfig: {},
          storageDir: dir,
          mode: "silent",
        });

        assert.strictEqual(silent.redirectUrl, "http://127.0.0.1:31415/callback");
        assert.deepStrictEqual(silent.clientMetadata.redirect_uris, [
          "http://127.0.0.1:31415/callback",
          "http://localhost:31415/callback",
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("silent provider fallback priority: stored DCR -> configured auth.redirectUrl -> default 127.0.0.1:19876", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issue-64-fallback-"));
      try {
        // 1. Default fallback: no state, no configured redirectUrl
        const pDefault = new McpOAuthProvider({
          serverName: "default-srv",
          authConfig: {},
          storageDir: dir,
          mode: "silent",
        });
        assert.strictEqual(pDefault.redirectUrl, "http://127.0.0.1:19876/callback");
        assert.deepStrictEqual(pDefault.clientMetadata.redirect_uris, ["http://127.0.0.1:19876/callback"]);

        // 2. Configured fallback: no state, configured auth.redirectUrl
        const pConfigured = new McpOAuthProvider({
          serverName: "configured-srv",
          authConfig: { redirectUrl: "http://127.0.0.1:24000/callback" },
          storageDir: dir,
          mode: "silent",
        });
        assert.strictEqual(pConfigured.redirectUrl, "http://127.0.0.1:24000/callback");
        assert.deepStrictEqual(pConfigured.clientMetadata.redirect_uris, ["http://127.0.0.1:24000/callback"]);

        // 3. Stored DCR priority: stored state has redirect_uris, overrides configured auth.redirectUrl
        const seeder = new McpOAuthProvider({
          serverName: "priority-srv",
          authConfig: { redirectUrl: "http://127.0.0.1:24000/callback" },
          storageDir: dir,
        });
        await seeder.saveClientInformation({
          client_id: "priority-client",
          redirect_uris: ["http://127.0.0.1:25000/dcr-callback"],
          issuer: "https://auth.example.com",
        });

        const pDcr = new McpOAuthProvider({
          serverName: "priority-srv",
          authConfig: { redirectUrl: "http://127.0.0.1:24000/callback" },
          storageDir: dir,
          mode: "silent",
        });
        assert.strictEqual(pDcr.redirectUrl, "http://127.0.0.1:25000/dcr-callback");
        assert.deepStrictEqual(pDcr.clientMetadata.redirect_uris, ["http://127.0.0.1:25000/dcr-callback"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("interactive provider uses explicit redirectUrl option when provided, and falls back to configured or default", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issue-64-interactive-"));
      try {
        const pExplicit = new McpOAuthProvider({
          serverName: "interactive-srv",
          authConfig: { redirectUrl: "http://127.0.0.1:18000/callback" },
          storageDir: dir,
          redirectUrl: "http://127.0.0.1:19999/callback",
        });
        assert.strictEqual(pExplicit.redirectUrl, "http://127.0.0.1:19999/callback");
        assert.deepStrictEqual(pExplicit.clientMetadata.redirect_uris, ["http://127.0.0.1:19999/callback"]);

        const pConfig = new McpOAuthProvider({
          serverName: "interactive-srv",
          authConfig: { redirectUrl: "http://127.0.0.1:18000/callback" },
          storageDir: dir,
        });
        assert.strictEqual(pConfig.redirectUrl, "http://127.0.0.1:18000/callback");
        assert.deepStrictEqual(pConfig.clientMetadata.redirect_uris, ["http://127.0.0.1:18000/callback"]);

        const pDef = new McpOAuthProvider({
          serverName: "interactive-srv",
          authConfig: {},
          storageDir: dir,
        });
        assert.strictEqual(pDef.redirectUrl, "http://127.0.0.1:19876/callback");
        assert.deepStrictEqual(pDef.clientMetadata.redirect_uris, ["http://127.0.0.1:19876/callback"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("gracefully falls back when stored state on disk is corrupt or invalid JSON", async () => {
      const { writeFile } = await import("node:fs/promises");
      const { createHash } = await import("node:crypto");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issue-64-corrupt-"));
      try {
        const hash = createHash("sha256").update("corrupt-srv").digest("hex").slice(0, 16);
        await writeFile(join(dir, `${hash}.json`), "{ broken json ...", "utf8");

        const silent = new McpOAuthProvider({
          serverName: "corrupt-srv",
          authConfig: {},
          storageDir: dir,
          mode: "silent",
        });
        assert.strictEqual(silent.redirectUrl, "http://127.0.0.1:19876/callback");
        assert.deepStrictEqual(silent.clientMetadata.redirect_uris, ["http://127.0.0.1:19876/callback"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("ignores stored DCR redirect_uris when serverUrl or legacy discoveryState resource does not match", async () => {
      const { writeFile } = await import("node:fs/promises");
      const { createHash } = await import("node:crypto");
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issue-64-origin-"));
      try {
        // 1. Mismatched top-level serverUrl
        const seeder = new McpOAuthProvider({
          serverName: "origin-srv",
          authConfig: {},
          storageDir: dir,
          serverUrl: "https://global.example.com/mcp",
        });
        await seeder.saveClientInformation({
          client_id: "global-client",
          redirect_uris: ["http://127.0.0.1:30001/callback"],
          issuer: "https://auth.example.com",
        });

        const mismatchedSilent = new McpOAuthProvider({
          serverName: "origin-srv",
          authConfig: {},
          storageDir: dir,
          mode: "silent",
          serverUrl: "https://project.example.com/mcp",
        });
        assert.strictEqual(mismatchedSilent.redirectUrl, "http://127.0.0.1:19876/callback");
        assert.deepStrictEqual(mismatchedSilent.clientMetadata.redirect_uris, ["http://127.0.0.1:19876/callback"]);

        // 2. Legacy state file without top-level serverUrl whose discoveryState resource belongs to another origin
        const legacyHash = createHash("sha256").update("legacy-srv").digest("hex").slice(0, 16);
        await writeFile(
          join(dir, `${legacyHash}.json`),
          JSON.stringify({
            clientInfo: {
              client_id: "legacy-client",
              redirect_uris: ["http://127.0.0.1:30002/callback"],
            },
            discoveryState: {
              resourceMetadata: {
                resource: "https://other.example.com/mcp",
              },
            },
          }),
          "utf8",
        );

        const legacyMismatchSilent = new McpOAuthProvider({
          serverName: "legacy-srv",
          authConfig: {},
          storageDir: dir,
          mode: "silent",
          serverUrl: "https://expected.example.com/mcp",
        });
        assert.strictEqual(legacyMismatchSilent.redirectUrl, "http://127.0.0.1:19876/callback");
        assert.deepStrictEqual(legacyMismatchSilent.clientMetadata.redirect_uris, ["http://127.0.0.1:19876/callback"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});




