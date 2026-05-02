/**
 * pi-mcp — MCP client extension for the Pi coding agent.
 *
 * Entry point registered in package.json under "pi.extensions".
 * Pi loads this file via jiti (TypeScript executed directly, no build step).
 *
 * Wires together: config → server manager → tool bridge → Pi API.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config.js";
import { ServerManager } from "./server-manager.js";
import type { TransportAuthCallbacks } from "./server-manager.js";
import { ToolBridge } from "./tool-bridge.js";
import { McpError } from "./errors.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Open a URL in the user's default browser.
 * Works on macOS, Linux, and Windows.
 */
function openBrowser(url: string): void {
  const cmd = process.platform === "darwin"
    ? `open "${url}"`
    : process.platform === "win32"
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.error(`[pi-mcp] Failed to open browser: ${err.message}`);
  });
}

export default async function (pi: ExtensionAPI): Promise<void> {
  // ── 1. Load and validate config ──────────────────────────────────────────
  // cwd is available on the ExtensionContext passed to event handlers.
  // We load config lazily on session_start to get the correct per-session cwd.
  // For the initial load we use process.cwd() as a bootstrap path to detect
  // whether any config exists at all.
  let config;
  try {
    config = await loadConfig(process.cwd());
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
  // Auth callbacks — opens browser and notifies user when OAuth is needed
  const authCallbacks: TransportAuthCallbacks = {
    onAuthRequired: (serverName: string, authorizationUrl: URL): void => {
      console.error(
        `[pi-mcp] OAuth required for "${serverName}". Opening browser for authorization...`,
      );
      openBrowser(authorizationUrl.toString());
    },
  };

  const manager = new ServerManager(config, authCallbacks);
  const bridge = new ToolBridge(config.settings, pi);

  // Connect tool refresh callback: called on connect and on list_changed
  manager.setToolRefreshCallback(async (serverName, client) => {
    await bridge.refreshTools(serverName, client);
  });

  // ── 3. Session lifecycle ──────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    // Reload config with the real session cwd (project config may differ)
    let sessionConfig = config;
    try {
      sessionConfig = await loadConfig(ctx.cwd);
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
      bridge.deactivateServer(serverName);
      await manager.stopServer(serverName);
      ctx.ui.notify(`pi-mcp: Stopped ${serverName}`, "info");
    },
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
        await manager.startServer(serverName, ctx.cwd);
        ctx.ui.notify(`pi-mcp: Started ${serverName}`, "info");
      } catch (err) {
        const msg = err instanceof McpError ? err.userMessage : String(err);
        ctx.ui.notify(`pi-mcp: Failed to start ${serverName} — ${msg}`, "error");
      }
    },
  });

  // ── 7. /mcp:auth — trigger OAuth authentication for a server ────────────────
  pi.registerCommand("mcp:auth", {
    description:
      "Trigger OAuth authentication for a server. Resets credentials and opens browser for re-authorization. Usage: /mcp:auth <server-name>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const serverName = args.trim();
      if (!serverName) {
        // List servers with auth config
        const authServers = manager.getAllServers().filter((s) => s.config.auth);
        if (authServers.length === 0) {
          ctx.ui.notify(
            "pi-mcp: No servers with OAuth configured. Add `auth: { type: \"oauth\" }` to a server in mcp.json.",
            "error",
          );
          return;
        }
        const lines = authServers.map(async (s) => {
          const status = await manager.getServerAuthStatus(s.name);
          const authIcon = status?.hasTokens ? "\u2705 authenticated" : "\u274C not authenticated";
          const savedInfo = status?.savedAt ? ` (since ${status.savedAt})` : "";
          return `  ${s.name}: ${authIcon}${savedInfo}`;
        });
        const statusLines = await Promise.all(lines);
        ctx.ui.notify(
          [
            "Usage: /mcp:auth <server-name>",
            "",
            "OAuth-enabled servers:",
            ...statusLines,
          ].join("\n"),
          "info",
        );
        return;
      }
      const server = manager.getServer(serverName);
      if (!server) {
        ctx.ui.notify(`pi-mcp: No server named "${serverName}"`, "error");
        return;
      }
      if (!server.config.auth) {
        ctx.ui.notify(
          `pi-mcp: Server "${serverName}" does not have OAuth configured. Add \`auth: { type: "oauth" }\` to its config in mcp.json.`,
          "error",
        );
        return;
      }

      try {
        // Stop the server if running
        if (server.state !== "stopped") {
          bridge.deactivateServer(serverName);
          await manager.stopServer(serverName);
        }
        // Reset all OAuth credentials (tokens, client info, PKCE, discovery)
        await manager.resetServerAuth(serverName);
        ctx.ui.notify(
          `pi-mcp: Reset credentials for ${serverName}. Starting server — a browser window will open for authentication...`,
          "info",
        );
        // Start the server — this triggers the OAuth flow and opens the browser
        await manager.startServer(serverName, ctx.cwd);

        const newStatus = await manager.getServerAuthStatus(serverName);
        if (newStatus?.hasTokens) {
          ctx.ui.notify(`pi-mcp: ${serverName} authenticated successfully!`, "info");
        } else {
          ctx.ui.notify(
            `pi-mcp: ${serverName} started but authentication may still be in progress. Check the browser window.`,
            "info",
          );
        }
      } catch (err) {
        const msg = err instanceof McpError ? err.userMessage : String(err);
        ctx.ui.notify(`pi-mcp: Authentication failed for ${serverName} — ${msg}`, "error");
      }
    },
  });
}
