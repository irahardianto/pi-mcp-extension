/**
 * Tool bridge coordinator for pi-mcp.
 *
 * Manages stateful per-server MCP → Pi tool lifecycle:
 *   - Generation-guarded `refreshTools` discovery (`discoverServerTools`)
 *   - Deterministic Pi tool naming, registration, and withdrawal (`planServerToolBatch`)
 *   - Live `tools/list_changed` active-state and dropped-tool memory (`reconcileLiveRefreshState`)
 *   - Deterministic active-list and outgoing provider-payload ordering (`orderActiveTools`, `orderPayloadTools`)
 *   - Activate/deactivate and ownership cleanup across server disconnect/removal
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Settings } from "./config.js";
import { discoverServerTools, type McpToolDefinition } from "./tool-discovery.js";
import { createPiToolDefinition, type ToolAuthErrorHandler } from "./tool-execution.js";
import { orderOwnedEntries, orderPayloadToolEntries } from "./tool-order.js";
import {
  deleteServerOwnedTools,
  filterOwnedTools,
  normalizeRefreshArgs,
  planActiveToolReconciliation,
  planServerToolBatch,
  reconcileLiveRefreshState,
  snapshotActiveStateByRawName,
} from "./tool-reconcile.js";

export { buildToolName } from "./tool-names.js";
export { convertMcpContent } from "./tool-content.js";
export { formatProgressText, type ToolUpdateCallback } from "./tool-execution.js";
export { listAllTools, type McpToolDefinition } from "./tool-discovery.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Subset of Pi's ExtensionAPI used by the bridge. */
export type PiExtensionAPI = Pick<ExtensionAPI, "registerTool" | "getActiveTools" | "setActiveTools">;

export type ToolRefreshOptions = {
  requestTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
};

// ─── Tool Bridge ──────────────────────────────────────────────────────────────

/**
 * Manages MCP tools as Pi tools for a set of servers.
 * Tools are registered once and activated/deactivated as servers connect/disconnect.
 */
export class ToolBridge {
  private settings: Settings;
  private readonly pi: PiExtensionAPI;
  /** Tracks which Pi tool names belong to which MCP server. */
  private readonly serverToolNames = new Map<string, Set<string>>();
  /** Tracks which MCP server owns each registered Pi tool name. */
  private readonly toolOwners = new Map<string, string>();
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
  /** Monotonic per-server generation counter to discard out-of-order refreshTools responses. */
  private readonly refreshGenerations = new Map<string, number>();
  /** Per-server request timeout overrides resolved during refreshTools. */
  private readonly serverTimeouts = new Map<string, number>();
  private onAuthError?: ToolAuthErrorHandler | undefined;

  constructor(settings: Settings, pi: PiExtensionAPI) {
    this.settings = settings;
    this.pi = pi;
  }

  /** Register callback invoked when a mid-session tools/list or tools/call fails with 401/403. */
  setAuthErrorCallback(cb: ToolAuthErrorHandler): void {
    this.onAuthError = cb;
  }

  /** Update bridge settings when session config is reloaded on session_start. */
  updateSettings(settings: Settings): void {
    const prevDefaultTimeoutMs = this.settings.requestTimeoutMs;
    this.settings = settings;
    for (const [serverName, timeoutMs] of this.serverTimeouts.entries()) {
      if (timeoutMs === prevDefaultTimeoutMs) {
        this.serverTimeouts.delete(serverName);
      }
    }
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
    this._reconcileTools(serverName, tools, client);
  }

  /** Report discovery separately from the tools currently exposed by Pi. */
  getToolActivity(serverName: string): { discovered: number; active: number } {
    const names = this.serverToolNames.get(serverName) ?? new Set<string>();
    const active = new Set(this.pi.getActiveTools());
    return { discovered: names.size, active: [...names].filter((name) => active.has(name)).length };
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
    // WHY: stopping the server turns every tool off, so what each one "left in" belongs to a
    // connection that no longer exists; a fresh connect rediscovers the state from scratch.
    this.droppedToolState.delete(serverName);
    this.rawToolNames.delete(serverName);
    this._deactivateServerTools(serverName);
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
    this.droppedToolState.delete(serverName);
    this.rawToolNames.delete(serverName);
    this._deactivateServerTools(serverName);
    deleteServerOwnedTools(serverName, this.serverToolNames, this.toolOwners);
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

  /**
   * Register the freshly discovered tools, release ownership of any Pi names the
   * server no longer uses, and reconcile Pi's active tool set.
   */
  private _reconcileTools(serverName: string, tools: McpToolDefinition[], client: Client): void {
    const registeredForServer = this.serverToolNames.get(serverName) ?? new Set<string>();
    const ownedPreviousNames = filterOwnedTools(serverName, registeredForServer, this.toolOwners);
    // WHY: Copy before calling `this._registerTool` — Pi's `registerTool()` runs
    // `_refreshToolRegistry()`, which auto-activates newly registered tool names and
    // `--tools` allowlist matches while the registration loop is still running.
    const activeBefore = [...this.pi.getActiveTools()];
    const previousStateByRawName = this.activeServers.has(serverName)
      ? snapshotActiveStateByRawName(
          ownedPreviousNames,
          this.rawToolNames.get(serverName),
          new Set(activeBefore),
        )
      : undefined;

    const batch = planServerToolBatch({
      prefix: this.settings.toolPrefix,
      serverName,
      tools,
      toolOwners: this.toolOwners,
      ownedPreviousNames,
    });
    for (const { piName, tool } of batch.plannedTools) {
      this.toolOwners.set(piName, serverName);
      // Always re-register — on reconnect the client reference changes and
      // Pi's registerTool overwrites by name, so this is idempotent.
      this._registerTool(piName, serverName, tool, client);
    }
    for (const existingName of batch.withdrawnToolNames) {
      this.toolOwners.delete(existingName);
    }

    // WHY: `pi.setActiveTools` is shared with every other extension and the user, so an already
    // connected server's tool set may have been narrowed on purpose. A live `tools/list_changed`
    // therefore preserves each raw tool's active/inactive state (including across collision
    // re-settlement and drop/re-advertisement), while a first connect or a reconnect after
    // `deactivateServer` activates the whole discovered set (#214).
    const desiredActive = previousStateByRawName
      ? this._applyLiveRefreshState(serverName, batch.currentRawNames, previousStateByRawName)
      : batch.currentToolNames;

    this.serverToolNames.set(serverName, batch.currentToolNames);
    this.rawToolNames.set(serverName, batch.currentRawNames);
    this.activeServers.add(serverName);
    this._reconcileActiveTools(ownedPreviousNames, desiredActive, activeBefore);
  }

  private _applyLiveRefreshState(
    serverName: string,
    currentRawNames: ReadonlyMap<string, string>,
    previousStateByRawName: ReadonlyMap<string, boolean>,
  ): Set<string> {
    const liveState = reconcileLiveRefreshState({
      currentRawNames,
      previousStateByRawName,
      previousDroppedState: this.droppedToolState.get(serverName),
    });
    if (liveState.droppedState) {
      this.droppedToolState.set(serverName, liveState.droppedState);
    } else {
      this.droppedToolState.delete(serverName);
    }
    return liveState.desiredActive;
  }

  private _registerTool(
    piName: string,
    serverName: string,
    tool: McpToolDefinition,
    client: Client,
  ): void {
    this.pi.registerTool(
      createPiToolDefinition({
        piName,
        serverName,
        tool,
        client,
        getTimeoutMs: () => this.serverTimeouts.get(serverName) ?? this.settings.requestTimeoutMs,
        // WHY: read the handler through `this` at call time — src/index.ts installs it after the
        // bridge is constructed, and it is the caller for every server, so it takes the name.
        onAuthError: (srv, err) => this.onAuthError?.(srv, err),
      }),
    );
  }

  private _reconcileActiveTools(
    ownedPreviousNames: ReadonlySet<string>,
    desiredActive: ReadonlySet<string>,
    activeBefore: readonly string[],
  ): void {
    const nextActive = planActiveToolReconciliation({
      ownedPreviousNames,
      desiredActive,
      activeBefore,
      currentActive: this.pi.getActiveTools(),
      isOwned: (name) => this.toolOwners.has(name),
    });
    if (nextActive === undefined) return;
    this.pi.setActiveTools(nextActive);
  }

  private _deactivateServerTools(serverName: string): void {
    const serverTools = this.serverToolNames.get(serverName);
    if (!serverTools || serverTools.size === 0) return;

    const ownedByServer = filterOwnedTools(serverName, serverTools, this.toolOwners);
    if (ownedByServer.size === 0) return;

    this._reconcileActiveTools(ownedByServer, new Set(), this.pi.getActiveTools());
  }
}
