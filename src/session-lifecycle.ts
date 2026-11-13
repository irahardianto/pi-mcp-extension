/**
 * Session config-reload and dynamic `mcp_servers_change` lifecycle state machine.
 *
 * Owns untrusted-safe bootstrap config loading, trust-gated `session_start`
 * reloads, serialized `mcp_servers_change` reconciliation, eager-start
 * supersession, and session teardown coordination.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  RegisteredMcpServer,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  loadConfigWithOrigins,
  parseRegisteredServerConfig,
  type LoadedConfig,
  type McpConfig,
  type ServerConfig,
} from "./config.js";
import {
  withExtensionServers,
  type ConfigProvenance,
  type ConfigProvenanceInput,
} from "./server-provenance.js";
import type { ServerManager } from "./server-manager.js";
import type { ToolBridge } from "./tool-bridge.js";
import type { ResourceBridge } from "./resource-bridge.js";
import type { ConnectionCoordinator } from "./connection-coordinator.js";
import { formatErrorMessage } from "./startup-auth.js";
import { describeError } from "./debug-log-format.js";
import {
  getDebugLog,
  reportDiagnostic,
  setDiagnosticUi,
} from "./debug-log.js";
import { collectConfiguredExposures } from "./tool-exposure.js";

export const DEFAULT_SETTINGS = {
  toolPrefix: "mcp",
  requestTimeoutMs: 30000,
  maxRetries: 5,
} as const;

export type SessionProvenance = ConfigProvenance;

export interface BootstrapConfigPaths {
  bootstrapCwd?: string | undefined;
  globalConfigPath?: string | undefined;
}

export interface BootstrapConfigState {
  fileConfig: McpConfig;
  fileProvenance: ConfigProvenanceInput;
  extensionServers: Record<string, ServerConfig>;
  config: McpConfig;
}

export interface SessionLifecycleDeps {
  pi: ExtensionAPI;
  globalConfigPath?: string | undefined;
  initialState: BootstrapConfigState;
  manager: ServerManager;
  coordinator: ConnectionCoordinator;
  bridge: ToolBridge;
  resources: ResourceBridge;
}

function hasRegisteredServersApi(
  pi: ExtensionAPI,
): pi is ExtensionAPI & { getMcpServers: () => RegisteredMcpServer[] } {
  return typeof (pi as { getMcpServers?: () => RegisteredMcpServer[] }).getMcpServers === "function";
}

function reportBootstrapConfigError(err: unknown): void {
  const { kind, message } = describeError(err);
  reportDiagnostic({
    level: "error",
    event: "config.error",
    message: `Config error: ${message}`,
    fields: { kind },
  });
}

function notifySessionConfigError(ctx: ExtensionContext, err: unknown): void {
  const msg = formatErrorMessage(err);
  ctx.ui.notify(`pi-mcp: Config error — ${msg}`, "error");
}

export function collectRegisteredServers(
  entries: readonly RegisteredMcpServer[],
  fileServers: Record<string, ServerConfig>,
  onError?: (err: unknown) => void,
): Record<string, ServerConfig> {
  const registered: Record<string, ServerConfig> = {};
  for (const entry of entries) {
    // Servers configured in mcp.json take precedence over extension-registered servers.
    if (Object.prototype.hasOwnProperty.call(fileServers, entry.name)) {
      continue;
    }
    try {
      registered[entry.name] = parseRegisteredServerConfig(
        entry.name,
        entry.config,
        entry.extensionPath || "<extension>",
      );
    } catch (err) {
      onError?.(err);
    }
  }
  return registered;
}

export function mergeWithRegisteredServers(
  fileConfig: McpConfig,
  registeredServers: Record<string, ServerConfig>,
): McpConfig {
  return {
    settings: fileConfig.settings,
    mcpServers: {
      ...registeredServers,
      ...fileConfig.mcpServers,
    },
    ...(fileConfig.autoEnableCodemode === undefined
      ? {}
      : { autoEnableCodemode: fileConfig.autoEnableCodemode }),
  };
}

/**
 * Load only global config and extension-registered servers at bootstrap.
 *
 * WHY: cwd and project trust are available on the ExtensionContext passed to event handlers.
 * At bootstrap (before session_start) we load ONLY the global config so untrusted
 * `<cwd>/.pi/mcp.json` files are never read before `ctx.isProjectTrusted()` is checked.
 */
export async function loadBootstrapConfigState(
  pi: ExtensionAPI,
  paths: BootstrapConfigPaths = {},
): Promise<BootstrapConfigState> {
  const bootstrapCwd = paths.bootstrapCwd ?? process.cwd();
  let fileConfig: McpConfig = {
    settings: { ...DEFAULT_SETTINGS },
    mcpServers: {},
  };
  // Where each configured server came from. The bootstrap load skips the project
  // config (trust is unknown before session_start), so this is replaced on the
  // first session_start with the provenance of the config actually in effect.
  let fileProvenance: ConfigProvenanceInput = {
    origins: {},
    projectConfigPath: join(bootstrapCwd, ".pi", "mcp.json"),
    projectConfigIncluded: false,
  };
  try {
    const loaded = await loadConfigWithOrigins(bootstrapCwd, paths.globalConfigPath, {
      includeProjectConfig: false,
    });
    fileConfig = loaded.config;
    fileProvenance = loaded;
  } catch (err) {
    // Can't notify yet (no ctx), so the diagnostic goes to stderr (and to the
    // debug log when it is enabled). The session_start handler will re-try with
    // the real cwd and surface errors properly.
    reportBootstrapConfigError(err);
  }

  const initialEntries = hasRegisteredServersApi(pi) ? pi.getMcpServers() : [];
  const extensionServers = collectRegisteredServers(
    initialEntries,
    fileConfig.mcpServers,
    reportBootstrapConfigError,
  );
  const config = mergeWithRegisteredServers(fileConfig, extensionServers);
  return {
    fileConfig,
    fileProvenance,
    extensionServers,
    config,
  };
}

export function isProjectTrusted(ctx: ExtensionContext): boolean {
  return typeof (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted === "function"
    ? (ctx as { isProjectTrusted: () => boolean }).isProjectTrusted()
    : true;
}

export function filterEagerServers(
  servers: Record<string, ServerConfig>,
): Array<[string, ServerConfig]> {
  return Object.entries(servers).filter(([, cfg]) => cfg.lifecycle === "eager");
}

export function removeFromEagerBatch(
  batch: Array<[string, ServerConfig]>,
  name: string,
): void {
  const index = batch.findIndex(([entryName]) => entryName === name);
  if (index !== -1) {
    batch.splice(index, 1);
  }
}

export function abortSupersededEagerStarts(
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

export function findRemovedOrChangedServers(
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

export function stageAddedServers(
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
 * Coordinates `session_start`, `mcp_servers_change`, and `session_shutdown`.
 *
 * WHY: Pi's MCP registry emits `mcp_servers_change` synchronously for every register() and
 * unregister() (`void this.emit(...)` in the runner, which does not wait for earlier
 * listeners), so a burst of registrations runs concurrent reconciles. Each reconcile awaits
 * process teardown, so the second one sees a half-shut-down server, finishes first, and the
 * first one's resume then resurrects an unregistered server — or deletes a server the second
 * one just registered, orphaning its stdio child. One serialized queue whose turns re-read the
 * live registry collapses a burst into the state that is current when the turn runs.
 */
export class SessionLifecycle {
  private readonly deps: SessionLifecycleDeps;
  private readonly hasRegisteredServersSource: boolean;
  private fileConfig: McpConfig;
  private fileProvenance: ConfigProvenanceInput;
  private extensionServers: Record<string, ServerConfig>;
  private config: McpConfig;
  private latestEventEntries: RegisteredMcpServer[] = [];
  private sessionActive = false;
  private sessionEpoch = 0;
  // Counts every `mcp_servers_change` notification and the latest count already reconciled,
  // so a burst of events collapses into one turn and session_start can tell whether a
  // registration landed after it snapshotted the registry.
  private changeEventCount = 0;
  private appliedChangeCount = 0;
  private reconcileQueue: Promise<void> = Promise.resolve();
  private activeSessionStart: Promise<void> = Promise.resolve();
  // Eager servers currently inside a startEagerServers call, so a superseding
  // mcp_servers_change can abort and remove extension servers immediately, and a session
  // transition can stop still-connecting servers without dropping them from config.
  private readonly inFlightEager = new Map<string, ServerConfig>();
  private readonly inFlightEagerBatch: Array<[string, ServerConfig]> = [];
  private readonly pendingEagerOps: Array<Promise<void>> = [];

  constructor(deps: SessionLifecycleDeps) {
    this.deps = deps;
    // WHY: deciding this once keeps the "can we read the live registry?" answer stable; a
    // reconcile turn that falls back to a stale event payload would apply superseded state.
    this.hasRegisteredServersSource = hasRegisteredServersApi(deps.pi);
    this.fileConfig = deps.initialState.fileConfig;
    this.fileProvenance = deps.initialState.fileProvenance;
    this.extensionServers = deps.initialState.extensionServers;
    this.config = deps.initialState.config;
  }

  getConfig(): McpConfig {
    return this.config;
  }

  getProvenance(): SessionProvenance {
    return withExtensionServers(this.fileProvenance, Object.keys(this.extensionServers));
  }

  async handleSessionStart(ctx: ExtensionContext): Promise<void> {
    // WHY: a queued reconcile or earlier startup belongs to the session that started it;
    // marking the session inactive, bumping the epoch, stopping any in-flight eager starts,
    // and draining both the previous startup and reconcileQueue ensures earlier work has
    // settled before runSessionStart diffs sessionConfig against config.
    this.sessionActive = false;
    const epoch = ++this.sessionEpoch;
    this.stopInFlightEagerStarts();
    const previousStart = this.activeSessionStart;
    const turn = this.executeSessionStartTurn(ctx, previousStart, epoch);
    this.activeSessionStart = turn.catch(() => {
      // WHY: keep activeSessionStart resolved so a later session_start or session_shutdown never rejects.
    });
    await turn;
  }

  handleServersChange(event: unknown, ctx: ExtensionContext): Promise<void> {
    if (Array.isArray((event as { servers?: unknown })?.servers)) {
      this.latestEventEntries = (event as { servers: RegisteredMcpServer[] }).servers;
    }
    this.changeEventCount += 1;
    abortSupersededEagerStarts(
      this.inFlightEager,
      this.getRegisteredEntries(),
      this.fileConfig.mcpServers,
      (name) => this.abortEagerStart(name),
    );
    return this.enqueueServerReconcile(ctx);
  }

  async handleSessionShutdown(ctx: ExtensionContext): Promise<void> {
    // WHY: invalidate before tearing down so an in-flight startup or queued reconcile
    // observes a dead session and bails, then drain both after teardown so shutdown never
    // returns while a turn is still mutating state or spawning children. Teardown runs first
    // because it aborts any eager start the in-flight turn is waiting on while keeping
    // configured servers in ServerManager in "stopped" state (removeServers: false).
    this.sessionActive = false;
    this.sessionEpoch += 1;
    this.inFlightEager.clear();
    this.inFlightEagerBatch.length = 0;
    reportDiagnostic({
      level: "info",
      event: "session.teardown",
      message: "pi-mcp session shutting down",
      fields: { outcome: "shutdown" },
    });
    await this.deps.coordinator.teardown(ctx, { removeServers: false });
    await this.activeSessionStart;
    await this.reconcileQueue;
    this.deps.coordinator.setActiveContext(undefined);
    setDiagnosticUi(null, false);
    // WHY: Flush the queued debug-log writes before the process may exit, so a
    // bug report attached right after the session ends is not missing events.
    await getDebugLog()?.flush();
  }

  private getRegisteredEntries(): RegisteredMcpServer[] {
    return this.hasRegisteredServersSource
      ? (this.deps.pi as { getMcpServers: () => RegisteredMcpServer[] }).getMcpServers()
      : this.latestEventEntries;
  }

  private isEpochCurrent(epoch: number): boolean {
    return epoch === this.sessionEpoch;
  }

  private isActiveEpoch(epoch: number): boolean {
    return this.sessionActive && epoch === this.sessionEpoch;
  }

  private hasPendingEpochChanges(epoch: number): boolean {
    return epoch === this.sessionEpoch && this.changeEventCount !== this.appliedChangeCount;
  }

  private setSessionConfigState(
    nextFileConfig: McpConfig,
    nextProvenance: ConfigProvenanceInput,
    nextExtensionServers: Record<string, ServerConfig>,
    nextConfig: McpConfig,
  ): void {
    this.fileConfig = nextFileConfig;
    this.fileProvenance = nextProvenance;
    this.appliedChangeCount = this.changeEventCount;
    this.extensionServers = nextExtensionServers;
    this.config = nextConfig;
  }

  private applyServers(next: Record<string, ServerConfig>, snapshotCount: number): void {
    this.extensionServers = next;
    this.config = mergeWithRegisteredServers(this.fileConfig, next);
    this.appliedChangeCount = snapshotCount;
  }

  private removeAppliedServer(name: string): void {
    const { [name]: _removed, ...remaining } = this.extensionServers;
    this.extensionServers = remaining;
    this.config = mergeWithRegisteredServers(this.fileConfig, remaining);
  }

  private abortEagerStart(name: string): void {
    this.inFlightEager.delete(name);
    removeFromEagerBatch(this.inFlightEagerBatch, name);
    this.deps.coordinator.cancelServer(name);
    this.deps.bridge.removeServer(name);
    this.deps.resources.forget(name);
    this.removeAppliedServer(name);
    this.pendingEagerOps.push(this.deps.manager.removeServer(name));
    this.deps.coordinator.syncStatus();
  }

  private stopInFlightEagerStarts(): void {
    this.inFlightEager.clear();
    for (const [name] of this.inFlightEagerBatch.splice(0)) {
      this.deps.coordinator.cancelServer(name);
      if (this.deps.manager.getServer(name)?.state === "starting") {
        this.pendingEagerOps.push(this.deps.manager.stopServer(name));
      }
    }
  }

  private async runEagerStarts(
    eagerServers: Array<[string, ServerConfig]>,
    ctx: ExtensionContext,
  ): Promise<void> {
    this.inFlightEagerBatch.splice(0, this.inFlightEagerBatch.length, ...eagerServers);
    for (const [name, cfg] of eagerServers) {
      if (Object.prototype.hasOwnProperty.call(this.extensionServers, name)) {
        this.inFlightEager.set(name, cfg);
      }
    }
    try {
      if (this.changeEventCount !== this.appliedChangeCount) {
        abortSupersededEagerStarts(
          this.inFlightEager,
          this.getRegisteredEntries(),
          this.fileConfig.mcpServers,
          (name) => this.abortEagerStart(name),
        );
      }
      if (this.inFlightEagerBatch.length > 0) {
        this.deps.bridge.ensureDiscoveryTools(
          collectConfiguredExposures(this.inFlightEagerBatch.map(([, cfg]) => cfg)),
        );
        await this.deps.coordinator.startEagerServers(this.inFlightEagerBatch, ctx);
      }
    } finally {
      this.inFlightEager.clear();
      this.inFlightEagerBatch.length = 0;
      if (this.pendingEagerOps.length > 0) {
        await Promise.allSettled(this.pendingEagerOps.splice(0));
      }
    }
  }

  private async executeSessionStartTurn(
    ctx: ExtensionContext,
    previousStart: Promise<void>,
    epoch: number,
  ): Promise<void> {
    await previousStart;
    await this.reconcileQueue;
    try {
      if (this.isEpochCurrent(epoch)) {
        await this.runSessionStart(ctx, epoch);
      }
    } finally {
      // WHY: only activate the session if neither session_shutdown nor a newer session_start
      // superseded this startup while runSessionStart was awaiting config I/O or eager connects.
      if (this.isEpochCurrent(epoch)) {
        this.sessionActive = true;
        // WHY: reconcile only when a registration landed after runSessionStart snapshotted
        // the registry. An unconditional turn would re-collect the registry on every session
        // start and repeat the per-entry config-error notification runSessionStart already
        // surfaced. Looping drains any registration that arrives mid-reconcile too.
        while (this.hasPendingEpochChanges(epoch)) {
          await this.enqueueServerReconcile(ctx);
        }
      }
    }
  }

  private applyFailedConfigFallback(
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
      this.getRegisteredEntries(),
      fallbackFileConfig.mcpServers,
      (regErr) => notifySessionConfigError(ctx, regErr),
    );
    const nextConfig = mergeWithRegisteredServers(fallbackFileConfig, nextExtensionServers);
    this.setSessionConfigState(
      fallbackFileConfig,
      fallbackProvenance,
      nextExtensionServers,
      nextConfig,
    );
    this.deps.bridge.updateSettings(nextConfig.settings);
    this.deps.bridge.setAutoEnableCodemode(nextConfig.autoEnableCodemode);
    this.deps.manager.rebuildServers(nextConfig);
    return Object.keys(nextExtensionServers).length > 0
      ? filterEagerServers(nextConfig.mcpServers)
      : [];
  }

  private hasSessionConfigChanged(nextLoaded: LoadedConfig): boolean {
    const previewExtensionServers = collectRegisteredServers(
      this.getRegisteredEntries(),
      nextLoaded.config.mcpServers,
    );
    const previewConfig = mergeWithRegisteredServers(
      nextLoaded.config,
      previewExtensionServers,
    );
    return JSON.stringify(previewConfig) !== JSON.stringify(this.config);
  }

  private commitLoadedConfig(
    ctx: ExtensionContext,
    nextLoaded: LoadedConfig,
    rebuild: boolean,
  ): Array<[string, ServerConfig]> {
    const nextExtensionServers = collectRegisteredServers(
      this.getRegisteredEntries(),
      nextLoaded.config.mcpServers,
      (err) => notifySessionConfigError(ctx, err),
    );
    const sessionConfig = mergeWithRegisteredServers(nextLoaded.config, nextExtensionServers);
    this.setSessionConfigState(
      nextLoaded.config,
      nextLoaded,
      nextExtensionServers,
      rebuild ? sessionConfig : this.config,
    );
    this.deps.bridge.setAutoEnableCodemode(sessionConfig.autoEnableCodemode);
    if (rebuild) {
      this.deps.bridge.updateSettings(sessionConfig.settings);
      this.deps.manager.rebuildServers(sessionConfig);
    } else {
      // WHY: Even when config is identical across session switches, update running servers'
      // cwd and emit notifications/roots/list_changed if the workspace directory changed.
      this.deps.manager.updateCwd(ctx.cwd);
      this.deps.coordinator.syncStatus(ctx);
    }
    return filterEagerServers(sessionConfig.mcpServers);
  }

  private async handleSessionConfigLoadError(
    ctx: ExtensionContext,
    includeProjectConfig: boolean,
    epoch: number,
    err: unknown,
  ): Promise<void> {
    if (!this.isEpochCurrent(epoch)) return;
    notifySessionConfigError(ctx, err);
    // WHY: Switching sessions into a directory with an invalid config must tear down stale
    // servers, tools, prompts, and status from the previous session rather than leaving them active.
    await this.deps.coordinator.teardown(ctx);
    if (!this.isEpochCurrent(epoch)) return;
    const eagerServers = this.applyFailedConfigFallback(ctx, includeProjectConfig);
    if (!this.isEpochCurrent(epoch) || eagerServers.length === 0) return;
    await this.runEagerStarts(eagerServers, ctx);
  }

  private async applyLoadedSessionConfig(
    ctx: ExtensionContext,
    nextLoaded: LoadedConfig,
    epoch: number,
  ): Promise<void> {
    const configChanged = this.hasSessionConfigChanged(nextLoaded);
    if (configChanged) {
      reportDiagnostic({
        level: "info",
        event: "session.reload",
        message: "MCP configuration changed; reloading servers and tools",
        fields: { outcome: "config_changed" },
      });
      await this.deps.coordinator.teardown(ctx);
      if (!this.isEpochCurrent(epoch)) return;
    }
    const eagerServers = this.commitLoadedConfig(ctx, nextLoaded, configChanged);
    if (!this.isEpochCurrent(epoch) || eagerServers.length === 0) return;
    await this.runEagerStarts(eagerServers, ctx);
  }

  private async runSessionStart(
    ctx: ExtensionContext,
    epoch: number,
  ): Promise<void> {
    this.deps.coordinator.setActiveContext(ctx);
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
      nextLoaded = await loadConfigWithOrigins(ctx.cwd, this.deps.globalConfigPath, {
        includeProjectConfig,
      });
    } catch (err) {
      await this.handleSessionConfigLoadError(ctx, includeProjectConfig, epoch, err);
      return;
    }
    if (!this.isEpochCurrent(epoch)) return;
    await this.applyLoadedSessionConfig(ctx, nextLoaded, epoch);
  }

  private handleReconcileError(err: unknown, epoch: number, ctx: ExtensionContext): void {
    const { kind, message } = describeError(err);
    reportDiagnostic({
      level: "error",
      event: "servers.change_error",
      message: `Failed to apply MCP server registration change: ${message}`,
      fields: { kind },
    });
    if (this.isActiveEpoch(epoch)) {
      ctx.ui.notify(`pi-mcp: Failed to apply server registration change — ${message}`, "error");
    }
  }

  private enqueueServerReconcile(ctx: ExtensionContext): Promise<void> {
    const epoch = this.sessionEpoch;
    // WHY: Pi's registry announces every register()/unregister(), including during extension
    // loading (before session_start has checked trust and read <cwd>/.pi/mcp.json) and after
    // session_shutdown. Spawning servers then attaches child processes to no session; the
    // built-in MCP extension ignores those events the same way (its session signal starts
    // aborted). session_start reads the registry itself, so the turn just no-ops instead.
    const turn = this.reconcileQueue.then(() => this.reconcileRegisteredServers(ctx, epoch));
    // WHY: the emitter is fire-and-forget, so a rejected turn would become an unhandled
    // rejection; report it instead and keep the queue usable for later registrations.
    this.reconcileQueue = turn.catch((err: unknown) => {
      this.handleReconcileError(err, epoch, ctx);
    });
    return this.reconcileQueue;
  }

  /**
   * Bring the manager, bridge, and config in line with the current registrations.
   *
   * `isActiveEpoch` and `changeEventCount` are checked at entry and after each removal await, so a
   * session switch/shutdown or a newer registration that arrived while a teardown was in flight
   * stops the turn before it re-adds or starts superseded servers. An eager start already running
   * when a newer registration or session transition arrives is aborted via `runEagerStarts`.
   */
  private async reconcileRegisteredServers(
    ctx: ExtensionContext,
    epoch: number,
  ): Promise<void> {
    const snapshotCount = this.changeEventCount;
    if (!this.isActiveEpoch(epoch) || this.appliedChangeCount === snapshotCount) return;

    this.deps.coordinator.setActiveContext(ctx);
    setDiagnosticUi(ctx.ui, ctx.hasUI);

    const configErrors: string[] = [];
    const nextExtensionServers = collectRegisteredServers(
      this.getRegisteredEntries(),
      this.fileConfig.mcpServers,
      (err) => {
        configErrors.push(formatErrorMessage(err));
      },
    );

    const removedOrChanged = findRemovedOrChangedServers(
      this.extensionServers,
      nextExtensionServers,
    );
    for (const name of removedOrChanged) {
      this.deps.coordinator.cancelServer(name);
      this.deps.bridge.removeServer(name);
      this.deps.resources.forget(name);
      this.removeAppliedServer(name);
      await this.deps.manager.removeServer(name);
      this.deps.coordinator.syncStatus(ctx);
      // WHY: the next step re-adds and starts servers, which must never happen when the
      // session went away or a newer registration superseded this snapshot during teardown.
      if (!this.isActiveEpoch(epoch) || this.changeEventCount !== snapshotCount) return;
    }

    for (const msg of configErrors) {
      ctx.ui.notify(`pi-mcp: Config error — ${msg}`, "error");
    }

    const addedEager = stageAddedServers(this.deps.manager, nextExtensionServers);
    this.applyServers(nextExtensionServers, snapshotCount);
    this.deps.coordinator.syncStatus(ctx);

    if (addedEager.length > 0) {
      await this.runEagerStarts(addedEager, ctx);
    }
  }
}
