/**
 * Tool bridge coordinator for pi-mcp.
 *
 * Manages stateful per-server MCP → Pi tool lifecycle:
 *   - Generation-guarded `refreshTools` discovery (`discoverServerTools`)
 *   - Deterministic Pi tool naming, Pi 1.3.0 exposure resolution, registration, and withdrawal (`planServerToolBatch`)
 *   - Peer-aware server `ToolNamespace` construction and rebinding (`syncServerNamespaces`)
 *   - Live `tools/list_changed` active-state/dropped-tool memory and `_pendingToolNames` restore (`reconcileLiveRefreshState`, `mergePendingRestoredTools`)
 *   - Deterministic active-list and outgoing provider-payload ordering (`orderActiveTools`, `orderPayloadTools`)
 *   - Activate/deactivate, reload-preserving teardown, and `hidden` withdrawal across server disconnect/removal
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ExtensionAPI, ToolDefinition, ToolNamespace } from "@earendil-works/pi-coding-agent";
import type { Settings } from "./config.js";
import { McpError } from "./errors.js";
import {
  discoverServerTools,
  readClientInstructions,
  type McpToolDefinition,
} from "./tool-discovery.js";
import {
  createPiToolDefinition,
  toHiddenToolDefinition,
  type ToolAuthErrorHandler,
} from "./tool-execution.js";
import {
  assessRegisteredServerExposures,
  collectConnectedExposures,
  resolveDiscoveryActivation,
  type McpExposure,
  type RegisteredToolSummary,
} from "./tool-exposure.js";
import {
  buildServerToolNamespace,
  collectReboundToolDefinitions,
  mergePeerServerNames,
} from "./tool-namespace.js";
import {
  buildToolName,
  RESERVED_MANAGEMENT_TOOL_NAMES,
  resolveUniqueToolName,
} from "./tool-names.js";
import { orderOwnedEntries, orderPayloadToolEntries, sameToolList } from "./tool-order.js";
import {
  collectAddedExposures,
  collectReservedToolNames,
  deleteServerOwnedTools,
  filterOwnedTools,
  forgetServerCollisionState,
  mergePendingRestoredTools,
  mergeRawToolExposures,
  normalizeRefreshArgs,
  orderOwnedActiveTools,
  planActiveToolReconciliation,
  planServerToolBatch,
  planTreeDirectToolRestore,
  pruneTreeDeactivatedDirectTools,
  reconcileLiveRefreshState,
  recordBaseNameCandidate,
  recordCrossServerCollision,
  snapshotActiveStateByRawName,
  updateTreeDeactivatedDirectTools,
  type ServerToolBatchPlan,
} from "./tool-reconcile.js";

export { buildToolName } from "./tool-names.js";
export { convertMcpContent } from "./tool-content.js";
export { formatProgressText, type ToolUpdateCallback } from "./tool-execution.js";
export { listAllTools, type McpToolDefinition } from "./tool-discovery.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Subset of Pi's ExtensionAPI used by the bridge (`getAllTools` is optional for minimal test mocks). */
export type PiExtensionAPI = Pick<
  ExtensionAPI,
  "registerTool" | "getActiveTools" | "setActiveTools"
> & {
  getAllTools?: (() => readonly RegisteredToolSummary[]) | undefined;
};

export type ToolRefreshOptions = {
  requestTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Server-level tool exposure (Pi 1.3.0 `exposure`). Default: `direct`. */
  exposure?: McpExposure | undefined;
  /** Per-tool exposure overrides, keyed by the raw MCP tool name (`tools/list` name). */
  toolExposure?: Readonly<Record<string, McpExposure>> | undefined;
  /** Optional configured server summary (Pi 1.3.0 `description`), forwarded on `namespace`. */
  description?: string | undefined;
  /** Optional configured peer server names for deterministic `ToolNamespace` disambiguation. */
  peerServerNames?: Iterable<string> | undefined;
};

/**
 * Tool counts for one server: everything registered (`discovered`), everything Pi has
 * active (`active`), and the tools whose exposure makes this bridge activate them
 * (`expected`).
 */
export interface ToolActivity {
  discovered: number;
  active: number;
  expected: number;
}

interface RegisterToolParams {
  piName: string;
  serverName: string;
  tool: McpToolDefinition;
  client: Client;
  exposure: McpExposure;
  namespace: ToolNamespace;
}

interface DisplacementResult {
  oldNames: Set<string>;
  desiredActive: Set<string>;
  cliFilteredDirectNames: Set<string>;
  piExposures: Map<string, McpExposure>;
  affectedIncumbents: Set<string>;
}

interface DisplaceIncumbentContext {
  baseName: string;
  incumbentServer: string;
  batchToolNames: ReadonlySet<string>;
  collidedBaseNames: ReadonlySet<string>;
  reservedNames: ReadonlySet<string>;
  activeBeforeSet: ReadonlySet<string>;
  allToolsBeforeNames: ReadonlySet<string> | undefined;
  displacement: DisplacementResult;
}

interface DisplaceCollisionsOptions {
  incomingServer: string;
  batch: ServerToolBatchPlan;
  collidedBaseNames: Set<string>;
  reservedNames: ReadonlySet<string>;
  activeBeforeSet: ReadonlySet<string>;
  allToolsBeforeNames: ReadonlySet<string> | undefined;
}

// ─── Tool Bridge ──────────────────────────────────────────────────────────────

/**
 * Manages MCP tools as Pi tools for a set of servers.
 * Tools are registered once and activated/deactivated as servers connect/disconnect.
 */
export class ToolBridge {
  private settings: Settings;
  private autoEnableCodemode: boolean;
  private reloadShuttingDown = false;
  private readonly pi: PiExtensionAPI;
  /** Tracks which Pi tool names belong to which MCP server. */
  private readonly serverToolNames = new Map<string, Set<string>>();
  /** Tracks which MCP server owns each registered Pi tool name. */
  private readonly toolOwners = new Map<string, string>();
  /** Latest `ToolDefinition` registered for each owned Pi tool name, used to hide stopped tools. */
  private readonly registeredDefinitions = new Map<string, ToolDefinition>();
  /**
   * Servers whose tools this bridge has activated and not deactivated since.
   * A server that is still in this set may have had individual tools removed from Pi's
   * active set by another extension or a user policy, and a refresh must not undo that.
   */
  private readonly activeServers = new Set<string>();
  /**
   * Per server, whether each raw MCP tool name was active in Pi when the current connection
   * stopped advertising it. A re-advertised tool is not "new", so it must come back in the
   * state it left in — a tool a policy had deactivated stays inactive; one the bridge
   * deactivated when the server dropped it returns active.
   */
  private readonly droppedToolState = new Map<string, Map<string, boolean>>();
  /**
   * Per server, the raw MCP tool name behind each Pi tool name in the latest snapshot, so
   * tool state follows the MCP tool's identity even when a colliding sibling shifts its Pi
   * name or a new tool recycles a dropped tool's Pi name.
   */
  private readonly rawToolNames = new Map<string, Map<string, string>>();
  /** Per server, the resolved MCP exposure of each raw tool name on the active connection. */
  private readonly rawToolExposures = new Map<string, Map<string, McpExposure>>();
  /** Per server, the distinct resolved MCP exposures of currently advertised tools while active. */
  private readonly activeServerExposures = new Map<string, ReadonlySet<McpExposure>>();
  /** Servers whose indirect (`codemode` / `deferred`) tools were all dropped by Pi's `--tools` / `--exclude-tools`. */
  private readonly indirectFilteredServers = new Set<string>();
  /**
   * Per server, the Pi names whose configured exposure is `direct` — the tools this bridge
   * registers active. Deferred, codemode-only, and hidden tools are registered too, but
   * they are never activated here (Pi's `tool_search` may load a deferred one later).
   */
  private readonly directToolNames = new Map<string, Set<string>>();
  /** Monotonic per-server generation counter to discard out-of-order refreshTools responses. */
  private readonly refreshGenerations = new Map<string, number>();
  /** Per-server request timeout overrides resolved during refreshTools. */
  private readonly serverTimeouts = new Map<string, number>();
  /**
   * Every Pi tool name ever registered by this bridge, so retired `hidden` placeholders in
   * `pi.getAllTools()` are never misclassified as foreign tools (#332).
   */
  private readonly bridgeRegisteredNames = new Set<string>();
  /** Live registration inputs by Pi tool name so displaced cross-server incumbents can be rebound (#331). */
  private readonly liveToolBindings = new Map<string, Omit<RegisterToolParams, "piName">>();
  /** Unhashed `<prefix>_<server>_<tool>` ownership kept across transient withdrawals/stops (#331). */
  private readonly baseNameOwners = new Map<string, string>();
  /** Unhashed Pi base names -> servers advertising tools targeting that base name (#331). */
  private readonly baseNameCandidates = new Map<string, Set<string>>();
  /** Colliding unhashed Pi tool names -> competing server names (pruned when `< 2` remain) (#331). */
  private readonly collidedBaseServers = new Map<string, Set<string>>();
  /** Snapshot of `pi.getActiveTools()` taken on `session_before_tree` and consumed on `session_tree` (#333). */
  private preTreeActiveSnapshot: Set<string> | undefined;
  /** Per server, raw MCP tool names of `direct` tools deactivated by `/tree` for one-shot restore (#333). */
  private readonly treeDeactivatedDirectTools = new Map<string, Set<string>>();
  private onAuthError?: ToolAuthErrorHandler | undefined;
  private onDiscoveryWarning?: ((message: string) => void) | undefined;

  constructor(settings: Settings, pi: PiExtensionAPI, autoEnableCodemode = true) {
    this.settings = settings;
    this.pi = pi;
    this.autoEnableCodemode = autoEnableCodemode !== false;
  }

  /** Register callback invoked when a mid-session tools/list or tools/call fails with 401/403. */
  setAuthErrorCallback(cb: ToolAuthErrorHandler): void {
    this.onAuthError = cb;
  }

  /** Register callback invoked when indirect MCP tools have neither reaching discovery tool active. */
  setDiscoveryWarningCallback(cb: (message: string) => void): void {
    this.onDiscoveryWarning = cb;
  }

  /** Update Pi 1.3.0 `autoEnableCodemode` (`undefined` resets to the default `true`). */
  setAutoEnableCodemode(autoEnableCodemode: boolean | undefined): void {
    this.autoEnableCodemode = autoEnableCodemode !== false;
  }

  /**
   * Mark whether the outgoing `ExtensionRunner` is tearing down for `/reload` (`session_shutdown`
   * with `reason === "reload"`), so `deactivateServer` leaves Pi's active tool names intact for
   * `AgentSession.reload()` to snapshot into `_pendingToolNames` (#257).
   */
  setReloadShutdown(active: boolean): void {
    this.reloadShuttingDown = active;
  }

  /** Current configured tool prefix (e.g. `"mcp"`). */
  getToolPrefix(): string {
    return this.settings.toolPrefix;
  }

  /** Whether `serverName` currently has live discovered tools registered on this bridge. */
  isServerActive(serverName: string): boolean {
    return this.activeServers.has(serverName);
  }

  /** Distinct resolved MCP exposures of `serverName`'s currently advertised tools while connected. */
  getServerExposures(serverName: string): Set<McpExposure> {
    return new Set(this.activeServerExposures.get(serverName));
  }

  /**
   * Whether `serverName` registered indirect (`codemode` / `deferred`) tools on its latest refresh
   * that Pi's `--tools` / `--exclude-tools` filter removed from `pi.getAllTools()`.
   */
  hasAllIndirectToolsFiltered(serverName: string): boolean {
    return this.indirectFilteredServers.has(serverName);
  }

  /** Distinct resolved MCP exposures across all currently connected servers. */
  getConnectedExposures(): Set<McpExposure> {
    return collectConnectedExposures(this.activeServerExposures.values());
  }

  /** Update bridge settings when session config is reloaded on session_start. */
  updateSettings(settings: Settings): void {
    const prevDefaultTimeoutMs = this.settings.requestTimeoutMs;
    const prefixChanged = settings.toolPrefix !== this.settings.toolPrefix;
    this.settings = settings;
    if (prefixChanged) {
      this.baseNameOwners.clear();
      this.baseNameCandidates.clear();
      this.collidedBaseServers.clear();
    }
    for (const [serverName, timeoutMs] of this.serverTimeouts.entries()) {
      if (timeoutMs === prevDefaultTimeoutMs) {
        this.serverTimeouts.delete(serverName);
      }
    }
  }

  /**
   * Activate Pi's reaching discovery tools (`codemode` / `tool_search`) in deterministic order
   * ahead of concurrent eager connects when configured exposures require them (#257).
   */
  ensureDiscoveryTools(exposures: Iterable<McpExposure>): void {
    const activeBefore = this.pi.getActiveTools();
    const toActivate = this._resolveDiscoveryTools(exposures, activeBefore);
    if (toActivate.length === 0) return;
    const nextActive = orderOwnedActiveTools(
      new Set([...activeBefore, ...toActivate]),
      (name) => this.toolOwners.has(name),
    );
    if (sameToolList(this.pi.getActiveTools(), nextActive)) return;
    this.pi.setActiveTools(nextActive);
  }

  /**
   * Refresh tools for a server — called on initial connect and on list_changed.
   * Always re-registers tools with the current client reference so that
   * tool execute closures capture the latest client after reconnection.
   * Deactivates tools that are no longer in the server's list.
   * Note: Pi's registerTool() overwrites by name (Map.set), so re-registration is safe.
   */
  async refreshTools(
    serverName: string,
    client: Client,
    isCurrentOrOptions?: (() => boolean) | ToolRefreshOptions,
    maybeOptions?: ToolRefreshOptions,
  ): Promise<void> {
    const { isCurrent, options } = normalizeRefreshArgs(isCurrentOrOptions, maybeOptions);
    const effectiveTimeoutMs = this._recordServerTimeout(serverName, options?.requestTimeoutMs);
    const gen = this._bumpRefreshGeneration(serverName);

    const tools = await discoverServerTools({
      client,
      serverName,
      requestTimeoutMs: effectiveTimeoutMs,
      signal: options?.signal,
      onAuthError: (srv, err) => this.onAuthError?.(srv, err),
    });

    // WHY: Discard stale tools/list responses if a newer refreshTools(),
    // deactivateServer(), or removeServerTools() occurred while listAllTools() was in flight.
    if (this.refreshGenerations.get(serverName) !== gen || !isCurrent()) return;
    this._reconcileTools(serverName, tools, client, options);
  }

  /**
   * Report discovery separately from the tools currently exposed by Pi.
   *
   * `discovered` counts every registered tool, including ones exposure keeps out of the
   * model. `expected` counts the tools whose resolved exposure is `direct` — the ones this
   * bridge activates — so `active < expected` means a policy or another extension removed
   * tools rather than the user configuring a smaller exposure on purpose (#257).
   */
  getToolActivity(serverName: string): ToolActivity {
    const names = this.serverToolNames.get(serverName) ?? new Set<string>();
    const active = new Set(this.pi.getActiveTools());
    return {
      discovered: names.size,
      active: [...names].filter((name) => active.has(name)).length,
      expected: this.directToolNames.get(serverName)?.size ?? 0,
    };
  }

  /**
   * Direct tools this bridge owns that Pi does not currently have active.
   *
   * WHY: verified per name, never by subtracting the `active` and `expected` totals — `active`
   * also counts non-direct tools Pi's `tool_search` loaded, so with `direct` 2 / `deferred` 1 an
   * activated deferred tool masks a direct tool another extension removed (2 === 2) and
   * `mcp_connect` would report success while a configured tool is unreachable (#257).
   */
  getInactiveDirectTools(serverName: string): string[] {
    const direct = this.directToolNames.get(serverName);
    if (!direct) return [];
    const active = new Set(this.pi.getActiveTools());
    return [...direct].filter((name) => !active.has(name));
  }

  /** Capture active tools immediately before `/tree` restores transcript tools (#333). */
  snapshotPreTreeActiveTools(): void {
    this.preTreeActiveSnapshot = new Set(this.pi.getActiveTools());
  }

  /** Discard any pending pre-`/tree` snapshot (e.g. after a cancelled `session_before_tree`) (#333). */
  clearPreTreeSnapshot(): void {
    this.preTreeActiveSnapshot = undefined;
  }

  /**
   * Record `direct` tools stripped across `/tree` (accumulating across consecutive `/tree` hops
   * and pruning any tools active again on the target branch) (#333).
   */
  recordTreeDeactivations(): void {
    const before = this.preTreeActiveSnapshot;
    this.preTreeActiveSnapshot = undefined;
    const current = new Set(this.pi.getActiveTools());
    const servers = new Set([
      ...this.directToolNames.keys(),
      ...this.treeDeactivatedDirectTools.keys(),
    ]);
    for (const serverName of servers) {
      const next = updateTreeDeactivatedDirectTools({
        existing: this.treeDeactivatedDirectTools.get(serverName),
        directTools: this.directToolNames.get(serverName),
        rawToolNames: this.rawToolNames.get(serverName),
        droppedToolState: this.droppedToolState.get(serverName),
        rawToolExposures: this.rawToolExposures.get(serverName),
        beforeActive: before,
        currentActive: current,
      });
      this._setOrDeleteMapEntry(this.treeDeactivatedDirectTools, serverName, next);
    }
  }

  /**
   * One-shot restoration of `direct` tools previously deactivated by `/tree` for `serverName`,
   * called by `mcp_connect` and `/mcp:start` without overriding extension restrictions (#333).
   */
  restoreTreeDeactivatedDirectTools(serverName: string): void {
    const pending = this.treeDeactivatedDirectTools.get(serverName);
    this.treeDeactivatedDirectTools.delete(serverName);
    if (!this.activeServers.has(serverName)) return;
    const activeBefore = this.pi.getActiveTools();
    const nextActive = planTreeDirectToolRestore({
      pendingRawNames: pending,
      directTools: this.directToolNames.get(serverName),
      rawToolNames: this.rawToolNames.get(serverName),
      activeBefore,
      isOwned: (name) => this.toolOwners.has(name),
    });
    if (nextActive !== undefined) {
      this.pi.setActiveTools(nextActive);
    }
  }

  /**
   * Re-apply this bridge's deterministic tool order to Pi's active list when owned tools have
   * been reordered externally, and do nothing when already ordered.
   *
   * WHY: `/tree` navigation (`session_tree`) restores active tools from the transcript's
   * first-appearance order without re-running `refreshTools`, and another extension or tool
   * (e.g. `tool_search`) may call `pi.setActiveTools` idle or mid-turn; re-normalizing on
   * `session_tree`, `input`, `before_agent_start`, and `tool_execution_end` keeps `sections.tools`
   * in the system prompt aligned with `orderPayloadTools` without re-activating inactive tools (#278).
   */
  orderActiveTools(): void {
    const current = this.pi.getActiveTools();
    this._pruneActiveTreeDeactivations(new Set(current));
    const ordered = orderOwnedEntries(
      current,
      (name) => name,
      (name) => this.toolOwners.has(name),
    );
    if (ordered === undefined) return;
    this.pi.setActiveTools(ordered);
  }

  /**
   * Order this bridge's tools in an outgoing provider payload the same way they are ordered in
   * Pi's active list — across top-level `tools` (Anthropic, OpenAI Chat Completions & Responses,
   * Mistral), AWS Bedrock Converse `toolConfig.tools`, Google/Vertex
   * `config.tools[].functionDeclarations`, and `pi-messages` `context.messages[].toolsAdded` —
   * and return the payload untouched when they already are. Only entries this bridge owns move,
   * and only among the slots they already occupy: another extension's tool and Pi's reserved
   * trailing declarations (`__pi_deferred_placeholder__`, `cachePoint`, non-function Gemini tool
   * groups, non-system messages) keep their positions.
   *
   * WHY: request tool arrays are not built from the active list — Pi replays the transcript's
   * tool declarations in first-appearance order and emits no delta for a pure reorder, so a
   * server that connects after the first turn leaves its tools at the end, in connect order.
   * Sorting the payload makes the declared tools a function of the tool set, so the prompt head
   * stays stable across sessions and a server-side prefix cache keeps its KV entries (#278).
   */
  orderPayloadTools(payload: unknown): unknown {
    return orderPayloadToolEntries(payload, (name) => this.toolOwners.has(name));
  }

  /** Deactivate all Pi tools belonging to a server (called on disconnect). */
  deactivateServer(serverName: string): void {
    this._bumpRefreshGeneration(serverName);
    this.activeServers.delete(serverName);
    this.activeServerExposures.delete(serverName);
    this.indirectFilteredServers.delete(serverName);
    this.treeDeactivatedDirectTools.delete(serverName);
    this._deleteServerLiveBindings(serverName);
    // WHY: stopping the server turns every tool off, so what each one "left in" belongs to a
    // connection that no longer exists; a fresh connect rediscovers the state from scratch.
    this.droppedToolState.delete(serverName);
    this.rawToolNames.delete(serverName);
    this.rawToolExposures.delete(serverName);
    // WHY: `AgentSession.reload()` emits `session_shutdown` (`reason: "reload"`) on the outgoing
    // runner *before* snapshotting `getActiveToolNames()` into `_pendingToolNames` and replacing
    // the runner. Skipping Pi-side hiding/deactivation during reload preserves active MCP tool
    // names (including `tool_search`-loaded deferred tools) for the incoming runner while clearing
    // `activeServers` / `rawToolNames` above still blocks stale calls on this bridge (#257).
    if (this.reloadShuttingDown) return;
    // WHY: Snapshot `activeTools` before `_hideOwnedServerTools` calls `pi.registerTool(hidden)`.
    // Pi's `_refreshToolRegistry()` re-adds every declarable `--tools` match across all servers on
    // each `registerTool`, which would resurrect another server's externally deactivated `direct`
    // tool if `_deactivateServerTools` read `getActiveTools()` afterward (#257).
    const activeBefore = [...this.pi.getActiveTools()];
    // WHY: Pi has no `unregisterTool`, and `tool_search` / `codemode` read `_toolRegistry`
    // (`AgentSession._getCallableTools`) rather than `activeTools` — re-registering owned tools
    // with `exposure: "hidden"` before reconciling `activeTools` stops both from discovering,
    // loading, or calling a disconnected server's stale `Client` (#257).
    this._hideOwnedServerTools(serverName, false);
    this._deactivateServerTools(serverName, activeBefore);
  }

  /** Remove all tracking data for a server (called when config changes remove a server). */
  removeServer(serverName: string): void {
    this.removeServerTools(serverName);
  }

  /** Remove all tools and ownership tracking for a server. */
  removeServerTools(serverName: string): void {
    this._bumpRefreshGeneration(serverName);
    this.serverTimeouts.delete(serverName);
    this.activeServers.delete(serverName);
    this.activeServerExposures.delete(serverName);
    this.indirectFilteredServers.delete(serverName);
    this.treeDeactivatedDirectTools.delete(serverName);
    this._deleteServerLiveBindings(serverName);
    forgetServerCollisionState(
      serverName,
      this.baseNameOwners,
      this.collidedBaseServers,
      this.baseNameCandidates,
    );
    this.droppedToolState.delete(serverName);
    this.rawToolNames.delete(serverName);
    this.rawToolExposures.delete(serverName);
    this.directToolNames.delete(serverName);
    const activeBefore = [...this.pi.getActiveTools()];
    this._hideOwnedServerTools(serverName, true);
    this._deactivateServerTools(serverName, activeBefore);
    deleteServerOwnedTools(serverName, this.serverToolNames, this.toolOwners);
  }

  /**
   * Clear all session-scoped ownership, activity, exposure, collision, and `/tree` state after
   * a non-reload `session_shutdown` teardown so a subsequent `new_session` starts identically
   * to a fresh process while keeping `bridgeRegisteredNames` intact for retired Pi placeholders.
   */
  resetSessionState(): void {
    this.preTreeActiveSnapshot = undefined;
    this.treeDeactivatedDirectTools.clear();
    this.baseNameOwners.clear();
    this.baseNameCandidates.clear();
    this.collidedBaseServers.clear();
    this.toolOwners.clear();
    this.serverToolNames.clear();
    this.directToolNames.clear();
    this.registeredDefinitions.clear();
    this.activeServers.clear();
    this.liveToolBindings.clear();
    this.droppedToolState.clear();
    this.rawToolNames.clear();
    this.rawToolExposures.clear();
    this.activeServerExposures.clear();
    this.indirectFilteredServers.clear();
    this.serverTimeouts.clear();
  }

  /**
   * Re-sync `ToolDefinition.namespace` on active servers when `mcp_servers_change` adds or
   * removes a peer whose sanitized name collides (`my-srv` vs `my_srv`), without network I/O.
   */
  syncServerNamespaces(peerServerNames: Iterable<string>): void {
    const activeBefore = [...this.pi.getActiveTools()];
    if (!this._rebindActiveNamespaces(peerServerNames)) return;
    if (!sameToolList(this.pi.getActiveTools(), activeBefore)) {
      this.pi.setActiveTools(activeBefore);
    }
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  /** Advance the per-server refresh generation so in-flight refreshes are discarded. */
  private _bumpRefreshGeneration(serverName: string): number {
    const gen = (this.refreshGenerations.get(serverName) ?? 0) + 1;
    this.refreshGenerations.set(serverName, gen);
    return gen;
  }

  /**
   * Record (or clear) the per-server request timeout override and return the
   * timeout this refresh must use.
   */
  private _recordServerTimeout(serverName: string, explicitTimeoutMs: number | undefined): number {
    if (explicitTimeoutMs !== undefined) {
      this.serverTimeouts.set(serverName, explicitTimeoutMs);
    } else {
      this.serverTimeouts.delete(serverName);
    }
    return explicitTimeoutMs ?? this.settings.requestTimeoutMs;
  }

  private _rebindActiveNamespaces(peerServerNames: Iterable<string>): boolean {
    const rebound = collectReboundToolDefinitions({
      prefix: this.settings.toolPrefix,
      activeServers: this.activeServers,
      serverToolNames: this.serverToolNames,
      toolOwners: this.toolOwners,
      definitions: this.registeredDefinitions,
      peerServerNames,
    });
    for (const definition of rebound) {
      this.registeredDefinitions.set(definition.name, definition);
      this.pi.registerTool(definition);
    }
    return rebound.length > 0;
  }

  /**
   * Register the freshly discovered tools, hide and release ownership of any Pi names the
   * server no longer uses, and reconcile Pi's active tool set (including discovery tools
   * and indirect tools restored from Pi 1.3.0 `_pendingToolNames`).
   */
  private _reconcileTools(
    serverName: string,
    tools: McpToolDefinition[],
    client: Client,
    options: ToolRefreshOptions | undefined,
  ): void {
    const registeredForServer = this.serverToolNames.get(serverName) ?? new Set<string>();
    const ownedPreviousNames = filterOwnedTools(serverName, registeredForServer, this.toolOwners);
    // WHY: Copy before calling `this._registerTool` — Pi's `registerTool()` runs
    // `_refreshToolRegistry()`, which auto-activates newly registered tool names,
    // `--tools` allowlist matches, and `_pendingToolNames` entries while registering.
    const activeBefore = [...this.pi.getActiveTools()];
    const previousStateByRawName = this.activeServers.has(serverName)
      ? snapshotActiveStateByRawName(
          ownedPreviousNames,
          this.rawToolNames.get(serverName),
          new Set(activeBefore),
        )
      : undefined;
    const peerServerNames = mergePeerServerNames(
      serverName,
      this.activeServers,
      options?.peerServerNames,
    );
    const namespace = buildServerToolNamespace({
      prefix: this.settings.toolPrefix,
      serverName,
      description: options?.description,
      instructions: readClientInstructions(client),
      peerServerNames,
    });

    const allToolsBefore = this.pi.getAllTools?.();
    const allToolsBeforeNames = allToolsBefore
      ? new Set(allToolsBefore.map((tool) => tool.name))
      : undefined;
    const reservedNames = collectReservedToolNames(
      RESERVED_MANAGEMENT_TOOL_NAMES,
      allToolsBefore,
      this.bridgeRegisteredNames,
    );
    const collidedBaseNames = new Set(this.collidedBaseServers.keys());
    const batch = planServerToolBatch({
      prefix: this.settings.toolPrefix,
      serverName,
      tools,
      toolOwners: this.toolOwners,
      ownedPreviousNames,
      exposureConfig: options,
      peerServerNames,
      collidedBaseNames,
      baseNameOwners: this.baseNameOwners,
      reservedNames,
    });
    const displacement = this._displaceCrossServerCollisions({
      incomingServer: serverName,
      batch,
      collidedBaseNames,
      reservedNames,
      activeBeforeSet: new Set(activeBefore),
      allToolsBeforeNames,
    });
    for (const { piName, tool, exposure } of batch.plannedTools) {
      this.toolOwners.set(piName, serverName);
      // Always re-register — on reconnect the client reference changes and
      // Pi's registerTool overwrites by name, so this is idempotent.
      this._registerTool({ piName, serverName, tool, client, exposure, namespace });
    }
    this._recordBaseNameOwners(serverName, batch, collidedBaseNames, reservedNames);
    const activeAfterRegistration = [...this.pi.getActiveTools()];
    this._releaseWithdrawnTools(batch.withdrawnToolNames);

    const allTools = this.pi.getAllTools?.();
    this._promoteAllowedDisplacedDirect(displacement, allTools);
    const serverExposures = this._assessServerExposures(serverName, batch.piExposures, allTools);
    const incumbentExposures = this._reassessAffectedIncumbents(
      displacement.affectedIncumbents,
      allTools,
    );

    // WHY: `pi.setActiveTools` is shared with every other extension and the user, so an already
    // connected server's tool set may have been narrowed on purpose. A live `tools/list_changed`
    // therefore preserves each raw tool's active/inactive state (including across collision
    // re-settlement and drop/re-advertisement) unless exposure itself crossed `direct` or became
    // `hidden`, while a first connect or a reconnect activates configured `direct` tools plus any
    // indirect tools Pi 1.3.0 restored from `_pendingToolNames` (#214, #257).
    const baseDesiredActive = previousStateByRawName
      ? this._applyLiveRefreshState(
          serverName,
          batch.currentRawNames,
          batch.currentExposures,
          previousStateByRawName,
        )
      : batch.directToolNames;
    const mergedPiExposures = new Map([...batch.piExposures, ...displacement.piExposures]);
    const desiredActive = mergePendingRestoredTools({
      desiredActive: new Set([...baseDesiredActive, ...displacement.desiredActive]),
      piExposures: mergedPiExposures,
      activeBefore,
      activeAfterRegistration,
      allTools,
    });
    for (const oldName of displacement.oldNames) {
      ownedPreviousNames.add(oldName);
    }
    const mergedRawExposures = mergeRawToolExposures(
      this.rawToolExposures.get(serverName),
      batch.currentExposures,
      this.droppedToolState.get(serverName),
    );
    this._syncTreeDeactivationsOnReconcile(
      serverName,
      previousStateByRawName !== undefined,
      batch,
      mergedRawExposures,
      desiredActive,
    );

    this.rawToolExposures.set(serverName, mergedRawExposures);
    this.serverToolNames.set(serverName, batch.currentToolNames);
    this.rawToolNames.set(serverName, batch.currentRawNames);
    this.directToolNames.set(serverName, batch.directToolNames);
    this.activeServerExposures.set(serverName, serverExposures);
    this.activeServers.add(serverName);
    this._rebindActiveNamespaces(peerServerNames);
    const discoveryToActivate = this._resolveDiscoveryTools(
      new Set([...serverExposures, ...incumbentExposures]),
      activeBefore,
    );
    this._reconcileActiveTools(ownedPreviousNames, desiredActive, activeBefore, discoveryToActivate);
  }

  private _assessServerExposures(
    serverName: string,
    piExposures: ReadonlyMap<string, McpExposure>,
    allTools: readonly RegisteredToolSummary[] | undefined,
  ): Set<McpExposure> {
    const assessment = assessRegisteredServerExposures({
      serverName,
      toolPrefix: this.settings.toolPrefix,
      piExposures,
      allTools,
    });
    if (assessment.allIndirectFiltered) {
      this.indirectFilteredServers.add(serverName);
    } else {
      this.indirectFilteredServers.delete(serverName);
    }
    if (assessment.filteredWarning !== undefined) {
      this.onDiscoveryWarning?.(assessment.filteredWarning);
    }
    return assessment.exposures;
  }

  private _applyLiveRefreshState(
    serverName: string,
    currentRawNames: ReadonlyMap<string, string>,
    currentExposures: ReadonlyMap<string, McpExposure>,
    previousStateByRawName: ReadonlyMap<string, boolean>,
  ): Set<string> {
    const { desiredActive, dropped } = reconcileLiveRefreshState({
      currentRawNames,
      currentExposures,
      previousStateByRawName,
      previousExposures: this.rawToolExposures.get(serverName),
      previousDropped: this.droppedToolState.get(serverName),
    });
    this._setOrDeleteMapEntry(this.droppedToolState, serverName, dropped);
    return desiredActive;
  }

  private _setOrDeleteMapEntry<V>(map: Map<string, V>, key: string, value: V | undefined): void {
    if (value !== undefined) {
      map.set(key, value);
    } else {
      map.delete(key);
    }
  }

  private _pruneActiveTreeDeactivations(nowActive: ReadonlySet<string>): void {
    for (const [serverName, pending] of this.treeDeactivatedDirectTools) {
      const next = pruneTreeDeactivatedDirectTools({
        existing: pending,
        directTools: this.directToolNames.get(serverName),
        rawToolNames: this.rawToolNames.get(serverName),
        droppedToolState: this.droppedToolState.get(serverName),
        rawToolExposures: this.rawToolExposures.get(serverName),
        nowActive,
      });
      this._setOrDeleteMapEntry(this.treeDeactivatedDirectTools, serverName, next);
    }
  }

  private _syncTreeDeactivationsOnReconcile(
    serverName: string,
    isLiveRefresh: boolean,
    batch: ServerToolBatchPlan,
    mergedRawExposures: ReadonlyMap<string, McpExposure>,
    desiredActive: ReadonlySet<string>,
  ): void {
    if (!isLiveRefresh) {
      this.treeDeactivatedDirectTools.delete(serverName);
      return;
    }
    const remaining = pruneTreeDeactivatedDirectTools({
      existing: this.treeDeactivatedDirectTools.get(serverName),
      directTools: batch.directToolNames,
      rawToolNames: batch.currentRawNames,
      droppedToolState: this.droppedToolState.get(serverName),
      rawToolExposures: mergedRawExposures,
      nowActive: desiredActive,
    });
    this._setOrDeleteMapEntry(this.treeDeactivatedDirectTools, serverName, remaining);
  }

  private _deleteServerLiveBindings(serverName: string): void {
    for (const [piName, binding] of this.liveToolBindings) {
      if (binding.serverName === serverName) {
        this.liveToolBindings.delete(piName);
      }
    }
  }

  private _clearStoppedIncumbentClaim(baseName: string, incumbentServer: string): void {
    this._hideTool(baseName, true);
    this.toolOwners.delete(baseName);
    this.liveToolBindings.delete(baseName);
    this.serverToolNames.get(incumbentServer)?.delete(baseName);
    this.directToolNames.get(incumbentServer)?.delete(baseName);
    this.rawToolNames.get(incumbentServer)?.delete(baseName);
  }

  private _renameIncumbentTracking(
    serverName: string,
    oldPiName: string,
    newPiName: string,
    rawToolName: string,
  ): void {
    const serverTools = this.serverToolNames.get(serverName);
    serverTools?.delete(oldPiName);
    serverTools?.add(newPiName);
    const rawNames = this.rawToolNames.get(serverName);
    rawNames?.delete(oldPiName);
    rawNames?.set(newPiName, rawToolName);
    for (const set of [this.directToolNames.get(serverName), this.preTreeActiveSnapshot]) {
      if (set?.has(oldPiName)) {
        set.delete(oldPiName);
        set.add(newPiName);
      }
    }
  }

  private _displaceLiveIncumbent(ctx: DisplaceIncumbentContext): void {
    const {
      baseName,
      incumbentServer,
      batchToolNames,
      collidedBaseNames,
      reservedNames,
      activeBeforeSet,
      allToolsBeforeNames,
      displacement,
    } = ctx;
    const binding = this.liveToolBindings.get(baseName);
    if (!binding) return;
    const newPiName = resolveUniqueToolName({
      prefix: this.settings.toolPrefix,
      serverName: incumbentServer,
      rawToolName: binding.tool.name,
      seenInBatch: batchToolNames,
      toolOwners: this.toolOwners,
      forceHash: true,
      collidedBaseNames,
      reservedNames,
    });
    const currentNamespace = this.registeredDefinitions.get(baseName)?.namespace ?? binding.namespace;
    this._hideTool(baseName, true);
    this.toolOwners.delete(baseName);
    this.liveToolBindings.delete(baseName);
    this._renameIncumbentTracking(incumbentServer, baseName, newPiName, binding.tool.name);
    this.toolOwners.set(newPiName, incumbentServer);
    this._registerTool({ ...binding, namespace: currentNamespace, piName: newPiName });
    displacement.oldNames.add(baseName);
    if (activeBeforeSet.has(baseName)) {
      displacement.desiredActive.add(newPiName);
    } else if (
      binding.exposure === "direct" &&
      allToolsBeforeNames !== undefined &&
      !allToolsBeforeNames.has(baseName)
    ) {
      // WHY: Pi omits CLI-filtered (`--tools` / `--exclude-tools`) tools from `getAllTools()`,
      // whereas extension-deactivated and `/tree`-stripped tools remain registered there. If the
      // unhashed base name was excluded by CLI filters while the deterministic hashed name is
      // allowed, promote it after registration so connect order stays invariant (#331).
      displacement.cliFilteredDirectNames.add(newPiName);
    }
    displacement.piExposures.set(newPiName, binding.exposure);
    displacement.affectedIncumbents.add(incumbentServer);
  }

  private _promoteAllowedDisplacedDirect(
    displacement: DisplacementResult,
    allTools: readonly RegisteredToolSummary[] | undefined,
  ): void {
    if (displacement.cliFilteredDirectNames.size === 0 || !allTools) return;
    const allowedAfter = new Set(allTools.map((tool) => tool.name));
    for (const piName of displacement.cliFilteredDirectNames) {
      if (allowedAfter.has(piName)) {
        displacement.desiredActive.add(piName);
      }
    }
  }

  private _displaceCrossServerCollisions(options: DisplaceCollisionsOptions): DisplacementResult {
    const {
      incomingServer,
      batch,
      collidedBaseNames,
      reservedNames,
      activeBeforeSet,
      allToolsBeforeNames,
    } = options;
    const displacement: DisplacementResult = {
      oldNames: new Set(),
      desiredActive: new Set(),
      cliFilteredDirectNames: new Set(),
      piExposures: new Map(),
      affectedIncumbents: new Set(),
    };
    for (const [baseName, incumbentServer] of batch.crossServerCollisions) {
      recordCrossServerCollision(
        baseName,
        incumbentServer,
        incomingServer,
        this.collidedBaseServers,
        this.baseNameCandidates,
      );
      collidedBaseNames.add(baseName);
      this.baseNameOwners.delete(baseName);
      if (this.toolOwners.get(baseName) !== incumbentServer) continue;
      if (this.activeServers.has(incumbentServer)) {
        this._displaceLiveIncumbent({
          baseName,
          incumbentServer,
          batchToolNames: batch.currentToolNames,
          collidedBaseNames,
          reservedNames,
          activeBeforeSet,
          allToolsBeforeNames,
          displacement,
        });
      } else {
        this._clearStoppedIncumbentClaim(baseName, incumbentServer);
      }
    }
    return displacement;
  }

  private _recordBaseNameOwners(
    serverName: string,
    batch: ServerToolBatchPlan,
    collidedBaseNames: ReadonlySet<string>,
    reservedNames: ReadonlySet<string>,
  ): void {
    const prefix = this.settings.toolPrefix;
    for (const { piName, tool } of batch.plannedTools) {
      const base = buildToolName(prefix, serverName, tool.name, false);
      const hashed = buildToolName(prefix, serverName, tool.name, true);
      if (base === hashed || reservedNames.has(base)) continue;
      recordBaseNameCandidate(this.baseNameCandidates, base, serverName);
      if (collidedBaseNames.has(base)) {
        this.collidedBaseServers.get(base)?.add(serverName);
      } else if (piName === base) {
        this.baseNameOwners.set(base, serverName);
      }
    }
  }

  private _collectServerPiExposures(serverName: string): Map<string, McpExposure> {
    const exposures = new Map<string, McpExposure>();
    for (const piName of this.serverToolNames.get(serverName) ?? []) {
      const binding = this.liveToolBindings.get(piName);
      if (binding) {
        exposures.set(piName, binding.exposure);
      }
    }
    return exposures;
  }

  private _reassessAffectedIncumbents(
    affectedIncumbents: ReadonlySet<string>,
    allTools: readonly RegisteredToolSummary[] | undefined,
  ): Set<McpExposure> {
    const addedExposures: Set<McpExposure>[] = [];
    for (const incumbent of affectedIncumbents) {
      const previous = this.activeServerExposures.get(incumbent);
      const exposures = this._collectServerPiExposures(incumbent);
      const assessed = this._assessServerExposures(incumbent, exposures, allTools);
      this.activeServerExposures.set(incumbent, assessed);
      addedExposures.push(collectAddedExposures(previous, assessed));
    }
    return collectConnectedExposures(addedExposures);
  }

  private _registerTool(registration: RegisterToolParams): void {
    const { piName, serverName, tool, client, exposure, namespace } = registration;
    const definition = createPiToolDefinition({
      piName,
      serverName,
      tool,
      client,
      exposure,
      namespace,
      getTimeoutMs: () => this.serverTimeouts.get(serverName) ?? this.settings.requestTimeoutMs,
      assertCallable: () => this._assertToolCallable(serverName, piName, tool.name),
      // WHY: read the handler through `this` at call time — src/index.ts installs it after the
      // bridge is constructed, and it is the caller for every server, so it takes the name.
      onAuthError: (srv, err) => this.onAuthError?.(srv, err),
    });
    this.bridgeRegisteredNames.add(piName);
    this.liveToolBindings.set(piName, { serverName, tool, client, exposure, namespace });
    this.registeredDefinitions.set(piName, definition);
    this.pi.registerTool(definition);
  }

  private _assertToolCallable(serverName: string, piName: string, toolName: string): void {
    if (!this.activeServers.has(serverName)) {
      throw new McpError(
        `MCP server "${serverName}" is not connected`,
        serverName,
        "connection",
      );
    }
    const currentRaw = this.rawToolNames.get(serverName)?.get(piName);
    const isHidden = this.registeredDefinitions.get(piName)?.exposure === "hidden";
    if (this.toolOwners.get(piName) !== serverName || currentRaw !== toolName || isHidden) {
      throw new McpError(
        `Tool "${toolName}" is no longer available on MCP server "${serverName}"`,
        serverName,
        "tool",
      );
    }
  }

  private _hideTool(piName: string, forgetDefinition: boolean): void {
    const existing = this.registeredDefinitions.get(piName);
    if (!existing) return;
    const hidden = toHiddenToolDefinition(existing);
    if (hidden) {
      this.pi.registerTool(hidden);
      if (!forgetDefinition) {
        this.registeredDefinitions.set(piName, hidden);
      }
    }
    if (forgetDefinition) {
      this.registeredDefinitions.delete(piName);
    }
  }

  private _hideOwnedServerTools(serverName: string, forgetDefinitions: boolean): void {
    const serverTools = this.serverToolNames.get(serverName);
    if (!serverTools) return;
    for (const toolName of filterOwnedTools(serverName, serverTools, this.toolOwners)) {
      this._hideTool(toolName, forgetDefinitions);
    }
  }

  private _releaseWithdrawnTools(withdrawnToolNames: ReadonlySet<string>): void {
    for (const existingName of withdrawnToolNames) {
      this._hideTool(existingName, true);
      this.toolOwners.delete(existingName);
      this.liveToolBindings.delete(existingName);
    }
  }

  private _resolveDiscoveryTools(
    exposures: Iterable<McpExposure>,
    activeTools: readonly string[],
  ): string[] {
    if (typeof this.pi.getAllTools !== "function") return [];
    const plan = resolveDiscoveryActivation({
      exposures,
      allTools: this.pi.getAllTools(),
      activeTools,
      autoEnableCodemode: this.autoEnableCodemode,
    });
    if (plan.unreachableWarning !== undefined) {
      this.onDiscoveryWarning?.(plan.unreachableWarning);
    }
    return plan.activate;
  }

  private _reconcileActiveTools(
    ownedPreviousNames: ReadonlySet<string>,
    desiredActive: ReadonlySet<string>,
    activeBefore: readonly string[],
    discoveryToActivate: readonly string[] = [],
  ): void {
    const nextActive = planActiveToolReconciliation({
      ownedPreviousNames,
      desiredActive,
      activeBefore,
      currentActive: this.pi.getActiveTools(),
      isOwned: (name) => this.toolOwners.has(name),
      extraActive: discoveryToActivate,
    });
    if (nextActive === undefined) return;
    this.pi.setActiveTools(nextActive);
  }

  private _deactivateServerTools(serverName: string, activeBefore: readonly string[]): void {
    const serverTools = this.serverToolNames.get(serverName);
    if (!serverTools || serverTools.size === 0) return;

    const ownedByServer = filterOwnedTools(serverName, serverTools, this.toolOwners);
    if (ownedByServer.size === 0) return;

    this._reconcileActiveTools(ownedByServer, new Set(), activeBefore);
  }
}
