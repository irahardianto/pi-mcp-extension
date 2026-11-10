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
  getServerInstructions,
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

  // WHY: deciding this once keeps the "can we read the live registry?" answer stable; a
  // reconcile turn that falls back to a stale event payload would apply superseded state.
  const hasRegisteredServersSource =
    typeof (pi as { getMcpServers?: () => RegisteredMcpServer[] }).getMcpServers === "function";
  let latestEventEntries: RegisteredMcpServer[] = [];
  const getRegisteredEntries = (): RegisteredMcpServer[] =>
    hasRegisteredServersSource
      ? (pi as { getMcpServers: () => RegisteredMcpServer[] }).getMcpServers()
      : latestEventEntries;

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
  // WHY: Pi's MCP registry emits `mcp_servers_change` synchronously for every register() and
  // unregister() (`void this.emit(...)` in the runner, which does not wait for earlier
  // listeners), so a burst of registrations runs concurrent reconciles. Each reconcile awaits
  // process teardown, so the second one sees a half-shut-down server, finishes first, and the
  // first one's resume then resurrects an unregistered server — or deletes a server the second
  // one just registered, orphaning its stdio child. One serialized queue whose turns re-read the
  // live registry collapses a burst into the state that is current when the turn runs.
  let sessionActive = false;
  let sessionEpoch = 0;
  // Counts every `mcp_servers_change` notification and the latest count already reconciled,
  // so a burst of events collapses into one turn and session_start can tell whether a
  // registration landed after it snapshotted the registry.
  let changeEventCount = 0;
  let appliedChangeCount = 0;
  let reconcileQueue: Promise<void> = Promise.resolve();
  let activeSessionStart: Promise<void> = Promise.resolve();
  // Eager servers currently inside a startEagerServers call, so a superseding
  // mcp_servers_change can abort and remove extension servers immediately, and a session
  // transition can stop still-connecting servers without dropping them from config.
  const inFlightEager = new Map<string, ServerConfig>();
  const inFlightEagerBatch: Array<[string, ServerConfig]> = [];
  const pendingEagerOps: Array<Promise<void>> = [];

  const applyServers = (next: Record<string, ServerConfig>, snapshotCount: number): void => {
    extensionServers = next;
    config = mergeWithRegisteredServers(fileConfig, next);
    appliedChangeCount = snapshotCount;
  };

  const removeAppliedServer = (name: string): void => {
    const { [name]: _removed, ...remaining } = extensionServers;
    extensionServers = remaining;
    config = mergeWithRegisteredServers(fileConfig, remaining);
  };

  const abortEagerStart = (name: string): void => {
    inFlightEager.delete(name);
    removeFromEagerBatch(inFlightEagerBatch, name);
    coordinator.cancelServer(name);
    bridge.removeServer(name);
    resources.forget(name);
    removeAppliedServer(name);
    pendingEagerOps.push(manager.removeServer(name));
    coordinator.syncStatus();
  };

  const stopInFlightEagerStarts = (): void => {
    inFlightEager.clear();
    for (const [name] of inFlightEagerBatch.splice(0)) {
      coordinator.cancelServer(name);
      if (manager.getServer(name)?.state === "starting") {
        pendingEagerOps.push(manager.stopServer(name));
      }
    }
  };

  const runEagerStarts = async (
    eagerServers: Array<[string, ServerConfig]>,
    ctx: ExtensionContext,
  ): Promise<void> => {
    inFlightEagerBatch.splice(0, inFlightEagerBatch.length, ...eagerServers);
    for (const [name, cfg] of eagerServers) {
      if (Object.prototype.hasOwnProperty.call(extensionServers, name)) {
        inFlightEager.set(name, cfg);
      }
    }
    try {
      if (changeEventCount !== appliedChangeCount) {
        abortSupersededEagerStarts(
          inFlightEager,
          getRegisteredEntries(),
          fileConfig.mcpServers,
          abortEagerStart,
        );
      }
      if (inFlightEagerBatch.length > 0) {
        await coordinator.startEagerServers(inFlightEagerBatch, ctx);
      }
    } finally {
      inFlightEager.clear();
      inFlightEagerBatch.length = 0;
      if (pendingEagerOps.length > 0) {
        await Promise.allSettled(pendingEagerOps.splice(0));
      }
    }
  };

  const enqueueServerReconcile = (ctx: ExtensionContext): Promise<void> => {
    const epoch = sessionEpoch;
    // WHY: Pi's registry announces every register()/unregister(), including during extension
    // loading (before session_start has checked trust and read <cwd>/.pi/mcp.json) and after
    // session_shutdown. Spawning servers then attaches child processes to no session; the
    // built-in MCP extension ignores those events the same way (its session signal starts
    // aborted). session_start reads the registry itself, so the turn just no-ops instead.
    const isCurrent = () => sessionActive && epoch === sessionEpoch;
    const turn = reconcileQueue.then(() =>
      reconcileRegisteredServers(
        {
          manager,
          coordinator,
          bridge,
          resources,
          fileConfig,
          appliedServers: extensionServers,
          registeredEntries: getRegisteredEntries(),
          appliedChangeCount,
          getChangeCount: () => changeEventCount,
          isCurrent,
          removeAppliedServer,
          applyServers,
          runEagerStarts,
        },
        ctx,
      ),
    );
    // WHY: the emitter is fire-and-forget, so a rejected turn would become an unhandled
    // rejection; report it instead and keep the queue usable for later registrations.
    reconcileQueue = turn.catch((err: unknown) => {
      const { kind, message } = describeError(err);
      reportDiagnostic({
        level: "error",
        event: "servers.change_error",
        message: `Failed to apply MCP server registration change: ${message}`,
        fields: { kind },
      });
      if (isCurrent()) {
        ctx.ui.notify(`pi-mcp: Failed to apply server registration change — ${message}`, "error");
      }
    });
    return reconcileQueue;
  };

  const sessionStartDeps: SessionStartDeps = {
    globalConfigPath: paths.globalConfigPath,
    manager,
    coordinator,
    bridge,
    getCurrentConfig: () => config,
    getRegisteredEntries,
    setSessionConfigState: (nextFileConfig, nextProvenance, nextExtensionServers, nextConfig) => {
      fileConfig = nextFileConfig;
      fileProvenance = nextProvenance;
      appliedChangeCount = changeEventCount;
      extensionServers = nextExtensionServers;
      config = nextConfig;
    },
    runEagerStarts,
  };

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    // WHY: a queued reconcile or earlier startup belongs to the session that started it;
    // marking the session inactive, bumping the epoch, stopping any in-flight eager starts,
    // and draining both the previous startup and reconcileQueue ensures earlier work has
    // settled before runSessionStart diffs sessionConfig against config.
    sessionActive = false;
    const epoch = ++sessionEpoch;
    const isCurrent = () => epoch === sessionEpoch;
    stopInFlightEagerStarts();
    const previousStart = activeSessionStart;
    const turn = (async () => {
      await previousStart;
      await reconcileQueue;
      try {
        if (isCurrent()) {
          await runSessionStart(sessionStartDeps, ctx, isCurrent);
        }
      } finally {
        // WHY: only activate the session if neither session_shutdown nor a newer session_start
        // superseded this startup while runSessionStart was awaiting config I/O or eager connects.
        if (isCurrent()) {
          sessionActive = true;
          // WHY: reconcile only when a registration landed after runSessionStart snapshotted
          // the registry. An unconditional turn would re-collect the registry on every session
          // start and repeat the per-entry config-error notification runSessionStart already
          // surfaced. Looping drains any registration that arrives mid-reconcile too.
          while (isCurrent() && changeEventCount !== appliedChangeCount) {
            await enqueueServerReconcile(ctx);
          }
        }
      }
    })();
    activeSessionStart = turn.catch(() => {
      // WHY: keep activeSessionStart resolved so a later session_start or session_shutdown never rejects.
    });
    await turn;
  });

  // Connect or disconnect MCP servers registered dynamically via pi.registerMcpServer().
  pi.on("mcp_servers_change", (event, ctx: ExtensionContext) => {
    if (Array.isArray((event as { servers?: unknown })?.servers)) {
      latestEventEntries = (event as { servers: RegisteredMcpServer[] }).servers;
    }
    changeEventCount += 1;
    abortSupersededEagerStarts(
      inFlightEager,
      getRegisteredEntries(),
      fileConfig.mcpServers,
      abortEagerStart,
    );
    return enqueueServerReconcile(ctx);
  });

  // Order the bridge's tools in every outgoing request so the declared order never depends on
  // connect timing or the transcript's first-appearance order (#278).
  pi.on("before_provider_request", (event) => bridge.orderPayloadTools(event.payload));

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    // WHY: invalidate before tearing down so an in-flight startup or queued reconcile
    // observes a dead session and bails, then drain both after teardown so shutdown never
    // returns while a turn is still mutating state or spawning children. Teardown runs first
    // because it aborts any eager start the in-flight turn is waiting on while keeping
    // configured servers in ServerManager in "stopped" state (removeServers: false).
    sessionActive = false;
    sessionEpoch += 1;
    inFlightEager.clear();
    inFlightEagerBatch.length = 0;
    reportDiagnostic({
      level: "info",
      event: "session.teardown",
      message: "pi-mcp session shutting down",
      fields: { outcome: "shutdown" },
    });
    await coordinator.teardown(ctx, { removeServers: false });
    await activeSessionStart;
    await reconcileQueue;
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

function isClientActive(
  manager: ServerManager,
  serverName: string,
  client: ManagedServer["client"],
): boolean {
  const current = manager.getServer(serverName);
  return current?.client === client && current.state !== "stopped";
}

function isProjectTrusted(ctx: ExtensionContext): boolean {
  return typeof (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted === "function"
    ? (ctx as { isProjectTrusted: () => boolean }).isProjectTrusted()
    : true;
}

function filterEagerServers(
  servers: Record<string, ServerConfig>,
): Array<[string, ServerConfig]> {
  return Object.entries(servers).filter(([, cfg]) => cfg.lifecycle === "eager");
}

function removeFromEagerBatch(
  batch: Array<[string, ServerConfig]>,
  name: string,
): void {
  const index = batch.findIndex(([entryName]) => entryName === name);
  if (index !== -1) {
    batch.splice(index, 1);
  }
}

interface SessionStartDeps {
  globalConfigPath: string | undefined;
  manager: ServerManager;
  coordinator: ConnectionCoordinator;
  bridge: ToolBridge;
  getCurrentConfig: () => McpConfig;
  getRegisteredEntries: () => readonly RegisteredMcpServer[];
  setSessionConfigState: (
    nextFileConfig: McpConfig,
    nextProvenance: ConfigProvenanceInput,
    nextExtensionServers: Record<string, ServerConfig>,
    nextConfig: McpConfig,
  ) => void;
  runEagerStarts: (
    eagerServers: Array<[string, ServerConfig]>,
    ctx: ExtensionContext,
  ) => Promise<void>;
}

function applyFailedConfigFallback(
  deps: SessionStartDeps,
  ctx: ExtensionContext,
  includeProjectConfig: boolean,
): Array<[string, ServerConfig]> {
  // WHY: A config that failed to parse still supplies no server origins, so the
  // provenance must not keep pointing at the previous session's file entries.
  const fallbackProvenance: ConfigProvenanceInput = {
    origins: {},
    projectConfigPath: join(ctx.cwd, ".pi", "mcp.json"),
    projectConfigIncluded: includeProjectConfig,
  };
  const fallbackFileConfig: McpConfig = {
    settings: { ...DEFAULT_SETTINGS },
    mcpServers: {},
  };
  const nextExtensionServers = collectRegisteredServers(
    deps.getRegisteredEntries(),
    fallbackFileConfig.mcpServers,
    (regErr) => {
      const regMsg = formatErrorMessage(regErr);
      ctx.ui.notify(`pi-mcp: Config error — ${regMsg}`, "error");
    },
  );
  const nextConfig = mergeWithRegisteredServers(fallbackFileConfig, nextExtensionServers);
  deps.setSessionConfigState(
    fallbackFileConfig,
    fallbackProvenance,
    nextExtensionServers,
    nextConfig,
  );
  deps.bridge.updateSettings(nextConfig.settings);
  deps.manager.rebuildServers(nextConfig);
  return Object.keys(nextExtensionServers).length > 0
    ? filterEagerServers(nextConfig.mcpServers)
    : [];
}

function hasSessionConfigChanged(
  deps: SessionStartDeps,
  nextLoaded: LoadedConfig,
): boolean {
  const previewExtensionServers = collectRegisteredServers(
    deps.getRegisteredEntries(),
    nextLoaded.config.mcpServers,
  );
  const previewConfig = mergeWithRegisteredServers(
    nextLoaded.config,
    previewExtensionServers,
  );
  return JSON.stringify(previewConfig) !== JSON.stringify(deps.getCurrentConfig());
}

function commitLoadedConfig(
  deps: SessionStartDeps,
  ctx: ExtensionContext,
  nextLoaded: LoadedConfig,
  rebuild: boolean,
): Array<[string, ServerConfig]> {
  const nextExtensionServers = collectRegisteredServers(
    deps.getRegisteredEntries(),
    nextLoaded.config.mcpServers,
    (err) => {
      const msg = formatErrorMessage(err);
      ctx.ui.notify(`pi-mcp: Config error — ${msg}`, "error");
    },
  );
  const sessionConfig = mergeWithRegisteredServers(nextLoaded.config, nextExtensionServers);
  deps.setSessionConfigState(
    nextLoaded.config,
    nextLoaded,
    nextExtensionServers,
    rebuild ? sessionConfig : deps.getCurrentConfig(),
  );
  if (rebuild) {
    deps.bridge.updateSettings(sessionConfig.settings);
    deps.manager.rebuildServers(sessionConfig);
  } else {
    // WHY: Even when config is identical across session switches, update running servers'
    // cwd and emit notifications/roots/list_changed if the workspace directory changed.
    deps.manager.updateCwd(ctx.cwd);
    deps.coordinator.syncStatus(ctx);
  }
  return filterEagerServers(sessionConfig.mcpServers);
}

async function handleSessionConfigLoadError(
  deps: SessionStartDeps,
  ctx: ExtensionContext,
  includeProjectConfig: boolean,
  isCurrent: () => boolean,
  err: unknown,
): Promise<void> {
  if (!isCurrent()) return;
  const msg = formatErrorMessage(err);
  ctx.ui.notify(`pi-mcp: Config error — ${msg}`, "error");
  // WHY: Switching sessions into a directory with an invalid config must tear down stale
  // servers, tools, prompts, and status from the previous session rather than leaving them active.
  await deps.coordinator.teardown(ctx);
  if (!isCurrent()) return;
  const eagerServers = applyFailedConfigFallback(deps, ctx, includeProjectConfig);
  if (!isCurrent() || eagerServers.length === 0) return;
  await deps.runEagerStarts(eagerServers, ctx);
}

async function applyLoadedSessionConfig(
  deps: SessionStartDeps,
  ctx: ExtensionContext,
  nextLoaded: LoadedConfig,
  isCurrent: () => boolean,
): Promise<void> {
  const configChanged = hasSessionConfigChanged(deps, nextLoaded);
  if (configChanged) {
    reportDiagnostic({
      level: "info",
      event: "session.reload",
      message: "MCP configuration changed; reloading servers and tools",
      fields: { outcome: "config_changed" },
    });
    await deps.coordinator.teardown(ctx);
    if (!isCurrent()) return;
  }
  const eagerServers = commitLoadedConfig(deps, ctx, nextLoaded, configChanged);
  if (!isCurrent() || eagerServers.length === 0) return;
  await deps.runEagerStarts(eagerServers, ctx);
}

async function runSessionStart(
  deps: SessionStartDeps,
  ctx: ExtensionContext,
  isCurrent: () => boolean,
): Promise<void> {
  deps.coordinator.setActiveContext(ctx);
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
  const includeProjectConfig = isProjectTrusted(ctx);

  let nextLoaded: LoadedConfig;
  try {
    nextLoaded = await loadConfigWithOrigins(ctx.cwd, deps.globalConfigPath, {
      includeProjectConfig,
    });
  } catch (err) {
    await handleSessionConfigLoadError(deps, ctx, includeProjectConfig, isCurrent, err);
    return;
  }
  if (!isCurrent()) return;
  await applyLoadedSessionConfig(deps, ctx, nextLoaded, isCurrent);
}

interface RegistrationReconcileDeps {
  manager: ServerManager;
  coordinator: ConnectionCoordinator;
  bridge: ToolBridge;
  resources: ResourceBridge;
  /** File-backed config; extension registrations are merged on top of it. */
  fileConfig: McpConfig;
  /** Registrations currently in effect, diffed against the new snapshot. */
  appliedServers: Record<string, ServerConfig>;
  /** The registry as it is when the turn runs; an event's own snapshot is already stale. */
  registeredEntries: readonly RegisteredMcpServer[];
  /** Change counter already applied when this turn begins. */
  appliedChangeCount: number;
  /** Live change counter, re-read after each async teardown step to detect supersession. */
  getChangeCount: () => number;
  /** False once the session that queued this turn has switched or shut down. */
  isCurrent: () => boolean;
  /** Drops a single removed server from the applied state before awaiting its teardown. */
  removeAppliedServer: (name: string) => void;
  /** Publishes the applied registrations and merged config before eager servers start. */
  applyServers: (next: Record<string, ServerConfig>, snapshotCount: number) => void;
  /** Starts newly staged eager servers while tracking them so superseding events can abort them. */
  runEagerStarts: (addedEager: Array<[string, ServerConfig]>, ctx: ExtensionContext) => Promise<void>;
}

function abortSupersededEagerStarts(
  inFlightEager: ReadonlyMap<string, ServerConfig>,
  registeredEntries: readonly RegisteredMcpServer[],
  fileServers: Record<string, ServerConfig>,
  abortEagerStart: (name: string) => void,
): void {
  if (inFlightEager.size === 0) return;
  const nextPreview = collectRegisteredServers(registeredEntries, fileServers);
  for (const name of findRemovedOrChangedServers(
    Object.fromEntries(inFlightEager),
    nextPreview,
  )) {
    abortEagerStart(name);
  }
}

function findRemovedOrChangedServers(
  appliedServers: Record<string, ServerConfig>,
  nextServers: Record<string, ServerConfig>,
): string[] {
  const removedOrChanged: string[] = [];
  for (const [name, prevCfg] of Object.entries(appliedServers)) {
    const nextCfg = nextServers[name];
    if (!nextCfg || JSON.stringify(prevCfg) !== JSON.stringify(nextCfg)) {
      removedOrChanged.push(name);
    }
  }
  return removedOrChanged;
}

function stageAddedServers(
  manager: ServerManager,
  nextServers: Record<string, ServerConfig>,
): Array<[string, ServerConfig]> {
  const addedEager: Array<[string, ServerConfig]> = [];
  for (const [name, nextCfg] of Object.entries(nextServers)) {
    if (manager.getServer(name)) continue;
    manager.setServer(name, nextCfg);
    if (nextCfg.lifecycle === "eager") {
      addedEager.push([name, nextCfg]);
    }
  }
  return addedEager;
}

/**
 * Bring the manager, bridge, and config in line with the current registrations.
 *
 * `isCurrent` and `getChangeCount` are checked at entry and after each removal await, so a
 * session switch/shutdown or a newer registration that arrived while a teardown was in flight
 * stops the turn before it re-adds or starts superseded servers. An eager start already running
 * when a newer registration or session transition arrives is aborted via `runEagerStarts`.
 */
async function reconcileRegisteredServers(
  deps: RegistrationReconcileDeps,
  ctx: ExtensionContext,
): Promise<void> {
  const snapshotCount = deps.getChangeCount();
  if (!deps.isCurrent() || deps.appliedChangeCount === snapshotCount) return;

  deps.coordinator.setActiveContext(ctx);
  setDiagnosticUi(ctx.ui, ctx.hasUI);

  const configErrors: string[] = [];
  const nextExtensionServers = collectRegisteredServers(
    deps.registeredEntries,
    deps.fileConfig.mcpServers,
    (err) => {
      configErrors.push(formatErrorMessage(err));
    },
  );

  const removedOrChanged = findRemovedOrChangedServers(deps.appliedServers, nextExtensionServers);
  for (const name of removedOrChanged) {
    deps.coordinator.cancelServer(name);
    deps.bridge.removeServer(name);
    deps.resources.forget(name);
    deps.removeAppliedServer(name);
    await deps.manager.removeServer(name);
    deps.coordinator.syncStatus(ctx);
    // WHY: the next step re-adds and starts servers, which must never happen when the
    // session went away or a newer registration superseded this snapshot during teardown.
    if (!deps.isCurrent() || deps.getChangeCount() !== snapshotCount) return;
  }

  for (const msg of configErrors) {
    ctx.ui.notify(`pi-mcp: Config error — ${msg}`, "error");
  }

  const addedEager = stageAddedServers(deps.manager, nextExtensionServers);
  deps.applyServers(nextExtensionServers, snapshotCount);
  deps.coordinator.syncStatus(ctx);

  if (addedEager.length > 0) {
    await deps.runEagerStarts(addedEager, ctx);
  }
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
      const instructions = getServerInstructions(manager.getServer(name));
      const ready = `MCP server ${name} ready; tools discovered and active.`;
      const text = instructions === undefined ? ready : `${ready}\nInstructions: ${instructions}`;
      return { content: [{ type: "text", text }], details: {} };
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
  error?: string;
}

/**
 * Collect one server's catalog.
 * WHY: a server that never advertised the `resources` capability must not be asked — the raw
 * request would come back as a protocol error rather than an empty catalog. A server that does
 * advertise it but fails keeps its row instead of rejecting every other server's listing.
 */
async function collectResourcesForServer(
  server: ManagedServer,
  deps: ManagementToolDeps,
  signal: AbortSignal | undefined,
): Promise<ResourceToolRow> {
  if (signal?.aborted) throw new AuthCancelledError(server.name);
  const client = server.client;
  if (!client || !client.getServerCapabilities()?.resources) {
    return { server: server.name, resources: [], templates: [], resourcesUnsupported: true };
  }
  try {
    const catalog = await deps.resources.getCatalog(server.name, client, {
      requestTimeoutMs: deps.manager.resolveRequestTimeoutMs(server),
      ...(signal ? { signal } : {}),
    });
    return { server: server.name, ...catalog };
  } catch (err) {
    if (err instanceof AuthCancelledError || signal?.aborted) {
      throw err instanceof AuthCancelledError ? err : new AuthCancelledError(server.name);
    }
    return { server: server.name, resources: [], templates: [], error: formatErrorMessage(err) };
  }
}

/** Gather `mcp_list_resources` rows for every connected server, or one explicitly named server. */
async function listResourceRows(
  deps: ManagementToolDeps,
  filter: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ servers: ResourceToolRow[]; stoppedServers: string[] }> {
  if (signal?.aborted) throw new AuthCancelledError(filter ?? "mcp_list_resources");
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
  if (signal?.aborted) throw new AuthCancelledError(serverName);
  const target = deps.manager.getServer(serverName);
  if (!target) throw new Error("Unknown MCP server name. Use mcp_status to list configured servers.");
  const client = target.client;
  if (!client || target.state !== "ready") {
    throw new Error(`MCP server ${serverName} is not connected. Use mcp_connect to connect it.`);
  }
  // WHY: without this a capability-less server answers resources/read with JSON-RPC -32601,
  // which surfaces as a cryptic protocol error instead of the same actionable wording the
  // listing and /mcp:resources use.
  if (!client.getServerCapabilities()?.resources) {
    throw new McpError(`MCP server ${serverName} does not expose MCP resources`, serverName, "protocol");
  }
  return deps.resources.readResource(serverName, client, uri, {
    requestTimeoutMs: deps.manager.resolveRequestTimeoutMs(target),
    ...(signal ? { signal } : {}),
  });
}
