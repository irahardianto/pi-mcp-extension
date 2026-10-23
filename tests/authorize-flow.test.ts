import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
import type { ServerManager } from "../src/server-manager.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
  });
});
