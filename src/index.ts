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
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { agentDir } from "./config.js";
import type { ConfigProvenance } from "./server-provenance.js";
import {
  SessionLifecycle,
  loadBootstrapConfigState,
} from "./session-lifecycle.js";
import { registerCommands } from "./register-commands.js";
import { registerManagementTools } from "./register-tools.js";
import { ServerManager, type ManagedServer } from "./server-manager.js";
import { ToolBridge } from "./tool-bridge.js";
import { ResourceBridge } from "./resource-bridge.js";
import { ConnectionCoordinator } from "./connection-coordinator.js";
import { CallbackServer } from "./callback-server.js";
import { authorize as runAuthorize } from "./authorize-flow.js";
import {
  DebugLog,
  isDebugLogEnabled,
  setDebugLog,
} from "./debug-log.js";

export {
  startupAuthNowOption,
  startupAuthLaterOption,
} from "./connection-coordinator.js";

export default async function (pi: ExtensionAPI, paths: { bootstrapCwd?: string; globalConfigPath?: string; authStorageDir?: string; browserOpen?: (url: string) => void | Promise<void>; callbackServer?: CallbackServer } = {}): Promise<void> {
  // ── 0. Opt-in diagnostic log ───────────────────────────────────────────────
  // WHY: The debug log is created before anything else so bootstrap failures
  // are captured too. The file is only touched when the first event is written.
  if (isDebugLogEnabled()) {
    setDebugLog(new DebugLog(join(agentDir(), "logs")));
  }

  // ── 1. Load and validate config ──────────────────────────────────────────
  const initialState = await loadBootstrapConfigState(pi, paths);

  // ── 2. Initialize bridge components ──────────────────────────────────────
  const manager = new ServerManager(initialState.config, paths.authStorageDir);
  const bridge = new ToolBridge(initialState.config.settings, pi);
  const resources = new ResourceBridge();
  const callbackServer = paths.callbackServer ?? new CallbackServer();
  const coordinator: ConnectionCoordinator = new ConnectionCoordinator({
    manager,
    bridge,
    getConfig: () => lifecycle.getConfig(),
    authorize: (name, ctx, signal, reset) => authorize(name, ctx, signal, reset),
    stopCallbackServer: () => callbackServer.stop(),
  });
  const lifecycle: SessionLifecycle = new SessionLifecycle({
    pi,
    globalConfigPath: paths.globalConfigPath,
    initialState,
    manager,
    coordinator,
    bridge,
    resources,
  });

  manager.setToolRefreshCallback(async (serverName, client, options) => {
    const server = manager.getServer(serverName);
    const requestTimeoutMs =
      options?.requestTimeoutMs ??
      server?.config.requestTimeoutMs ??
      lifecycle.getConfig().settings.requestTimeoutMs;
    await bridge.refreshTools(
      serverName,
      client,
      () => isClientActive(manager, serverName, client),
      {
        ...options,
        requestTimeoutMs,
      },
    );
  });
  manager.setServerStoppedCallback((name) => {
    bridge.deactivateServer(name);
    resources.forget(name);
  });
  manager.setRecoveryFailedCallback((serverName, error) => {
    coordinator.handleRecoveryFailed(serverName, error);
  });
  manager.setServerReadyCallback(() => {
    // WHY: Eager starts and background _recover() reconnects never pass through
    // coordinator.connect(), so without this the "run /mcp:auth <name>" footer hint
    // survives a server that has since connected cleanly.
    coordinator.syncStatus();
  });
  manager.setResourceListChangedCallback((name) => {
    // WHY: resources are listed on demand, so a notification only has to make the cached
    // catalog stale; the next read re-fetches it from the same client.
    resources.invalidate(name);
  });
  const handleAuthError = async (serverName: string): Promise<void> => {
    const authError = await manager.handleUnauthorizedServerError(serverName);
    if (authError) {
      // WHY: A mid-session 401/403 stops the server synchronously, which cancels the
      // deferred _recover() that would have called onRecoveryFailed — so report the
      // failure here or the re-auth warning and the footer hint never appear.
      coordinator.handleRecoveryFailed(serverName, authError);
    }
  };
  bridge.setAuthErrorCallback(handleAuthError);
  // WHY: a resources/* request can be the first call to hit an expired token, so it needs
  // the same re-authorization path as tools/call.
  resources.setAuthErrorCallback(handleAuthError);

  // ── 3. Session lifecycle ──────────────────────────────────────────────────
  pi.on("session_start", (_event, ctx: ExtensionContext) => lifecycle.handleSessionStart(ctx));
  // Connect or disconnect MCP servers registered dynamically via pi.registerMcpServer().
  pi.on("mcp_servers_change", (event, ctx: ExtensionContext) =>
    lifecycle.handleServersChange(event, ctx),
  );

  // Keep active and outgoing tool order independent of connect timing, `/tree` transcript
  // restoration, idle/mid-turn external `setActiveTools` reorderings (e.g. `tool_search` before
  // continuation `sections.tools`, or idle shortcuts before `before_agent_start` snapshots
  // `systemPromptOptions`), and first-appearance transcript replay (#278).
  const normalizeActiveTools = (): void => {
    bridge.orderActiveTools();
  };
  pi.on("session_tree", normalizeActiveTools);
  pi.on("input", normalizeActiveTools);
  pi.on("before_agent_start", normalizeActiveTools);
  pi.on("tool_execution_end", normalizeActiveTools);
  pi.on("before_provider_request", (event) => bridge.orderPayloadTools(event.payload));

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) =>
    lifecycle.handleSessionShutdown(ctx),
  );

  // ── 4. Slash commands ───────────────────────────────────────────────────
  const getProvenance = (): ConfigProvenance => lifecycle.getProvenance();
  registerCommands(pi, { manager, coordinator, bridge, resources, getProvenance });

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

  registerManagementTools(pi, { manager, coordinator, bridge, resources, getProvenance });
}

function isClientActive(
  manager: ServerManager,
  serverName: string,
  client: ManagedServer["client"],
): boolean {
  const current = manager.getServer(serverName);
  return current?.client === client && current.state !== "stopped";
}
