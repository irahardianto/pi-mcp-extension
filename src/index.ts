/**
 * pi-mcp — MCP client extension for the Pi coding agent.
 *
 * Entry point registered in package.json under "pi.extensions".
 * Pi loads this file via jiti (TypeScript executed directly, no build step).
 *
 * Wires together: config → server manager → tool bridge → Pi API.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { loadConfig, type McpConfig } from "./config.js";
import { ServerManager } from "./server-manager.js";
import { AuthLockError, AuthRequiredError } from "./oauth-provider.js";
import * as Type from "typebox";
import { ToolBridge } from "./tool-bridge.js";
import { McpError } from "./errors.js";
import { spawn } from "node:child_process";

// OAuth imports
import {
  ensureCallbackServer,
  waitForCallback,
  cancelCallback,
  stopCallbackServer,
  callbackServerConfigFromRedirectUrl,
} from "./callback-server.js";
import { CallbackUrlValidationError, isSafeAuthorizationUrl, parseCallbackUrl } from "./callback-url.js";
import { setCallbackPort, McpOAuthProvider, acquireAuthLock, type AuthLockHandle } from "./oauth-provider.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { discoverManualAuthChallenge } from "./auth-challenge.js";
import type { ManualAuthChallenge } from "./auth-challenge.js";

export interface BrowserOpenCommand {
  command: string;
  args: string[];
}

export function browserOpenCommand(url: string): BrowserOpenCommand {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (process.platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: [url] };
}

/**
 * Open a URL in the user's default browser.
 * Works on macOS, Linux, and Windows.
 */
function openBrowser(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const { command, args } = browserOpenCommand(url);
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });

    child.once("error", (err) => {
      console.error(`[pi-mcp] Failed to open browser: ${err.message}`);
      reject(err);
    });

    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export class AuthCancelledError extends Error {
  constructor(serverName: string) {
    super(`Authentication cancelled for ${serverName}`);
    this.name = "AuthCancelledError";
  }
}

export const authRetryOption = "Retry: open browser again";
export const authPasteOption = "Paste redirect URL";
export const authCancelOption = "Cancel authentication";

interface OAuthCallbackResult {
  type: "callback";
  code: string;
}

interface OAuthCallbackErrorResult {
  type: "callbackError";
  error: unknown;
}

interface OAuthUserChoiceResult {
  type: "choice";
  choice: string | undefined;
}

interface OAuthDialogAbortedResult {
  type: "dialogAborted";
}

interface OAuthUserInputResult {
  type: "input";
  value: string | undefined;
}

type OAuthWaitResult = OAuthCallbackResult | OAuthCallbackErrorResult | OAuthUserChoiceResult | OAuthDialogAbortedResult;
type OAuthInputWaitResult = OAuthCallbackResult | OAuthCallbackErrorResult | OAuthUserInputResult | OAuthDialogAbortedResult;

export interface OAuthPasteOptions {
  redirectUrl?: string | URL | undefined;
  expectedState?: string | undefined;
  onPasteResolved?: (() => void) | undefined;
}

export async function waitForOAuthCallback(
  serverName: string,
  callbackPromise: Promise<string>,
  reopenBrowser: () => void | Promise<void>,
  context: {
    hasUI: boolean;
    ui: Pick<ExtensionUIContext, "select"> & Partial<Pick<ExtensionUIContext, "input" | "notify">>;
  },
  pasteOptions?: OAuthPasteOptions,
): Promise<string> {
  if (!context.hasUI) {
    throw new Error(`Authorization for ${serverName} requires an interactive Pi session`);
  }

  const callbackResultPromise: Promise<OAuthCallbackResult | OAuthCallbackErrorResult> = callbackPromise
    .then((code): OAuthCallbackResult => ({ type: "callback", code }))
    .catch((error): OAuthCallbackErrorResult => ({ type: "callbackError", error }));

  while (true) {
    const dialogAbortController = new AbortController();
    const choicePromise: Promise<OAuthWaitResult> = context.ui
      .select(
        `OAuth pending for ${serverName}`,
        [authRetryOption, authPasteOption, authCancelOption],
        { signal: dialogAbortController.signal },
      )
      .then((choice): OAuthUserChoiceResult => ({ type: "choice", choice }))
      .catch((error): OAuthDialogAbortedResult => {
        if (dialogAbortController.signal.aborted) {
          return { type: "dialogAborted" };
        }
        throw error;
      });

    const result = await Promise.race([callbackResultPromise, choicePromise]);

    if (result.type === "callback") {
      dialogAbortController.abort();
      return result.code;
    }

    if (result.type === "callbackError") {
      dialogAbortController.abort();
      throw result.error;
    }

    if (result.type === "dialogAborted") {
      continue;
    }

    if (result.choice === authRetryOption) {
      await reopenBrowser();
      continue;
    }

    if (result.choice === authPasteOption) {
      if (!context.ui.input) {
        continue;
      }
      const inputAbortController = new AbortController();
      const inputPromise: Promise<OAuthInputWaitResult> = context.ui
        .input(
          `Paste redirect URL for ${serverName}`,
          "http://127.0.0.1:19876/callback?code=...&state=...",
          { signal: inputAbortController.signal },
        )
        .then((value): OAuthUserInputResult => ({ type: "input", value }))
        .catch((error): OAuthDialogAbortedResult => {
          if (inputAbortController.signal.aborted) {
            return { type: "dialogAborted" };
          }
          throw error;
        });

      const inputResult = await Promise.race([callbackResultPromise, inputPromise]);

      if (inputResult.type === "callback") {
        inputAbortController.abort();
        return inputResult.code;
      }

      if (inputResult.type === "callbackError") {
        inputAbortController.abort();
        throw inputResult.error;
      }

      if (inputResult.type === "dialogAborted" || !inputResult.value?.trim()) {
        continue;
      }

      let parsed: ReturnType<typeof parseCallbackUrl>;
      try {
        parsed = parseCallbackUrl(inputResult.value, {
          redirectUrl: pasteOptions?.redirectUrl,
          expectedState: pasteOptions?.expectedState,
        });
      } catch (err) {
        if (err instanceof CallbackUrlValidationError) {
          context.ui.notify?.(`pi-mcp: Invalid redirect URL — ${err.message}`, "error");
          continue;
        }
        throw err;
      }

      pasteOptions?.onPasteResolved?.();
      if ("error" in parsed) {
        throw new Error(parsed.error);
      }
      return parsed.code;
    }

    dialogAbortController.abort();
    throw new AuthCancelledError(serverName);
  }
}

/** Resolve exact server names before interpreting the optional reset suffix. */
export function parseAuthArguments(args: string, serverNames: string[]): { name: string; reset: boolean } {
  const name = args.trim();
  if (serverNames.includes(name)) return { name, reset: false };
  const reset = /\s+--reset$/.test(name);
  return { name: reset ? name.replace(/\s+--reset$/, "").trimEnd() : name, reset };
}

interface ServerCompletionEntry {
  name: string;
  state: string;
  config: {
    transport: string;
    lifecycle: string;
    auth?: unknown;
  };
}

export function serverNameCompletions(
  argumentPrefix: string,
  servers: ServerCompletionEntry[],
  options: { authOnly?: boolean } = {},
) {
  const prefix = argumentPrefix.trimStart();
  const completions = servers
    .filter((server) => !options.authOnly || server.config.auth)
    .filter((server) => server.name.startsWith(prefix))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((server) => ({
      value: server.name,
      label: server.name,
      description: [
        server.state,
        server.config.transport,
        server.config.lifecycle,
        server.config.auth ? "OAuth" : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    }));

  return completions.length > 0 ? completions : null;
}

export default async function (pi: ExtensionAPI, paths: { bootstrapCwd?: string; globalConfigPath?: string; authStorageDir?: string; browserOpen?: (url: string) => void | Promise<void> } = {}): Promise<void> {
  // ── 1. Load and validate config ──────────────────────────────────────────
  // cwd is available on the ExtensionContext passed to event handlers.
  // We load config lazily on session_start to get the correct per-session cwd.
  // For the initial load we use process.cwd() as a bootstrap path to detect
  // whether any config exists at all.
  let config: McpConfig;
  try {
    config = await loadConfig(paths.bootstrapCwd ?? process.cwd(), paths.globalConfigPath);
  } catch (err) {
    // Can't notify yet (no ctx), so log to stderr. The session_start handler
    // will re-try with the real cwd and surface errors properly.
    console.error(`[pi-mcp] Config error: ${err instanceof McpError ? err.message : String(err)}`);
    return;
  }

  if (Object.keys(config.mcpServers).length === 0) {
    // No servers configured — silently exit. Users can create mcp.json later.
    return;
  }

  // ── 2. Initialize bridge components ──────────────────────────────────────
  const manager = new ServerManager(config, undefined, paths.authStorageDir);
  const bridge = new ToolBridge(config.settings, pi);
  const connectAttempts = new Map<string, { promise: Promise<void>; controller: AbortController; reset: boolean; waiters: number }>();
  let authQueue: Promise<void> = Promise.resolve();

  manager.setToolRefreshCallback(async (serverName, client) => {
    await bridge.refreshTools(serverName, client, () => {
      const server = manager.getServer(serverName);
      return server?.client === client && server.state !== "stopped";
    });
  });
  manager.setServerStoppedCallback((name) => bridge.deactivateServer(name));

  // ── 3. Session lifecycle ──────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    // Reload config with the real session cwd (project config may differ)
    let sessionConfig = config;
    try {
      sessionConfig = await loadConfig(ctx.cwd, paths.globalConfigPath);
    } catch (err) {
      const msg = err instanceof McpError ? err.userMessage : String(err);
      ctx.ui.notify(`pi-mcp: Config error — ${msg}`, "error");
      return;
    }

    // If config changed (different cwd with project-level overrides),
    // shut down old servers and rebuild the manager's server list
    if (JSON.stringify(sessionConfig) !== JSON.stringify(config)) {
      // Deactivate and remove all tools from old config
      for (const server of manager.getAllServers()) {
        bridge.removeServer(server.name);
      }
      // Shut down all running servers
      await manager.shutdownAll();
      // Rebuild server entries from new config
      manager.rebuildServers(sessionConfig);
      config = sessionConfig;
    }

    const eagerServers = Object.entries(sessionConfig.mcpServers).filter(
      ([, cfg]) => cfg.lifecycle === "eager",
    );

    // Start all eager servers concurrently
    await Promise.allSettled(
      eagerServers.map(async ([name]) => {
        try {
          await manager.startServer(name, ctx.cwd);
        } catch (err) {
          const msg = err instanceof McpError ? err.userMessage : String(err);
          ctx.ui.notify(`pi-mcp: Failed to start ${name} — ${msg}`, "error");
        }
      }),
    );
  });

  pi.on("session_shutdown", async (_event, _ctx: ExtensionContext) => {
    for (const attempt of connectAttempts.values()) attempt.controller.abort();
    await stopCallbackServer().catch(() => {});

    // Deactivate all tools before shutting down servers
    for (const server of manager.getAllServers()) {
      bridge.deactivateServer(server.name);
    }
    await manager.shutdownAll();
  });

  // ── 4. /mcp — show server status ─────────────────────────────────────────
  pi.registerCommand("mcp", {
    description:
      "Show MCP server status. Usage: /mcp [server-name] for detail.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const serverName = args.trim();
      if (serverName) {
        // Detailed view: status + recent stderr
        const server = manager.getServer(serverName);
        if (!server) {
          ctx.ui.notify(`pi-mcp: No server named "${serverName}"`, "error");
          return;
        }
        const logs = manager.getServerLogs(serverName);
        const detail = [
          `Server: ${serverName}`,
          `State:  ${server.state}`,
          `Retries: ${server.retryCount}`,
          server.lastError ? `Last error: ${server.lastError.message}` : null,
          "",
          "Recent output:",
          logs,
        ]
          .filter(Boolean)
          .join("\n");
        ctx.ui.notify(detail, "info");
      } else {
        // Summary view: all servers
        ctx.ui.notify(manager.getStatusSummary(), "info");
      }
    },
    getArgumentCompletions: (prefix) => serverNameCompletions(prefix, manager.getAllServers()),
  });

  // ── 5. /mcp:stop — stop a server ─────────────────────────────────────────
  pi.registerCommand("mcp:stop", {
    description: "Stop an MCP server. Usage: /mcp:stop <server-name>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const serverName = args.trim();
      if (!serverName) {
        ctx.ui.notify("Usage: /mcp:stop <server-name>", "error");
        return;
      }
      if (!manager.getServer(serverName)) {
        ctx.ui.notify(`pi-mcp: No server named "${serverName}"`, "error");
        return;
      }
      connectAttempts.get(serverName)?.controller.abort();
      bridge.deactivateServer(serverName);
      await manager.stopServer(serverName);
      ctx.ui.notify(`pi-mcp: Stopped ${serverName}`, "info");
    },
    getArgumentCompletions: (prefix) => serverNameCompletions(prefix, manager.getAllServers()),
  });

  // ── 6. /mcp:start — manually start a lazy server ─────────────────────────
  pi.registerCommand("mcp:start", {
    description: "Start an MCP server. Usage: /mcp:start <server-name>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const serverName = args.trim();
      if (!serverName) {
        ctx.ui.notify("Usage: /mcp:start <server-name>", "error");
        return;
      }
      if (!manager.getServer(serverName)) {
        ctx.ui.notify(`pi-mcp: No server named "${serverName}"`, "error");
        return;
      }
      try {
        await connectRequested(serverName, ctx);
        ctx.ui.notify(`pi-mcp: Started ${serverName}`, "info");
      } catch (err) {
        const msg = err instanceof McpError ? err.userMessage : String(err);
        ctx.ui.notify(`pi-mcp: Failed to start ${serverName} — ${msg}`, "error");
      }
    },
    getArgumentCompletions: (prefix) => serverNameCompletions(prefix, manager.getAllServers()),
  });

  async function authorize(serverName: string, ctx: ExtensionContext, signal: AbortSignal, reset: boolean): Promise<void> {
    const server = manager.getServer(serverName)!;
    const config = server.config;
    let oauthState: string | undefined;
    let latestAuthorizationUrl: URL | undefined;
    let lockLost = false;
    const cancel = () => { if (oauthState) cancelCallback(oauthState); };
    signal.addEventListener("abort", cancel, { once: true });
    let unlock: AuthLockHandle | undefined;
    try {
        if (signal.aborted) throw new AuthCancelledError(serverName);
        unlock = await acquireAuthLock(serverName, paths.authStorageDir, {
          onLost: () => {
            lockLost = true;
            cancel();
          },
        });
        if (signal.aborted) throw new AuthCancelledError(serverName);
        if (reset) {
          await unlock.assertHeld();
          await manager.resetServerAuth(serverName);
        }
        // Validate that we have a server URL (required for OAuth)
        if (!config.url) {
          throw new McpError(
            `Server "${serverName}" has OAuth configured but no URL. OAuth requires a URL-based server transport.`,
            serverName,
            "config",
          );
        }

        ctx.ui.notify(
          `pi-mcp: Starting OAuth flow for ${serverName}...`,
          "info",
        );

        if (!ctx.hasUI) throw new Error(`Authorization for ${serverName} requires an interactive Pi session`);
        if (signal.aborted) throw new AuthCancelledError(serverName);

        // 1. Start the callback server
        const callbackServerConfig = callbackServerConfigFromRedirectUrl(config.auth?.redirectUrl);
        const port = await ensureCallbackServer(callbackServerConfig.preferredPort, {
          host: callbackServerConfig.host,
          allowPortFallback: callbackServerConfig.allowPortFallback,
        });
        setCallbackPort(port);

        // 2. Generate a cryptographically secure state parameter for CSRF protection
        oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map((b: number) => b.toString(16).padStart(2, "0"))
          .join("");

        // 3. Create the auth provider.
        const launchAuthorizationBrowser = async (url: URL): Promise<void> => {
          if (!isSafeAuthorizationUrl(url)) {
            throw new McpError(
              `Refusing to open unsafe authorization URL for "${serverName}": only HTTPS (or loopback HTTP) URLs are allowed`,
              serverName,
              "protocol",
            );
          }
          latestAuthorizationUrl = new URL(url.toString());
          if (signal.aborted || lockLost) return;
          try {
            await (paths.browserOpen ?? openBrowser)(url.toString());
            ctx.ui.notify(
              `pi-mcp: Authorize ${serverName}: ${url.toString()} (On SSH, forward the callback with ssh -L ${port}:127.0.0.1:${port}, or choose "${authPasteOption}".)`,
              "info",
            );
          } catch (err) {
            ctx.ui.notify(
              `pi-mcp: Failed to open browser for ${serverName} (${err instanceof Error ? err.message : String(err)}). Open ${url.toString()} manually or choose "${authPasteOption}".`,
              "error",
            );
          }
        };

        const authProvider = new McpOAuthProvider(
          serverName,
          config.auth || { type: "oauth" },
          launchAuthorizationBrowser,
          paths.authStorageDir,
          false,
          () => signal.aborted,
          () => unlock!.assertHeld(),
        );

        // Why set state before calling auth(): the SDK reads provider.state() while
        // building the authorization URL inside auth(), and omits the state parameter
        // if empty, which the callback server then rejects as a CSRF error.
        authProvider.setState(oauthState);

        // 4. Discover protected-resource challenge metadata from the server.
        const authChallenge: ManualAuthChallenge = await discoverManualAuthChallenge(config.url, {
          headers: config.headers,
        }).catch((): ManualAuthChallenge => {
          console.warn(
            `[pi-mcp] Failed to discover OAuth challenge for "${serverName}"; falling back to standard discovery`,
          );
          return {};
        });

        // 5. Register the callback immediately before auth() can open the browser.
        // Attach a catch handler so cancellation after immediate authorization
        // does not produce an unhandled rejection.
        const callbackPromise = waitForCallback(oauthState);
        callbackPromise.catch(() => {});

        const authOptions: {
          serverUrl: string;
          resourceMetadataUrl?: URL;
          scope?: string;
        } = { serverUrl: config.url };
        if (authChallenge.resourceMetadataUrl) {
          authOptions.resourceMetadataUrl = authChallenge.resourceMetadataUrl;
        }
        if (authChallenge.scope) {
          authOptions.scope = authChallenge.scope;
        }

        // 6. Start the auth flow.
        // Why branch on the return value: the SDK auth() call returns "AUTHORIZED" when
        // stored or refreshed tokens already succeeded without opening a browser, or
        // "REDIRECT" after invoking redirectToAuthorization(), in which case we must
        // wait for the callback code and call auth() a second time with authorizationCode.
        const authResult = await auth(authProvider, authOptions);
        if (signal.aborted) throw new AuthCancelledError(serverName);
        if (lockLost) throw new AuthLockError(serverName, `Authorization lock lost for ${serverName}; retry`);

        if (authResult === "AUTHORIZED") {
          // Auth succeeded without needing browser interaction (e.g., had valid tokens).
          ctx.ui.notify(`pi-mcp: ${serverName} authenticated successfully. Starting MCP server...`, "info");
        } else if (authResult === "REDIRECT") {
          // 7. Wait for the callback while giving the user an escape hatch.
          const code = await waitForOAuthCallback(
            serverName,
            callbackPromise,
            () => {
              if (!latestAuthorizationUrl) {
                throw new McpError(
                  `Authorization URL is not available for ${serverName}`,
                  serverName,
                  "protocol",
                );
              }
              return launchAuthorizationBrowser(latestAuthorizationUrl);
            },
            ctx,
            {
              redirectUrl: authProvider.redirectUrl,
              expectedState: oauthState,
              onPasteResolved: cancel,
            },
          );
          if (signal.aborted) throw new AuthCancelledError(serverName);
          if (lockLost) throw new AuthLockError(serverName, `Authorization lock lost for ${serverName}; retry`);
          ctx.ui.notify(
            `pi-mcp: Authorization callback received for ${serverName}. Exchanging token...`,
            "info",
          );
          // 8. Complete the OAuth flow with the authorization code
          const finishAuthOptions: {
            serverUrl: string;
            authorizationCode: string;
            resourceMetadataUrl?: URL;
            scope?: string;
          } = {
            serverUrl: config.url,
            authorizationCode: code,
          };
          if (authChallenge.resourceMetadataUrl) {
            finishAuthOptions.resourceMetadataUrl = authChallenge.resourceMetadataUrl;
          }
          if (authChallenge.scope) {
            finishAuthOptions.scope = authChallenge.scope;
          }

          const finishAuthResult = await auth(authProvider, finishAuthOptions);

          if (finishAuthResult !== "AUTHORIZED") {
            throw new McpError(
              `Unexpected auth completion result: ${finishAuthResult}`,
              serverName,
              "protocol",
            );
          }

          ctx.ui.notify(`pi-mcp: ${serverName} authenticated successfully. Starting MCP server...`, "info");
        } else {
          throw new McpError(
            `Unexpected auth result: ${authResult}`,
            serverName,
            "protocol",
          );
        }

      if (signal.aborted) throw new AuthCancelledError(serverName);
      if (lockLost) throw new AuthLockError(serverName, `Authorization lock lost for ${serverName}; retry`);
    } catch (err) {
      if (lockLost && !signal.aborted) {
        throw new AuthLockError(serverName, `Authorization lock lost for ${serverName}; retry`);
      }
      throw err;
    } finally {
      signal.removeEventListener("abort", cancel);
      cancel();
      await stopCallbackServer().catch(() => {});
      await unlock?.();
    }
  }

  async function connectRequested(serverName: string, ctx: ExtensionContext, signal?: AbortSignal, reset = false): Promise<void> {
    const server = manager.getServer(serverName);
    if (!server) throw new McpError(`Unknown server "${serverName}"`, serverName, "config");
    if (signal?.aborted) throw new AuthCancelledError(serverName);
    if (reset && !server.config.auth) throw new McpError(`Server "${serverName}" has no OAuth configuration`, serverName, "config");
    if (reset && !ctx.hasUI) throw new AuthRequiredError(serverName);

    const waitForAttempt = async (entry: { promise: Promise<void>; controller: AbortController; reset: boolean; waiters: number }): Promise<void> => {
      entry.waiters++;
      let released = false;
      const releaseWaiter = () => {
        if (!released) {
          released = true;
          entry.waiters--;
        }
      };
      if (!signal) {
        try {
          return await entry.promise;
        } finally {
          releaseWaiter();
        }
      }
      let stopPromise: Promise<unknown> | undefined;
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          releaseWaiter();
          if (entry.waiters === 0) {
            entry.controller.abort();
            stopPromise = manager.stopServer(serverName);
            void stopPromise.finally(() => reject(new AuthCancelledError(serverName)));
          } else {
            reject(new AuthCancelledError(serverName));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([entry.promise, aborted]);
      } finally {
        signal.removeEventListener("abort", onAbort);
        releaseWaiter();
        await stopPromise;
      }
    };

    const existing = connectAttempts.get(serverName);
    // All requests join an in-flight reset. A reset supersedes a normal connect.
    if (existing && (!reset || existing.reset)) {
      return await waitForAttempt(existing);
    }

    const controller = new AbortController();
    if (existing) {
      existing.controller.abort();
      void manager.stopServer(serverName);
    }
    let entry!: { promise: Promise<void>; controller: AbortController; reset: boolean; waiters: number };
    const task = (async () => {
      // Wait for a superseded connect to release its callback listener and auth lock.
      if (existing) await existing.promise.catch(() => {});
      if (controller.signal.aborted) throw new AuthCancelledError(serverName);
      if (reset) {
        bridge.deactivateServer(serverName);
        await manager.stopServer(serverName);
        if (controller.signal.aborted) throw new AuthCancelledError(serverName);
      }
      try {
        if (!reset) await manager.startServer(serverName, ctx.cwd);
        else throw new AuthRequiredError(serverName);
        if (controller.signal.aborted) { await manager.stopServer(serverName); throw new AuthCancelledError(serverName); }
        return;
      } catch (err) {
        if (!(err instanceof AuthRequiredError) || !server.config.auth) throw err;
      }
      if (!ctx.hasUI) throw new AuthRequiredError(serverName);
      let release!: () => void;
      const previous = authQueue;
      authQueue = new Promise<void>((resolve) => { release = resolve; });
      try {
        await previous;
        if (controller.signal.aborted) throw new AuthCancelledError(serverName);
        await authorize(serverName, ctx, controller.signal, reset);
        if (controller.signal.aborted) throw new AuthCancelledError(serverName);
        await manager.startServer(serverName, ctx.cwd);
        if (controller.signal.aborted) { await manager.stopServer(serverName); throw new AuthCancelledError(serverName); }
      } finally {
        release();
      }
    })().catch((err: unknown) => {
      if (controller.signal.aborted) throw new AuthCancelledError(serverName);
      throw err;
    }).finally(() => {
      if (connectAttempts.get(serverName) === entry) connectAttempts.delete(serverName);
    });
    void task.catch(() => {});
    entry = { promise: task, controller, reset, waiters: 0 };
    connectAttempts.set(serverName, entry);
    return await waitForAttempt(entry);
  }

  pi.registerTool({
    name: "mcp_status",
    label: "MCP status",
    description: "List configured MCP servers, lifecycle, connection and OAuth state. Use mcp_connect to connect one server.",
    parameters: Type.Object({}),
    async execute() {
      const rows = await Promise.all(manager.getAllServers().map(async (server) => {
        const auth = server.config.auth ? await manager.getServerAuthStatus(server.name) : null;
        return {
          name: server.name, lifecycle: server.config.lifecycle, state: server.state,
          tools: bridge.getToolActivity(server.name),
          auth: server.config.auth ? auth?.hasTokens ? "credentials stored" : "authorization may be required" : "not configured",
          error: server.lastError
            ? server.lastError instanceof AuthRequiredError
              ? "Authorization required: use mcp_connect in an interactive Pi session"
              : `Connection ${server.lastError instanceof McpError ? server.lastError.code : "failed"}; use mcp_connect to retry`
            : undefined,
        };
      }));
      return { content: [{ type: "text", text: JSON.stringify(rows) }], details: {} };
    },
  });

  pi.registerTool({
    name: "mcp_connect",
    label: "Connect MCP server",
    description: "Connect one named configured MCP server and activate its tools. May request interactive OAuth authorization.",
    parameters: Type.Object({ name: Type.String({ description: "Exact configured MCP server name" }) }),
    async execute(_id, { name }, signal, _update, ctx) {
      try {
        await connectRequested(name, ctx, signal);
      } catch (err) {
        const message = signal?.aborted || err instanceof AuthCancelledError
          ? "MCP connection cancelled. Retry when ready."
          : !manager.getServer(name)
            ? "Unknown MCP server name. Use mcp_status to list configured servers."
            : err instanceof AuthLockError
              ? "Another Pi process is authorizing this server. Retry after it finishes."
              : err instanceof AuthRequiredError
                ? ctx.hasUI
                  ? "MCP authorization required. Retry with mcp_connect or /mcp:auth."
                  : "MCP authorization requires an interactive Pi session."
                : err instanceof McpError && err.code === "protocol"
                  ? "MCP tool discovery failed. Check the server and retry."
                  : "MCP connection failed. Check the server configuration and retry.";
        throw new Error(message);
      }
      const activity = bridge.getToolActivity(name);
      if (activity.active !== activity.discovered) {
        throw new Error("MCP server connected, but some discovered tools are inactive. Check Pi tool restrictions or extension conflicts; mcp_status reports discovered and active counts.");
      }
      return { content: [{ type: "text", text: `MCP server ${name} ready; tools discovered and active.` }], details: {} };
    },
  });

  pi.registerCommand("mcp:auth", {
    description: "Connect with OAuth; use /mcp:auth <name> --reset to discard stored credentials.",
    handler: async (args, ctx) => {
      const { name, reset } = parseAuthArguments(args, manager.getAllServers().map((server) => server.name));
      if (!name) { ctx.ui.notify("Usage: /mcp:auth <name> [--reset]", "error"); return; }
      if (!manager.getServer(name)?.config.auth) { ctx.ui.notify(`No OAuth server named ${name}`, "error"); return; }
      try { await connectRequested(name, ctx, undefined, reset); ctx.ui.notify(`pi-mcp: ${name} ready`, "info"); }
      catch (err) {
        ctx.ui.notify(`pi-mcp: ${err instanceof Error ? err.message : String(err)}`, err instanceof AuthCancelledError ? "info" : "error");
      }
    },
    getArgumentCompletions: (prefix) => serverNameCompletions(prefix, manager.getAllServers(), { authOnly: true }),
  });
}
