/**
 * Registers `/mcp`, `/mcp:stop`, `/mcp:start`, and `/mcp:auth` commands on Pi's ExtensionAPI.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  parseAuthArguments,
  serverNameCompletions,
} from "./commands.js";
import {
  type ConnectionCoordinator,
  formatErrorMessage,
} from "./connection-coordinator.js";
import { AuthCancelledError } from "./errors.js";
import type { ServerManager } from "./server-manager.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import type { ToolBridge } from "./tool-bridge.js";

export interface RegisterCommandsDeps {
  manager: ServerManager;
  coordinator: ConnectionCoordinator;
  bridge: ToolBridge;
}

export function registerCommands(pi: ExtensionAPI, deps: RegisterCommandsDeps): void {
  const { manager, coordinator, bridge } = deps;

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
