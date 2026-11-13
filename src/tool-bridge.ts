/**
 * Tool bridge for pi-mcp.
 *
 * Converts MCP tools to Pi tools and manages their lifecycle:
 *   - Paginated tools/list (cursor loop per spec)
 *   - JSON Schema → TypeBox conversion (common types + Type.Any() fallback)
 *   - Tool name sanitization (Pi-compatible identifiers)
 *   - Tool annotations → description hints + structured Pi `annotations`
 *   - AbortSignal → SDK's built-in cancellation (notifications/cancelled)
 *   - notifications/progress → sanitized, redacted live tool updates + inactivity timeout reset
 *   - Protocol error vs tool execution error distinction
 *   - Activate/deactivate pattern (register once, toggle on server state change)
 *   - Images and embedded image resources → ImageContent; resource links → read hints
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, type Progress } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { McpError, AuthCancelledError } from "./errors.js";
import { redactSecrets } from "./secret-redaction.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import type { Settings } from "./config.js";
import { isCancellationError, isOAuthUnauthorizedError, isSdkTimeoutError } from "./connect-policy.js";
import { convertJsonSchemaToTypebox } from "./schema-convert.js";
import { listAllTools, type McpToolDefinition } from "./tool-discovery.js";
import {
  buildToolAnnotations,
  buildToolCallContent,
  buildToolDescription,
  toolErrorText,
  type ToolCallOutcome,
  type ToolCallResponse,
} from "./tool-content.js";
import {
  orderToolsForNameAssignment,
  resolveUniqueToolName,
} from "./tool-names.js";
import {
  orderOwnedEntries,
  orderPayloadToolEntries,
  sameToolList,
} from "./tool-order.js";
import {
  resolveToolExposure,
  type McpExposure,
  type ToolExposureConfig,
} from "./tool-exposure.js";

export { buildToolName } from "./tool-names.js";
export { convertMcpContent } from "./tool-content.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Subset of Pi's ExtensionAPI used by the bridge. */
export type PiExtensionAPI = Pick<ExtensionAPI, "registerTool" | "getActiveTools" | "setActiveTools">;

export type ToolRefreshOptions = {
  requestTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Server-level tool exposure (Pi 1.3.0 `exposure`). Default: `direct`. */
  exposure?: McpExposure | undefined;
  /** Per-tool exposure overrides, keyed by the raw MCP tool name (`tools/list` name). */
  toolExposure?: Readonly<Record<string, McpExposure>> | undefined;
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

// ─── Tool Call Execution ──────────────────────────────────────────────────────

/** Pi's partial-result callback — the `onUpdate` argument of a tool's `execute`. */
export type ToolUpdateCallback = (update: ToolCallOutcome) => void;

/** Per-call streaming and cancellation options for one `tools/call`. */
interface ToolCallOptions {
  signal: AbortSignal | undefined;
  onUpdate: ToolUpdateCallback | undefined;
}

/** Character budget for one progress line; Pi renders the latest line while the tool runs. */
const PROGRESS_MESSAGE_MAX_LENGTH = 200;

/**
 * Render one MCP `notifications/progress` payload as a single Pi-visible line.
 *
 * `message` is server-controlled and lands in Pi's UI stream, so it is sanitized (ANSI and
 * control sequences stripped, length bounded) and stripped of token-like substrings first.
 * A server that sends no usable text gets a numeric `Progress 3/10` line instead.
 *
 * WHY: sanitize before redacting, as `sanitizeLogText` does — the sanitizer deletes escape
 * sequences, and an escape *inside* a credential (`\u001b[1mtoken\u001b[0m=sk-…`) hides the
 * `key=value` shape from `redactSecrets`, which would then pass the token through verbatim.
 */
export function formatProgressText(progress: Progress): string {
  const rawMessage = typeof progress.message === "string" ? progress.message : "";
  // WHY: decide usability on the full text (`maxLength` = its own length disables truncation) and
  // trim surrounding whitespace first. `sanitizeTerminalText` appends `…` when it truncates and
  // turns trailing newlines into spaces, so untrimmed padding would either defeat the fallback,
  // consume the 200-char budget into a blank `   …` row, or split dedupe across `msg` vs `msg\n`.
  const message = sanitizeTerminalText(rawMessage, { maxLength: rawMessage.length }).trim();
  if (message.length > 0) {
    // WHY: bound after redaction — a `[REDACTED]` mask is longer than the value it replaces, so
    // capping first would let the emitted line grow past the budget (or slice a token before the
    // redactor can recognise it).
    return sanitizeTerminalText(redactSecrets(message), {
      maxLength: PROGRESS_MESSAGE_MAX_LENGTH,
    });
  }
  const current = Number.isFinite(progress.progress) ? String(progress.progress) : "?";
  const total = Number.isFinite(progress.total) ? `/${progress.total}` : "";
  return `Progress ${current}${total}`;
}

/**
 * Build the SDK `onprogress` handler for one `tools/call`.
 *
 * WHY: the handler is installed even when Pi passes no `onUpdate` callback. The SDK attaches
 * `_meta.progressToken` only when `onprogress` is set, and the timer reset that keeps a long,
 * actively-reporting tool alive (`resetTimeoutOnProgress`) hangs off that token (#254).
 *
 * Consecutive identical lines are dropped: some servers repeat one message on every tick, and
 * each emission re-renders Pi's in-progress tool row.
 */
function createProgressReporter(
  onUpdate: ToolUpdateCallback | undefined,
): (progress: Progress) => void {
  let lastText: string | undefined;
  return (progress: Progress): void => {
    if (!onUpdate) return;
    const text = formatProgressText(progress);
    if (text === lastText) return;
    lastText = text;
    onUpdate({ content: [{ type: "text", text }], details: {} });
  };
}

/** Call tools/call through the typed helper when present, else a raw JSON-RPC request. */
function callToolWithClient(
  client: Client,
  toolName: string,
  params: unknown,
  timeoutMs: number,
  options: ToolCallOptions,
): Promise<ToolCallResponse> {
  const requestOptions = {
    timeout: timeoutMs,
    // WHY: without these two the SDK never attaches a progress token, so it drops the server's
    // `notifications/progress` as an unknown token and keeps the original inactivity deadline —
    // a tool that reports progress every few seconds was still killed at `requestTimeoutMs` (#254).
    resetTimeoutOnProgress: true,
    onprogress: createProgressReporter(options.onUpdate),
    // Pass AbortSignal to SDK — it will automatically send
    // notifications/cancelled when the signal fires
    ...(options.signal ? { signal: options.signal } : {}),
  };
  if (typeof client.callTool === "function") {
    return client.callTool(
      { name: toolName, arguments: params as Record<string, unknown> },
      CallToolResultSchema,
      requestOptions,
    );
  }
  return client.request(
    {
      method: "tools/call",
      params: { name: toolName, arguments: params },
    },
    CallToolResultSchema,
    requestOptions,
  );
}

/** Normalize `refreshTools`' overloaded argument shapes (callback vs. options object). */
function normalizeRefreshArgs(
  isCurrentOrOptions?: (() => boolean) | ToolRefreshOptions,
  maybeOptions?: ToolRefreshOptions,
): { isCurrent: () => boolean; options: ToolRefreshOptions | undefined } {
  const isCurrent = typeof isCurrentOrOptions === "function" ? isCurrentOrOptions : () => true;
  const options = typeof isCurrentOrOptions === "object" ? isCurrentOrOptions : maybeOptions;
  return { isCurrent, options };
}

// ─── Tool Listing ─────────────────────────────────────────────────────────────

export { listAllTools, type McpToolDefinition } from "./tool-discovery.js";

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
  private onAuthError?: ((serverName: string, error: unknown) => Promise<void> | void) | undefined;

  constructor(settings: Settings, pi: PiExtensionAPI) {
    this.settings = settings;
    this.pi = pi;
  }

  /** Register callback invoked when a mid-session tools/list or tools/call fails with 401/403. */
  setAuthErrorCallback(cb: (serverName: string, error: unknown) => Promise<void> | void): void {
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

    const tools = await this._fetchToolsForServer(
      serverName,
      client,
      effectiveTimeoutMs,
      options?.signal,
    );

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
    this.directToolNames.delete(serverName);
    this._deactivateServerTools(serverName);
    const existing = this.serverToolNames.get(serverName);
    if (existing) {
      for (const toolName of existing) {
        if (this.toolOwners.get(toolName) === serverName) {
          this.toolOwners.delete(toolName);
        }
      }
      this.serverToolNames.delete(serverName);
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

  /**
   * Discover a server's tools, normalizing aborts into {@link AuthCancelledError},
   * SDK request timeouts into `McpError("timeout")`, and every other failure into
   * `McpError("protocol")`.
   */
  private async _fetchToolsForServer(
    serverName: string,
    client: Client,
    effectiveTimeoutMs: number,
    effectiveSignal: AbortSignal | undefined,
  ): Promise<McpToolDefinition[]> {
    try {
      return await listAllTools(client, effectiveTimeoutMs, effectiveSignal, serverName);
    } catch (err) {
      if (isCancellationError(err, effectiveSignal)) {
        throw err instanceof AuthCancelledError ? err : new AuthCancelledError(serverName);
      }
      if (isOAuthUnauthorizedError(err)) {
        await this.onAuthError?.(serverName, err);
      }
      // WHY: an SDK request timeout is retryable — `classifyConnectFailure` fast-fails on
      // "protocol", so mislabelling it would skip `maxRetries` and report a discovery
      // timeout as a protocol violation (#209).
      const code = isSdkTimeoutError(err) ? "timeout" : "protocol";
      throw new McpError(
        `Failed to list tools from ${serverName}: ${err instanceof Error ? err.message : String(err)}`,
        serverName,
        code,
        err,
      );
    }
  }

  /**
   * Register the freshly discovered tools, release ownership of any Pi names the
   * server no longer uses, and reconcile Pi's active tool set.
   */
  private _reconcileTools(
    serverName: string,
    tools: McpToolDefinition[],
    client: Client,
    exposure: ToolExposureConfig | undefined,
  ): void {
    const registeredForServer = this.serverToolNames.get(serverName) ?? new Set<string>();
    const ownedPreviousNames = this._ownedTools(serverName, registeredForServer);
    // WHY: Copy before calling `this._registerTool` — Pi's `registerTool()` runs
    // `_refreshToolRegistry()`, which auto-activates newly registered tool names and
    // `--tools` allowlist matches while the registration loop is still running.
    const activeBefore = [...this.pi.getActiveTools()];
    const isLiveRefresh = this.activeServers.has(serverName);
    const previousStateByRawName = isLiveRefresh
      ? this._snapshotActiveStateByRawName(serverName, ownedPreviousNames, new Set(activeBefore))
      : undefined;

    const currentToolNames = new Set<string>();
    const currentRawNames = new Map<string, string>();
    const directToolNames = new Set<string>();
    // WHY: `tools/list` order carries no meaning (a server may reorder it freely), so colliding
    // names are assigned over a deterministic order of the tool set — otherwise the exact-match
    // tool could lose the unhashed name to a lossy one and a later refresh would swap which MCP
    // tool that name executes (#213).
    for (const tool of orderToolsForNameAssignment(this.settings.toolPrefix, serverName, tools)) {
      const piName = resolveUniqueToolName({
        prefix: this.settings.toolPrefix,
        serverName,
        rawToolName: tool.name,
        seenInBatch: currentToolNames,
        toolOwners: this.toolOwners,
      });
      const toolExposure = resolveToolExposure(exposure, tool.name);
      currentToolNames.add(piName);
      currentRawNames.set(piName, tool.name);
      this.toolOwners.set(piName, serverName);
      if (toolExposure === "direct") {
        directToolNames.add(piName);
      }
      // Always re-register — on reconnect the client reference changes and
      // Pi's registerTool overwrites by name, so this is idempotent.
      this._registerTool(piName, serverName, tool, client, toolExposure);
    }

    for (const existingName of ownedPreviousNames) {
      if (!currentToolNames.has(existingName)) {
        this.toolOwners.delete(existingName);
      }
    }

    // WHY: `pi.setActiveTools` is shared with every other extension and the user, so an already
    // connected server's tool set may have been narrowed on purpose. A live `tools/list_changed`
    // therefore preserves each raw tool's active/inactive state (including across collision
    // re-settlement and drop/re-advertisement), while a first connect or a reconnect after
    // `deactivateServer` activates the configured `direct` tools (#214, #257).
    const desiredActive = previousStateByRawName
      ? this._resolveLiveDesiredActive(
          serverName,
          currentRawNames,
          previousStateByRawName,
          directToolNames,
        )
      : directToolNames;

    this.serverToolNames.set(serverName, currentToolNames);
    this.rawToolNames.set(serverName, currentRawNames);
    this.directToolNames.set(serverName, directToolNames);
    this.activeServers.add(serverName);
    this._reconcileActiveTools(ownedPreviousNames, desiredActive, activeBefore);
  }

  private _registerTool(
    piName: string,
    serverName: string,
    tool: McpToolDefinition,
    client: Client,
    exposure: McpExposure,
  ): void {
    const annotations = tool.annotations;
    const description = buildToolDescription(tool, annotations);
    const toolAnnotations = buildToolAnnotations(annotations);
    const runTool = (
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: ToolUpdateCallback | undefined,
    ) => this._executeToolCall(serverName, tool.name, client, params, { signal, onUpdate });
    // WHY: `execute` runs with `this` bound to the registered-tool literal rather than the
    // bridge, so the rethrow helper is reached through a captured closure.
    const rethrowToolCallError = (err: unknown): Promise<never> =>
      this._rethrowToolCallError(serverName, err);

    this.pi.registerTool({
      name: piName,
      label: annotations?.title ?? tool.name,
      description,
      promptSnippet: description.slice(0, 120),
      parameters: convertJsonSchemaToTypebox(tool.inputSchema),
      exposure,
      // WHY: Pi already declines to activate `deferred` / `codemode` / `hidden` tools on
      // registration, but `defaultActive: false` keeps that independent of Pi's default and
      // of a `--tools` allowlist entry, so a hidden tool can never be declared to the model.
      ...(exposure === "direct" ? {} : { defaultActive: false }),
      ...(toolAnnotations ? { annotations: toolAnnotations } : {}),

      async execute(_toolCallId, params, signal, onUpdate, _ctx) {
        try {
          return await runTool(params, signal, onUpdate);
        } catch (err) {
          return await rethrowToolCallError(err);
        }
      },
    });
  }

  /**
   * Normalize a `tools/call` failure into the `McpError` callers see, after notifying the
   * OAuth handler when the failure means the server needs authorization.
   */
  private async _rethrowToolCallError(serverName: string, err: unknown): Promise<never> {
    if (err instanceof McpError) throw err;
    if (isOAuthUnauthorizedError(err)) {
      // WHY: read the handler through `this` at call time — src/index.ts installs it after the
      // bridge is constructed, and it is the caller for every server, so it takes the name.
      await this.onAuthError?.(serverName, err);
    }
    // Protocol-level errors (JSON-RPC error response, malformed payload) keep
    // "protocol"; an SDK request timeout keeps its own code so callers can tell
    // "the server answered badly" from "the server did not answer in time" (#209).
    throw new McpError(
      err instanceof Error ? err.message : String(err),
      serverName,
      isSdkTimeoutError(err) ? "timeout" : "protocol",
      err,
    );
  }

  /**
   * Run one `tools/call`: dispatch through the SDK client, convert the result
   * into Pi content blocks, and surface `isError` as `McpError(..., "tool")`.
   */
  private async _executeToolCall(
    serverName: string,
    toolName: string,
    client: Client,
    params: unknown,
    options: ToolCallOptions,
  ): Promise<ToolCallOutcome> {
    if (options.signal?.aborted) {
      throw new McpError("Tool execution cancelled", serverName, "protocol");
    }

    let result: ToolCallResponse;
    try {
      result = await callToolWithClient(
        client,
        toolName,
        params,
        this.serverTimeouts.get(serverName) ?? this.settings.requestTimeoutMs,
        options,
      );
    } catch (err) {
      // WHY: an abort mid-call is rejected by the SDK with its RequestTimeout error, so the
      // cancellation has to be recognised here — otherwise a caller cancellation is reported
      // as a server timeout, and blamed on the server (#209).
      if (isCancellationError(err, options.signal)) {
        throw new McpError("Tool execution cancelled", serverName, "protocol");
      }
      throw err;
    }
    const content = buildToolCallContent(result);

    // Tool execution errors (isError: true) — distinct from protocol errors
    if (result.isError) {
      throw new McpError(toolErrorText(content) || "Tool reported an error", serverName, "tool");
    }

    return { content, details: {} };
  }

  /** Filter a set of Pi tool names to those still owned by `serverName`. */
  private _ownedTools(serverName: string, toolNames: ReadonlySet<string>): Set<string> {
    const owned = new Set<string>();
    for (const toolName of toolNames) {
      const owner = this.toolOwners.get(toolName);
      if (owner === undefined || owner === serverName) {
        owned.add(toolName);
      }
    }
    return owned;
  }

  /**
   * Map each raw MCP tool name from the previous snapshot to whether Pi currently has
   * its assigned tool name active.
   */
  private _snapshotActiveStateByRawName(
    serverName: string,
    ownedPreviousNames: ReadonlySet<string>,
    activeBefore: ReadonlySet<string>,
  ): Map<string, boolean> {
    const rawNamesBefore = this.rawToolNames.get(serverName);
    const stateByRawName = new Map<string, boolean>();
    for (const piName of ownedPreviousNames) {
      const rawName = rawNamesBefore?.get(piName) ?? piName;
      stateByRawName.set(rawName, activeBefore.has(piName));
    }
    return stateByRawName;
  }

  /**
   * Compute which Pi tool names in `currentRawNames` should be active after a live refresh,
   * and update the server's dropped-tool memory.
   *
   * A tool present in the previous snapshot keeps the active/inactive state Pi currently
   * reports for it (even if a colliding sibling shifted its Pi name). A tool absent from the
   * previous snapshot restores the state it left in when dropped on this connection, and a
   * genuinely new tool activates only when its exposure is `direct`.
   */
  private _resolveLiveDesiredActive(
    serverName: string,
    currentRawNames: ReadonlyMap<string, string>,
    previousStateByRawName: ReadonlyMap<string, boolean>,
    directToolNames: ReadonlySet<string>,
  ): Set<string> {
    const dropped = this.droppedToolState.get(serverName);
    const desiredActive = new Set<string>();
    const seenRawNames = new Set<string>();
    for (const [piName, rawName] of currentRawNames) {
      seenRawNames.add(rawName);
      const shouldActivate =
        previousStateByRawName.get(rawName) ?? dropped?.get(rawName) ?? directToolNames.has(piName);
      if (shouldActivate) {
        desiredActive.add(piName);
      }
    }
    this._updateDroppedTools(serverName, previousStateByRawName, seenRawNames);
    return desiredActive;
  }

  /**
   * Record the active state of tools dropped in this live refresh and forget tools that are
   * currently advertised.
   */
  private _updateDroppedTools(
    serverName: string,
    previousStateByRawName: ReadonlyMap<string, boolean>,
    currentRawNames: ReadonlySet<string>,
  ): void {
    const dropped = this.droppedToolState.get(serverName) ?? new Map<string, boolean>();
    for (const [rawName, wasActive] of previousStateByRawName) {
      if (!currentRawNames.has(rawName)) {
        dropped.set(rawName, wasActive);
      }
    }
    for (const rawName of currentRawNames) {
      dropped.delete(rawName);
    }
    if (dropped.size > 0) {
      this.droppedToolState.set(serverName, dropped);
    } else {
      this.droppedToolState.delete(serverName);
    }
  }

  /**
   * Reconcile a server's active tools in Pi in one write: drop any previously owned Pi tool
   * names that are not in `desiredActive`, append any `desiredActive` names not yet active,
   * order the result, and skip `pi.setActiveTools` altogether when the active list already
   * holds exactly that set in that order.
   */
  private _reconcileActiveTools(
    ownedPreviousNames: ReadonlySet<string>,
    desiredActive: ReadonlySet<string>,
    activeBefore: readonly string[],
  ): void {
    const activeSet = new Set(activeBefore);
    const remaining = activeBefore.filter(
      (name) => !ownedPreviousNames.has(name) || desiredActive.has(name),
    );
    const newlyActive = [...desiredActive].filter((name) => !activeSet.has(name));
    const nextActive = this._orderActiveTools(new Set([...remaining, ...newlyActive]));
    // WHY: `pi.registerTool()` inside the loop may have auto-activated a newly registered hashed
    // Pi name or a `--tools` allowlist entry, and a resumed session restores the order it ended
    // with — so compare against a fresh read and write whenever the set *or* the order differs.
    if (sameToolList(this.pi.getActiveTools(), nextActive)) return;

    this.pi.setActiveTools(nextActive);
  }

  /**
   * Order the active set so this bridge's tools are a pure function of the tool set: they are
   * sorted by Pi name among the positions they already occupy, while every entry another
   * extension owns keeps its position.
   *
   * WHY: a server's tools are registered as its connection completes, and `desiredActive`
   * follows `tools/list` order, which the MCP spec does not define. Without a fixed order the
   * active list — and with it the system prompt's tool section and the tools declared to the
   * provider — depends on eager-connect timing, so a server-side prefix cache keyed on the
   * prompt head misses on every session start or resume (#278).
   */
  private _orderActiveTools(active: ReadonlySet<string>): string[] {
    const names = [...active];
    const ordered = orderOwnedEntries(names, (name) => name, (name) => this.toolOwners.has(name));
    return ordered ?? names;
  }

  private _deactivateServerTools(serverName: string): void {
    const serverTools = this.serverToolNames.get(serverName);
    if (!serverTools || serverTools.size === 0) return;

    const ownedByServer = this._ownedTools(serverName, serverTools);
    if (ownedByServer.size === 0) return;

    this._reconcileActiveTools(ownedByServer, new Set(), this.pi.getActiveTools());
  }
}
