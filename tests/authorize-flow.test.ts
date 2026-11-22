import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  authorize,
  browserOpenCommand,
  AuthCancelledError,
  type AuthorizeDeps,
} from "../src/authorize-flow.js";
import {
  authCancelOption,
  authPasteOption,
  authRetryOption,
} from "../src/authorize-dialog.js";
import { McpError } from "../src/errors.js";
import { McpOAuthProvider } from "../src/oauth-provider.js";
import type { PendingAuthChallenge } from "../src/auth-challenge.js";
import type { ServerManager } from "../src/server-manager.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

describe("authorize-flow", () => {
  it("exports dialog option constants and AuthCancelledError", () => {
    assert.equal(authRetryOption, "Retry: open browser again");
    assert.equal(authPasteOption, "Paste redirect URL");
    assert.equal(authCancelOption, "Cancel authentication");
    const err = new AuthCancelledError("test-server");
    assert.equal(err.name, "AuthCancelledError");
  });

  describe("browserOpenCommand", () => {
    it("returns platform-specific open commands", () => {
      const originalPlatform = process.platform;
      try {
        Object.defineProperty(process, "platform", { value: "darwin" });
        assert.deepEqual(browserOpenCommand("https://example.com"), {
          command: "open",
          args: ["https://example.com"],
        });

        Object.defineProperty(process, "platform", { value: "win32" });
        assert.deepEqual(browserOpenCommand("https://example.com"), {
          command: "rundll32",
          args: ["url.dll,FileProtocolHandler", "https://example.com"],
        });

        Object.defineProperty(process, "platform", { value: "linux" });
        assert.deepEqual(browserOpenCommand("https://example.com"), {
          command: "xdg-open",
          args: ["https://example.com"],
        });
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });
  });

  describe("authorize validation", () => {
    it("throws McpError when server is unknown", async () => {
      const mockManager = {
        getServer: () => undefined,
        resetServerAuth: async () => {},
      } as unknown as ServerManager;

      const deps: AuthorizeDeps = {
        manager: mockManager,
      };

      const mockCtx = { hasUI: true, ui: { notify: () => {} } } as unknown as ExtensionContext;
      const controller = new AbortController();

      await assert.rejects(
        () => authorize(deps, "non-existent", mockCtx, controller.signal, false),
        (err: unknown) => {
          assert.ok(err instanceof McpError);
          assert.equal(err.code, "config");
          assert.match(err.message, /Unknown server "non-existent"/);
          return true;
        },
      );
    });

    it("throws McpError when server has no URL", async () => {
      const mockManager = {
        getServer: () => ({
          name: "test-srv",
          config: { auth: { type: "oauth" } },
        }),
        resetServerAuth: async () => {},
      } as unknown as ServerManager;

      const deps: AuthorizeDeps = {
        manager: mockManager,
      };

      const mockCtx = { hasUI: true, ui: { notify: () => {} } } as unknown as ExtensionContext;
      const controller = new AbortController();

      await assert.rejects(
        () => authorize(deps, "test-srv", mockCtx, controller.signal, false),
        (err: unknown) => {
          assert.ok(err instanceof McpError);
          assert.equal(err.code, "config");
          assert.match(err.message, /has OAuth configured but no URL/);
          return true;
        },
      );
    });

    it("throws Error when session has no UI", async () => {
      const mockManager = {
        getServer: () => ({
          name: "test-srv",
          config: { url: "https://example.com/mcp", auth: { type: "oauth" } },
        }),
        resetServerAuth: async () => {},
      } as unknown as ServerManager;

      const deps: AuthorizeDeps = {
        manager: mockManager,
      };

      const mockCtx = { hasUI: false, ui: { notify: () => {} } } as unknown as ExtensionContext;
      const controller = new AbortController();

      await assert.rejects(
        () => authorize(deps, "test-srv", mockCtx, controller.signal, false),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /requires an interactive Pi session/);
          return true;
        },
      );
    });

    it("throws AuthCancelledError when signal is already aborted", async () => {
      const mockManager = {
        getServer: () => ({
          name: "test-srv",
          config: { url: "https://example.com/mcp", auth: { type: "oauth" } },
        }),
        resetServerAuth: async () => {},
      } as unknown as ServerManager;

      const deps: AuthorizeDeps = {
        manager: mockManager,
      };

      const mockCtx = { hasUI: true, ui: { notify: () => {} } } as unknown as ExtensionContext;
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        () => authorize(deps, "test-srv", mockCtx, controller.signal, false),
        (err: unknown) => {
          assert.ok(err instanceof AuthCancelledError);
          return true;
        },
      );
    });

    it("uses getServerConfig getter when provided", async () => {
      let getterCalledWith = "";
      const mockManager = {
        getServer: () => undefined,
        resetServerAuth: async () => {},
      } as unknown as ServerManager;

      const deps: AuthorizeDeps = {
        manager: mockManager,
        getServerConfig: (name) => {
          getterCalledWith = name;
          return {
            transport: "streamable-http",
            lifecycle: "lazy",
            args: [],
            url: "https://example.com/mcp",
            auth: { type: "oauth" },
          };
        },
      };

      const mockCtx = { hasUI: false, ui: { notify: () => {} } } as unknown as ExtensionContext;
      const controller = new AbortController();

      await assert.rejects(
        () => authorize(deps, "custom-srv", mockCtx, controller.signal, false),
        /requires an interactive Pi session/,
      );
      assert.equal(getterCalledWith, "custom-srv");
    });

    it("releases the auth lock when resetServerAuth fails during reset=true", async () => {
      const authStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mcp-authorize-lock-"));
      try {
        const mockManager = {
          getServer: () => ({
            name: "test-srv",
            config: { url: "https://example.com/mcp", auth: { type: "oauth" } },
          }),
          resetServerAuth: async () => {
            throw new Error("disk error while resetting auth");
          },
        } as unknown as ServerManager;

        const deps: AuthorizeDeps = {
          manager: mockManager,
          authStorageDir,
        };

        const mockCtx = { hasUI: true, ui: { notify: () => {} } } as unknown as ExtensionContext;
        const controller = new AbortController();

        await assert.rejects(
          () => authorize(deps, "test-srv", mockCtx, controller.signal, true),
          /disk error while resetting auth/,
        );

        const entries = await fs.readdir(authStorageDir);
        const lockFiles = entries.filter((entry) => entry.endsWith(".lock"));
        assert.deepEqual(lockFiles, []);
      } finally {
        await fs.rm(authStorageDir, { recursive: true, force: true });
      }
    });
  });

  describe("Issue #328: step-up challenge resolution and lifecycle", () => {
    async function startAuthorizeTestServer() {
      let base = "";
      const authorizeScopes: Array<string | null> = [];
      const pendingCodes = new Map<string, { codeChallenge: string; scope: string }>();
      let seq = 0;

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", base || "http://127.0.0.1");
        if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }));
          return;
        }
        if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              issuer: base,
              authorization_endpoint: `${base}/authorize`,
              token_endpoint: `${base}/token`,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code"],
              code_challenge_methods_supported: ["S256"],
            }),
          );
          return;
        }
        if (url.pathname === "/authorize") {
          authorizeScopes.push(url.searchParams.get("scope"));
          const redirectUri = url.searchParams.get("redirect_uri")!;
          const state = url.searchParams.get("state") ?? "";
          const codeChallenge = url.searchParams.get("code_challenge") ?? "";
          const code = `c-${++seq}`;
          pendingCodes.set(code, { codeChallenge, scope: url.searchParams.get("scope") ?? "" });
          const target = new URL(redirectUri);
          target.searchParams.set("code", code);
          if (state) target.searchParams.set("state", state);
          res.writeHead(302, { Location: target.toString() });
          res.end();
          return;
        }
        if (url.pathname === "/token" && req.method === "POST") {
          let body = "";
          req.on("data", (c) => { body += String(c); });
          req.on("end", () => {
            const p = new URLSearchParams(body);
            const code = p.get("code") ?? "";
            const verifier = p.get("code_verifier") ?? "";
            const pending = pendingCodes.get(code);
            if (!pending || createHash("sha256").update(verifier).digest("base64url") !== pending.codeChallenge) {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "invalid_grant" }));
              return;
            }
            pendingCodes.delete(code);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                access_token: `tok-${seq}`,
                token_type: "Bearer",
                expires_in: 3600,
                ...(pending.scope ? { scope: pending.scope } : {}),
              }),
            );
          });
          return;
        }
        if (url.pathname === "/mcp") {
          res.writeHead(401, {
            "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="read"`,
          });
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      base = `http://127.0.0.1:${addr.port}`;
      return {
        mcpUrl: `${base}/mcp`,
        authorizeScopes,
        close: () => new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
      };
    }

    it("merges pending 403 challenge with stored token scope and config.auth.scope, and clears only on success", async () => {
      const authStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mcp-authorize-stepup-"));
      const srv = await startAuthorizeTestServer();
      try {
        let pending: PendingAuthChallenge | undefined = {
          serverUrl: srv.mcpUrl,
          error: "insufficient_scope",
          scope: "admin",
        };
        let resetCalled = 0;
        let clearedCount = 0;

        // Seed token with scope "read" on disk (no grantedScope on pending yet -> readStoredTokenScopeForStepUp)
        const seeder = new McpOAuthProvider({
          serverName: "stepup",
          authConfig: { type: "oauth", clientId: "cid", scope: "profile" },
          storageDir: authStorageDir,
          serverUrl: srv.mcpUrl,
        });
        await seeder.saveTokens({ access_token: "old", token_type: "Bearer", scope: "read" });

        const mockManager = {
          getServer: () => ({
            name: "stepup",
            config: {
              transport: "streamable-http",
              lifecycle: "lazy",
              args: [],
              url: srv.mcpUrl,
              auth: { type: "oauth", clientId: "cid", scope: "profile" },
            },
          }),
          getPendingAuthChallenge: () => pending,
          clearPendingAuthChallenge: () => {
            clearedCount += 1;
            pending = undefined;
          },
          resetServerAuth: async () => {
            resetCalled += 1;
            pending = undefined;
          },
        } as unknown as ServerManager;

        const mockCtx = {
          hasUI: true,
          ui: {
            notify: () => {},
            select: (_t: string, _opts: string[], o?: { signal?: AbortSignal }) =>
              new Promise<string | undefined>((resolve) => {
                o?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
              }),
          },
        } as unknown as ExtensionContext;

        // 1. Aborted run must NOT clear pending challenge
        const abortCtrl = new AbortController();
        await assert.rejects(
          () =>
            authorize(
              {
                manager: mockManager,
                authStorageDir,
                openBrowser: () => {
                  abortCtrl.abort();
                },
              },
              "stepup",
              mockCtx,
              abortCtrl.signal,
              false,
            ),
          (err: unknown) => err instanceof AuthCancelledError,
        );
        assert.equal(clearedCount, 0);
        assert.ok(pending);

        // 2. Successful run merges config.auth.scope + storedTokenScope + pending.scope and clears pending
        const okCtrl = new AbortController();
        await authorize(
          {
            manager: mockManager,
            authStorageDir,
            openBrowser: async (url) => {
              await fetch(url, { redirect: "follow" });
            },
          },
          "stepup",
          mockCtx,
          okCtrl.signal,
          false,
        );
        assert.equal(srv.authorizeScopes.at(-1), "profile read admin");
        assert.equal(clearedCount, 1);
        assert.equal(pending, undefined);

        // 3. Mismatched serverUrl pending challenge is ignored, and reset=true calls resetServerAuth
        pending = {
          serverUrl: "https://different-origin.example/mcp",
          error: "insufficient_scope",
          scope: "danger",
          grantedScope: "stale",
        };
        await authorize(
          {
            manager: mockManager,
            authStorageDir,
            openBrowser: async (url) => {
              await fetch(url, { redirect: "follow" });
            },
          },
          "stepup",
          mockCtx,
          new AbortController().signal,
          false,
        );
        assert.equal(srv.authorizeScopes.at(-1), "read");

        pending = {
          serverUrl: srv.mcpUrl,
          error: "insufficient_scope",
          scope: "admin",
          grantedScope: "read",
        };
        await authorize(
          {
            manager: mockManager,
            authStorageDir,
            openBrowser: async (url) => {
              await fetch(url, { redirect: "follow" });
            },
          },
          "stepup",
          mockCtx,
          new AbortController().signal,
          true,
        );
        assert.equal(resetCalled, 1);
        assert.equal(srv.authorizeScopes.at(-1), "read");
      } finally {
        await srv.close();
        await fs.rm(authStorageDir, { recursive: true, force: true });
      }
    });
  });
});
