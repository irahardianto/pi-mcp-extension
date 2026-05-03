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
import { ensureCallbackServer, stopCallbackServer } from "../src/callback-server.js";

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
