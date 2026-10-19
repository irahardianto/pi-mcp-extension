/**
 * pi-mcp — MCP client extension for the Pi coding agent.
 *
 * Entry point registered in package.json under "pi.extensions".
 * Pi loads this file via jiti (TypeScript executed directly, no build step).
 *
 * Wires together: config → server manager → tool bridge → Pi API.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  RegisteredMcpServer,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type McpConfig, type ServerConfig } from "./config.js";
import {
  collectRegisteredServers,
  mergeWithRegisteredServers,
  parseAuthArguments,
  serverNameCompletions,
} from "./commands.js";
import { ServerManager } from "./server-manager.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import { AuthLockError, AuthRequiredError } from "./oauth-provider.js";
import * as Type from "typebox";
import { ToolBridge } from "./tool-bridge.js";
import { McpError, AuthCancelledError } from "./errors.js";
import {
  ConnectionCoordinator,
  formatErrorMessage,
} from "./connection-coordinator.js";
import { CallbackServer } from "./callback-server.js";
import { authorize as runAuthorize } from "./authorize-flow.js";

export {
  startupAuthNowOption,
  startupAuthLaterOption,
} from "./connection-coordinator.js";

const DEFAULT_SETTINGS = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 } as const;

export default async function (pi: ExtensionAPI, paths: { bootstrapCwd?: string; globalConfigPath?: string; authStorageDir?: string; browserOpen?: (url: string) => void | Promise<void>; callbackServer?: CallbackServer } = {}): Promise<void> {
  // ── 1. Load and validate config ──────────────────────────────────────────
  // cwd and project trust are available on the ExtensionContext passed to event handlers.
  // At bootstrap (before session_start) we load ONLY the global config so untrusted
  // <cwd>/.pi/mcp.json files are never read before ctx.isProjectTrusted() is checked.
  let fileConfig: McpConfig = {
    settings: { ...DEFAULT_SETTINGS },
    mcpServers: {},
  };
  try {
    fileConfig = await loadConfig(paths.bootstrapCwd ?? process.cwd(), paths.globalConfigPath, {
      includeProjectConfig: false,
    });
  } catch (err) {
    // Can't notify yet (no ctx), so log to stderr. The session_start handler
    // will re-try with the real cwd and surface errors properly.
    console.error(`[pi-mcp] Config error: ${sanitizeTerminalText(err instanceof McpError ? err.message : String(err))}`);
  }

  const getRegisteredEntries = (): RegisteredMcpServer[] =>
    typeof (pi as { getMcpServers?: () => RegisteredMcpServer[] }).getMcpServers === "function"
      ? pi.getMcpServers()
      : [];

  let extensionServers = collectRegisteredServers(
    getRegisteredEntries(),
    fileConfig.mcpServers,
    (err) => console.error(`[pi-mcp] Config error: ${sanitizeTerminalText(err instanceof McpError ? err.message : String(err))}`),
  );
  let config: McpConfig = mergeWithRegisteredServers(fileConfig, extensionServers);

  // ── 2. Initialize bridge components ──────────────────────────────────────
  const manager = new ServerManager(config, paths.authStorageDir);
  const bridge = new ToolBridge(config.settings, pi);
  const callbackServer = paths.callbackServer ?? new CallbackServer();
  const coordinator = new ConnectionCoordinator({
    manager,
    bridge,
    getConfig: () => config,
    authorize: (name, ctx, signal, reset) => authorize(name, ctx, signal, reset),
    stopCallbackServer: () => callbackServer.stop(),
  });

  manager.setToolRefreshCallback(async (serverName, client, options) => {
    const server = manager.getServer(serverName);
    const requestTimeoutMs =
      options?.requestTimeoutMs ??
      server?.config.requestTimeoutMs ??
      config.settings.requestTimeoutMs;
    await bridge.refreshTools(
      serverName,
      client,
      () => {
        const current = manager.getServer(serverName);
        return current?.client === client && current.state !== "stopped";
      },
      {
        ...options,
        requestTimeoutMs,
      },
    );
  });
  manager.setServerStoppedCallback((name) => bridge.deactivateServer(name));
  manager.setRecoveryFailedCallback((serverName, error) => {
    coordinator.handleRecoveryFailed(serverName, error);
  });
  bridge.setAuthErrorCallback(async (serverName) => {
    await manager.handleUnauthorizedServerError(serverName);
  });

  // ── 3. Session lifecycle ──────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    coordinator.setActiveContext(ctx);
    // Only load project-level <cwd>/.pi/mcp.json when the project is trusted.
    const includeProjectConfig =
      typeof (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted === "function"
        ? (ctx as { isProjectTrusted: () => boolean }).isProjectTrusted()
        : true;

    let nextFileConfig: McpConfig;
    try {
      nextFileConfig = await loadConfig(ctx.cwd, paths.globalConfigPath, { includeProjectConfig });
    } catch (err) {
      const msg = formatErrorMessage(err);
      ctx.ui.notify(`pi-mcp: Config error — ${msg}`, "error");
      // WHY: Switching sessions into a directory with an invalid config must tear down stale
      // servers, tools, prompts, and status from the previous session rather than leaving them active.
      await coordinator.teardown(ctx);
      fileConfig = {
        settings: { ...DEFAULT_SETTINGS },
        mcpServers: {},
      };
      extensionServers = collectRegisteredServers(
        getRegisteredEntries(),
        fileConfig.mcpServers,
        (regErr) => {
          const regMsg = formatErrorMessage(regErr);
          ctx.ui.notify(`pi-mcp: Config error — ${regMsg}`, "error");
        },
      );
      config = mergeWithRegisteredServers(fileConfig, extensionServers);
      bridge.updateSettings(config.settings);
      manager.rebuildServers(config);
      if (Object.keys(extensionServers).length > 0) {
        const eagerServers = Object.entries(config.mcpServers).filter(
          ([, cfg]) => cfg.lifecycle === "eager",
        );
        await coordinator.startEagerServers(eagerServers, ctx);
      }
      return;
    }

    fileConfig = nextFileConfig;
    extensionServers = collectRegisteredServers(
      getRegisteredEntries(),
      fileConfig.mcpServers,
      (err) => {
        const msg = formatErrorMessage(err);
        ctx.ui.notify(`pi-mcp: Config error — ${msg}`, "error");
      },
    );
    const sessionConfig = mergeWithRegisteredServers(fileConfig, extensionServers);

    // If config changed (different cwd with project-level overrides or registered servers),
    // shut down old servers and rebuild the manager's server list
    if (JSON.stringify(sessionConfig) !== JSON.stringify(config)) {
      await coordinator.teardown(ctx);
      // Rebuild server entries from new config
      bridge.updateSettings(sessionConfig.settings);
      manager.rebuildServers(sessionConfig);
      config = sessionConfig;
    } else {
      // WHY: Even when config is identical across session switches, update running servers'
      // cwd and emit notifications/roots/list_changed if the workspace directory changed.
      manager.updateCwd(ctx.cwd);
      coordinator.syncStatus(ctx);
    }

    const eagerServers = Object.entries(sessionConfig.mcpServers).filter(
      ([, cfg]) => cfg.lifecycle === "eager",
    );

    await coordinator.startEagerServers(eagerServers, ctx);
  });

  // Connect or disconnect MCP servers registered dynamically via pi.registerMcpServer().
  pi.on("mcp_servers_change", async (event, ctx: ExtensionContext) => {
    coordinator.setActiveContext(ctx);
    const entries = Array.isArray((event as { servers?: unknown })?.servers)
      ? ((event as { servers: RegisteredMcpServer[] }).servers)
      : getRegisteredEntries();

    const nextExtensionServers = collectRegisteredServers(
      entries,
      fileConfig.mcpServers,
      (err) => {
        const msg = formatErrorMessage(err);
        ctx.ui.notify(`pi-mcp: Config error — ${msg}`, "error");
      },
    );

    const removedOrChanged: string[] = [];
    for (const [name, prevCfg] of Object.entries(extensionServers)) {
      const nextCfg = nextExtensionServers[name];
      if (!nextCfg || JSON.stringify(prevCfg) !== JSON.stringify(nextCfg)) {
        removedOrChanged.push(name);
      }
    }

    for (const name of removedOrChanged) {
      coordinator.cancelServer(name);
      bridge.removeServer(name);
      await manager.removeServer(name);
    }
    if (removedOrChanged.length > 0) {
      coordinator.syncStatus(ctx);
    }

    const addedEager: Array<[string, ServerConfig]> = [];
    for (const [name, nextCfg] of Object.entries(nextExtensionServers)) {
      if (!manager.getServer(name)) {
        manager.setServer(name, nextCfg);
        if (nextCfg.lifecycle === "eager") {
          addedEager.push([name, nextCfg]);
        }
      }
    }

    extensionServers = nextExtensionServers;
    config = mergeWithRegisteredServers(fileConfig, extensionServers);

    if (addedEager.length > 0) {
      await coordinator.startEagerServers(addedEager, ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    await coordinator.teardown(ctx, { removeServers: false });
    coordinator.setActiveContext(undefined);
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
          server.lastError ? `Last error: ${sanitizeTerminalText(server.lastError.message)}` : null,
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
      coordinator.cancelServer(serverName);
      coordinator.syncStatus(ctx);
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
        await coordinator.connect(serverName, ctx);
        ctx.ui.notify(`pi-mcp: Started ${serverName}`, "info");
      } catch (err) {
        if (err instanceof AuthCancelledError) {
          ctx.ui.notify(`pi-mcp: ${sanitizeTerminalText(err.message)}`, "info");
          return;
        }
        const msg = formatErrorMessage(err);
        ctx.ui.notify(`pi-mcp: Failed to start ${serverName} — ${msg}`, "error");
      }
    },
    getArgumentCompletions: (prefix) => serverNameCompletions(prefix, manager.getAllServers()),
  });

  const authorize = (serverName: string, ctx: ExtensionContext, signal: AbortSignal, reset: boolean) =>
    runAuthorize(
      {
        manager,
        getServerConfig: (name) => manager.getServer(name)?.config,
        authStorageDir: paths.authStorageDir,
        openBrowser: paths.browserOpen,
        callbackServer,
      },
      serverName,
      ctx,
      signal,
      reset,
    );

  pi.registerTool({
    name: "mcp_status",
    label: "MCP status",
    description: "List configured MCP servers, lifecycle, connection and OAuth state. Use mcp_connect to connect one server.",
    promptSnippet: "Inspect configured MCP servers, their connection state, discovered tools, and authentication status.",
    parameters: Type.Object({}),
    async execute() {
      const rows = await Promise.all(manager.getAllServers().map(async (server) => {
        let auth: Awaited<ReturnType<typeof manager.getServerAuthStatus>> = null;
        let authCorrupt = false;
        if (server.config.auth) {
          try {
            auth = await manager.getServerAuthStatus(server.name);
          } catch (err) {
            // WHY: Never let a single server's corrupt state file abort mcp_status for all servers.
            // getAuthStatus() already backed up and deleted the corrupt file before throwing.
            console.error(`[pi-mcp] ${sanitizeTerminalText(err instanceof Error ? err.message : String(err))}`);
            authCorrupt = true;
          }
        }
        return {
          name: server.name, lifecycle: server.config.lifecycle, state: server.state,
          tools: bridge.getToolActivity(server.name),
          auth: server.config.auth
            ? authCorrupt
              ? "corrupt state file backed up (re-auth required)"
              : auth?.hasTokens
                ? "credentials stored"
                : "authorization may be required"
            : "not configured",
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
    promptSnippet: "Connect or reconnect to a configured MCP server by name and register its tools.",
    parameters: Type.Object({ name: Type.String({ description: "Exact configured MCP server name" }) }),
    async execute(_id, { name }, signal, _update, ctx) {
      try {
        await coordinator.connect(name, ctx, { signal });
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
      if (!reset && manager.getServer(name)?.state === "ready") {
        // WHY: Explicit /mcp:auth on an already-ready server must tear down the existing
        // connection and force a fresh reconnect/auth check rather than returning a no-op.
        bridge.deactivateServer(name);
        await manager.stopServer(name);
      }
      try { await coordinator.connect(name, ctx, { reset }); ctx.ui.notify(`pi-mcp: ${name} ready`, "info"); }
      catch (err) {
        ctx.ui.notify(`pi-mcp: ${sanitizeTerminalText(err instanceof Error ? err.message : String(err))}`, err instanceof AuthCancelledError ? "info" : "error");
      }
    },
    getArgumentCompletions: (prefix) => serverNameCompletions(prefix, manager.getAllServers(), { authOnly: true }),
  });
}
