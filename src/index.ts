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
  RegisteredMcpServer,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  agentDir,
  loadConfigWithOrigins,
  type LoadedConfig,
  type McpConfig,
  type ServerConfig,
} from "./config.js";
import {
  lookupServerSource,
  withExtensionServers,
  type ConfigProvenance,
  type ConfigProvenanceInput,
} from "./server-provenance.js";
import {
  collectRegisteredServers,
  mergeWithRegisteredServers,
} from "./commands.js";
import { registerCommands } from "./register-commands.js";
import { ServerManager, type ManagedServer } from "./server-manager.js";
import {
  collectServerStatus,
  toStatusRow,
  type ServerStatusRow,
} from "./server-status.js";
import { AuthLockError, AuthRequiredError } from "./oauth-provider.js";
import * as Type from "typebox";
import { ToolBridge } from "./tool-bridge.js";
import {
  ResourceBridge,
  type McpResourceDefinition,
  type McpResourceTemplateDefinition,
  type PiResourceContent,
} from "./resource-bridge.js";
import { McpError, AuthCancelledError } from "./errors.js";
import {
  ConnectionCoordinator,
  formatErrorMessage,
} from "./connection-coordinator.js";
import { CallbackServer } from "./callback-server.js";
import { authorize as runAuthorize } from "./authorize-flow.js";
import {
  DebugLog,
  describeError,
  getDebugLog,
  isDebugLogEnabled,
  reportDiagnostic,
  setDebugLog,
  setDiagnosticUi,
} from "./debug-log.js";

export {
  startupAuthNowOption,
  startupAuthLaterOption,
} from "./connection-coordinator.js";

const DEFAULT_SETTINGS = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 } as const;

export default async function (pi: ExtensionAPI, paths: { bootstrapCwd?: string; globalConfigPath?: string; authStorageDir?: string; browserOpen?: (url: string) => void | Promise<void>; callbackServer?: CallbackServer } = {}): Promise<void> {
  // ── 0. Opt-in diagnostic log ───────────────────────────────────────────────
  // WHY: The debug log is created before anything else so bootstrap failures
  // are captured too. The file is only touched when the first event is written.
  if (isDebugLogEnabled()) {
    setDebugLog(new DebugLog(join(agentDir(), "logs")));
  }

  // ── 1. Load and validate config ──────────────────────────────────────────
  // cwd and project trust are available on the ExtensionContext passed to event handlers.
  // At bootstrap (before session_start) we load ONLY the global config so untrusted
  // <cwd>/.pi/mcp.json files are never read before ctx.isProjectTrusted() is checked.
  let fileConfig: McpConfig = {
    settings: { ...DEFAULT_SETTINGS },
    mcpServers: {},
  };
  // Where each configured server came from. The bootstrap load skips the project
  // config (trust is unknown before session_start), so this is replaced on the
  // first session_start with the provenance of the config actually in effect.
  let fileProvenance: ConfigProvenanceInput = {
    origins: {},
    projectConfigPath: join(paths.bootstrapCwd ?? process.cwd(), ".pi", "mcp.json"),
    projectConfigIncluded: false,
  };
  try {
    const loaded = await loadConfigWithOrigins(paths.bootstrapCwd ?? process.cwd(), paths.globalConfigPath, {
      includeProjectConfig: false,
    });
    fileConfig = loaded.config;
    fileProvenance = loaded;
  } catch (err) {
    // Can't notify yet (no ctx), so the diagnostic goes to stderr (and to the
    // debug log when it is enabled). The session_start handler will re-try with
    // the real cwd and surface errors properly.
    const { kind, message } = describeError(err);
    reportDiagnostic({
      level: "error",
      event: "config.error",
      message: `Config error: ${message}`,
      fields: { kind },
    });
  }

  const getRegisteredEntries = (): RegisteredMcpServer[] =>
    typeof (pi as { getMcpServers?: () => RegisteredMcpServer[] }).getMcpServers === "function"
      ? pi.getMcpServers()
      : [];

  let extensionServers = collectRegisteredServers(
    getRegisteredEntries(),
    fileConfig.mcpServers,
    (err) => {
      const { kind, message } = describeError(err);
      reportDiagnostic({
        level: "error",
        event: "config.error",
        message: `Config error: ${message}`,
        fields: { kind },
      });
    },
  );
  let config: McpConfig = mergeWithRegisteredServers(fileConfig, extensionServers);

  // ── 2. Initialize bridge components ──────────────────────────────────────
  const manager = new ServerManager(config, paths.authStorageDir);
  const bridge = new ToolBridge(config.settings, pi);
  const resources = new ResourceBridge();
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
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    coordinator.setActiveContext(ctx);
    // WHY: While a UI is active, the extension never writes to Pi's stderr —
    // the TUI owns that stream. Diagnostics go to the debug log instead, and
    // user-actionable ones are surfaced through ctx.ui.notify(...).
    setDiagnosticUi(ctx.ui, ctx.hasUI);
    reportDiagnostic({
      level: "info",
      event: "session.started",
      message: `pi-mcp session started in ${ctx.cwd}`,
      fields: { outcome: "started" },
    });
    // Only load project-level <cwd>/.pi/mcp.json when the project is trusted.
    const includeProjectConfig =
      typeof (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted === "function"
        ? (ctx as { isProjectTrusted: () => boolean }).isProjectTrusted()
        : true;

    let nextLoaded: LoadedConfig;
    try {
      nextLoaded = await loadConfigWithOrigins(ctx.cwd, paths.globalConfigPath, { includeProjectConfig });
    } catch (err) {
      const msg = formatErrorMessage(err);
      ctx.ui.notify(`pi-mcp: Config error — ${msg}`, "error");
      // WHY: A config that failed to parse still supplies no server origins, so the
      // provenance must not keep pointing at the previous session's file entries.
      fileProvenance = {
        origins: {},
        projectConfigPath: join(ctx.cwd, ".pi", "mcp.json"),
        projectConfigIncluded: includeProjectConfig,
      };
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

    fileConfig = nextLoaded.config;
    fileProvenance = nextLoaded;
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
      reportDiagnostic({
        level: "info",
        event: "session.reload",
        message: "MCP configuration changed; reloading servers and tools",
        fields: { outcome: "config_changed" },
      });
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
    setDiagnosticUi(ctx.ui, ctx.hasUI);
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
      resources.forget(name);
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
    reportDiagnostic({
      level: "info",
      event: "session.teardown",
      message: "pi-mcp session shutting down",
      fields: { outcome: "shutdown" },
    });
    await coordinator.teardown(ctx, { removeServers: false });
    coordinator.setActiveContext(undefined);
    setDiagnosticUi(null, false);
    // WHY: Flush the queued debug-log writes before the process may exit, so a
    // bug report attached right after the session ends is not missing events.
    await getDebugLog()?.flush();
  });

  // ── 4. Slash commands ───────────────────────────────────────────────────
  const getProvenance = (): ConfigProvenance =>
    withExtensionServers(fileProvenance, Object.keys(extensionServers));
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

interface ManagementToolDeps {
  manager: ServerManager;
  coordinator: ConnectionCoordinator;
  bridge: ToolBridge;
  resources: ResourceBridge;
  getProvenance: () => ConfigProvenance;
}

/** One `mcp_status` row: state, tool counts, credential summary, error hint, and config source. */
function collectStatusRow(
  server: ManagedServer,
  deps: ManagementToolDeps,
  provenance: ConfigProvenance,
): Promise<ServerStatusRow> {
  return collectServerStatus({
    server,
    tools: deps.bridge.getToolActivity(server.name),
    source: lookupServerSource(provenance, server.name),
    readAuthStatus: (name) => deps.manager.getServerAuthStatus(name),
  }).then(toStatusRow);
}

interface McpConnectErrorOptions {
  aborted: boolean;
  serverExists: boolean;
  hasUI: boolean;
}

function formatMcpAuthError(err: unknown, hasUI: boolean): string | undefined {
  if (err instanceof AuthLockError) {
    return "Another Pi process is authorizing this server. Retry after it finishes.";
  }
  if (err instanceof AuthRequiredError) {
    return hasUI
      ? "MCP authorization required. Retry with mcp_connect or /mcp:auth."
      : "MCP authorization requires an interactive Pi session.";
  }
  return undefined;
}

function formatMcpConnectFailureMessage(err: unknown): string {
  if (err instanceof McpError && err.code === "protocol") {
    return "MCP tool discovery failed. Check the server and retry.";
  }
  // WHY: a request timeout means the server was reachable but too slow, so pointing at the
  // configuration would send the user down the wrong path (#209).
  if (err instanceof McpError && err.code === "timeout") {
    return "MCP server did not respond in time. Check that it is running and retry.";
  }
  return "MCP connection failed. Check the server configuration and retry.";
}

function formatMcpConnectError(err: unknown, options: McpConnectErrorOptions): string {
  if (options.aborted || err instanceof AuthCancelledError) {
    return "MCP connection cancelled. Retry when ready.";
  }
  if (!options.serverExists) {
    return "Unknown MCP server name. Use mcp_status to list configured servers.";
  }
  return formatMcpAuthError(err, options.hasUI) ?? formatMcpConnectFailureMessage(err);
}

function registerManagementTools(
  pi: ExtensionAPI,
  deps: ManagementToolDeps,
): void {
  const { manager, coordinator, bridge } = deps;

  pi.registerTool({
    name: "mcp_status",
    label: "MCP status",
    description: "List configured MCP servers, lifecycle, connection and OAuth state. Use mcp_connect to connect one server.",
    promptSnippet: "Inspect configured MCP servers, their connection state, discovered tools, and authentication status.",
    parameters: Type.Object({}),
    async execute() {
      const provenance = deps.getProvenance();
      const rows = await Promise.all(
        manager.getAllServers().map((server) => collectStatusRow(server, deps, provenance)),
      );
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
        const message = formatMcpConnectError(err, {
          aborted: Boolean(signal?.aborted),
          serverExists: Boolean(manager.getServer(name)),
          hasUI: ctx.hasUI,
        });
        throw new Error(message);
      }
      const activity = bridge.getToolActivity(name);
      if (activity.active !== activity.discovered) {
        throw new Error("MCP server connected, but some discovered tools are inactive. Check Pi tool restrictions or extension conflicts; mcp_status reports discovered and active counts.");
      }
      return { content: [{ type: "text", text: `MCP server ${name} ready; tools discovered and active.` }], details: {} };
    },
  });

  pi.registerTool({
    name: "mcp_list_resources",
    label: "List MCP resources",
    description: "List MCP resources and URI templates exposed by connected servers. Use mcp_read_resource to read one by URI.",
    promptSnippet: "Discover read-only MCP resources (documents, schemas, data streams) and URI templates, optionally for one server.",
    parameters: Type.Object({
      server: Type.Optional(Type.String({ description: "Exact configured MCP server name (default: all connected servers)" })),
    }),
    annotations: { readOnlyHint: true },
    async execute(_id, { server }, signal) {
      const rows = await listResourceRows(deps, server, signal);
      return { content: [{ type: "text", text: JSON.stringify(rows) }], details: {} };
    },
  });

  pi.registerTool({
    name: "mcp_read_resource",
    label: "Read MCP resource",
    description: "Read one MCP resource by server and URI. Text resources return their text; image blobs return an image; other binary blobs return a size summary.",
    promptSnippet: "Read an MCP resource document or data stream by its URI from a connected server.",
    parameters: Type.Object({
      server: Type.String({ description: "Exact configured MCP server name" }),
      uri: Type.String({ description: "Resource URI, or a URI template filled in by the caller" }),
    }),
    annotations: { readOnlyHint: true },
    async execute(_id, { server, uri }, signal) {
      const content = await readResourceForTool(deps, server, uri, signal);
      return { content, details: {} };
    },
  });
}

/** One `mcp_list_resources` row: a connected server's resources and templates. */
interface ResourceToolRow {
  server: string;
  resources: McpResourceDefinition[];
  templates: McpResourceTemplateDefinition[];
  resourcesUnsupported?: boolean;
}

/**
 * Collect one server's catalog.
 * WHY: a server that never advertised the `resources` capability must not be asked — the raw
 * request would come back as a protocol error rather than an empty catalog.
 */
async function collectResourcesForServer(
  server: ManagedServer,
  deps: ManagementToolDeps,
  signal: AbortSignal | undefined,
): Promise<ResourceToolRow> {
  const client = server.client;
  if (!client || !client.getServerCapabilities()?.resources) {
    return { server: server.name, resources: [], templates: [], resourcesUnsupported: true };
  }
  const catalog = await deps.resources.getCatalog(server.name, client, {
    requestTimeoutMs: deps.manager.resolveRequestTimeoutMs(server),
    ...(signal ? { signal } : {}),
  });
  return { server: server.name, ...catalog };
}

/** Gather `mcp_list_resources` rows for every connected server, or one explicitly named server. */
async function listResourceRows(
  deps: ManagementToolDeps,
  filter: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ servers: ResourceToolRow[]; stoppedServers: string[] }> {
  const all = deps.manager.getAllServers();
  if (filter) {
    const target = all.find((server) => server.name === filter);
    if (!target) throw new Error("Unknown MCP server name. Use mcp_status to list configured servers.");
    if (target.state !== "ready") {
      throw new Error(`MCP server ${filter} is not connected. Use mcp_connect to connect it.`);
    }
    return { servers: [await collectResourcesForServer(target, deps, signal)], stoppedServers: [] };
  }
  const connected = all.filter((server) => server.state === "ready");
  const servers = await Promise.all(connected.map((server) => collectResourcesForServer(server, deps, signal)));
  const stoppedServers = all.filter((server) => server.state !== "ready").map((server) => server.name);
  return { servers, stoppedServers };
}

/** Resolve the server for `mcp_read_resource` and read one URI from its live client. */
async function readResourceForTool(
  deps: ManagementToolDeps,
  serverName: string,
  uri: string,
  signal: AbortSignal | undefined,
): Promise<PiResourceContent[]> {
  const target = deps.manager.getServer(serverName);
  if (!target) throw new Error("Unknown MCP server name. Use mcp_status to list configured servers.");
  const client = target.client;
  if (!client || target.state !== "ready") {
    throw new Error(`MCP server ${serverName} is not connected. Use mcp_connect to connect it.`);
  }
  return deps.resources.readResource(serverName, client, uri, {
    requestTimeoutMs: deps.manager.resolveRequestTimeoutMs(target),
    ...(signal ? { signal } : {}),
  });
}
