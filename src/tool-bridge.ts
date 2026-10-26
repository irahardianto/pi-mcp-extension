/**
 * Tool bridge for pi-mcp.
 *
 * Converts MCP tools to Pi tools and manages their lifecycle:
 *   - Paginated tools/list (cursor loop per spec)
 *   - JSON Schema → TypeBox conversion (common types + Type.Any() fallback)
 *   - Tool name sanitization (Pi-compatible identifiers)
 *   - Tool annotations → description hints
 *   - AbortSignal → SDK's built-in cancellation (notifications/cancelled)
 *   - Protocol error vs tool execution error distinction
 *   - Activate/deactivate pattern (register once, toggle on server state change)
 *   - Image content → ImageContent passthrough; audio/resource → text description
 */

import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { McpError, AuthCancelledError } from "./errors.js";
import type { Settings } from "./config.js";
import { isOAuthUnauthorizedError } from "./server-manager.js";
import { convertJsonSchemaToTypebox } from "./schema-convert.js";
import { listAllTools, type McpToolDefinition } from "./tool-discovery.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Subset of Pi's ExtensionAPI used by the bridge. */
export type PiExtensionAPI = Pick<ExtensionAPI, "registerTool" | "getActiveTools" | "setActiveTools">;

export type ToolRefreshOptions = {
  requestTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
};

// ─── Tool Name Sanitization ───────────────────────────────────────────────────

const MAX_TOOL_NAME_LEN = 64;

/**
 * Build a Pi-compatible tool name.
 * Format: <prefix>_<server>_<tool>
 * Rules: [a-zA-Z0-9_], max 64 chars.
 * If truncation or collision disambiguation (`forceHash`) is needed, appends an
 * 8-char SHA-256 hex digest computed over the raw unsanitized input components.
 */
export function buildToolName(
  prefix: string,
  serverName: string,
  toolName: string,
  forceHash = false,
): string {
  // WHY: Hash the raw unsanitized components separated by NUL bytes so distinct
  // server/tool pairs that sanitize to the same "_" sequence (e.g. "my-tool" vs
  // "my_tool", or server "a_b" + tool "c" vs server "a" + tool "b_c") never collide.
  const hash = createHash("sha256")
    .update(`${prefix}\0${serverName}\0${toolName}`)
    .digest("hex")
    .slice(0, 8);
  const raw = `${prefix}_${serverName}_${toolName}`;
  const safe = raw.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!forceHash && safe.length <= MAX_TOOL_NAME_LEN) {
    return safe;
  }
  return `${safe.slice(0, MAX_TOOL_NAME_LEN - 9)}_${hash}`;
}

// ─── Content Conversion ───────────────────────────────────────────────────────

type PiTextContent = { type: "text"; text: string };
type PiImageContent = { type: "image"; data: string; mimeType: string };

function convertResourceContent(obj: Record<string, unknown>): PiTextContent {
  const r = obj["resource"] as Record<string, unknown> | undefined;
  // WHY: Check `typeof r?.["text"] === "string"` rather than truthiness so
  // empty text resources (`text: ""`) are preserved as `""` instead of `[Resource: uri]`.
  if (typeof r?.["text"] === "string") return { type: "text", text: r["text"] };
  if (r?.["blob"]) return { type: "text", text: `[Resource blob: ${String(r["uri"])}]` };
  return { type: "text", text: `[Resource: ${String(r?.["uri"] ?? "unknown")}]` };
}

function convertNonTextContent(obj: Record<string, unknown>): PiImageContent | PiTextContent | undefined {
  if (obj["type"] === "image") {
    return {
      type: "image",
      data: String(obj["data"] ?? ""),
      mimeType: String(obj["mimeType"] ?? "image/png"),
    };
  }
  if (obj["type"] === "audio") {
    return {
      type: "text",
      text: `[Audio: ${String(obj["mimeType"] ?? "unknown")}, base64 encoded]`,
    };
  }
  if (obj["type"] === "resource") {
    return convertResourceContent(obj);
  }
  return undefined;
}

function convertMcpContentItem(item: unknown): PiTextContent | PiImageContent {
  if (!item || typeof item !== "object") {
    return { type: "text", text: String(item) };
  }
  const obj = item as Record<string, unknown>;
  const nonText = convertNonTextContent(obj);
  if (nonText) return nonText;
  if (obj["type"] === "text") {
    return { type: "text", text: String(obj["text"] ?? "") };
  }
  return { type: "text", text: JSON.stringify(item) };
}

export function convertMcpContent(items: unknown[]): (PiTextContent | PiImageContent)[] {
  return items.map(convertMcpContentItem);
}

// ─── Tool Call Execution ──────────────────────────────────────────────────────

type PiContent = PiTextContent | PiImageContent;

/** Tool call result shape Pi expects from `execute`. */
interface ToolCallOutcome {
  content: PiContent[];
  details: Record<string, never>;
}

/**
 * The subset of an SDK `tools/call` response the bridge consumes.
 * Legacy servers answer with `toolResult` instead of `content`, so every field
 * stays optional and unvalidated here — `convertMcpContent` handles the blocks.
 * The index signature keeps the SDK's compatibility result assignable.
 */
interface ToolCallResponse {
  [key: string]: unknown;
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
}

/** Append the tool's annotation hints to its description so the LLM sees them. */
function buildToolDescription(
  tool: McpToolDefinition,
  annotations: McpToolDefinition["annotations"],
): string {
  const description = tool.description ?? `MCP tool: ${tool.name}`;
  if (!annotations) return description;
  const hints: string[] = [];
  if (annotations.readOnlyHint) hints.push("read-only");
  if (annotations.destructiveHint) hints.push("⚠️ destructive");
  if (annotations.idempotentHint) hints.push("idempotent");
  if (annotations.openWorldHint) hints.push("may have side effects");
  return hints.length > 0 ? `${description} [${hints.join(", ")}]` : description;
}

/** Call tools/call through the typed helper when present, else a raw JSON-RPC request. */
function callToolWithClient(
  client: Client,
  toolName: string,
  params: unknown,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ToolCallResponse> {
  const requestOptions = {
    timeout: timeoutMs,
    // Pass AbortSignal to SDK — it will automatically send
    // notifications/cancelled when the signal fires
    ...(signal ? { signal } : {}),
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

/**
 * Convert a callTool result into Pi content blocks, falling back to
 * `structuredContent` when the server returned no content blocks.
 */
function buildToolCallContent(result: ToolCallResponse): PiContent[] {
  const content = convertMcpContent((result.content ?? []) as Array<Record<string, unknown>>);
  if (content.length > 0 || result.structuredContent === undefined) return content;
  const structured = result.structuredContent;
  content.push({
    type: "text",
    text: typeof structured === "string" ? structured : JSON.stringify(structured, null, 2),
  });
  return content;
}

/** Text blocks of a failed tool call, joined into the McpError message. */
function toolErrorText(content: readonly PiContent[]): string {
  return content
    .filter((c): c is PiTextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
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
    this._reconcileTools(serverName, tools, client);
  }

  /** Report discovery separately from the tools currently exposed by Pi. */
  getToolActivity(serverName: string): { discovered: number; active: number } {
    const names = this.serverToolNames.get(serverName) ?? new Set<string>();
    const active = new Set(this.pi.getActiveTools());
    return { discovered: names.size, active: [...names].filter((name) => active.has(name)).length };
  }

  /** Deactivate all Pi tools belonging to a server (called on disconnect). */
  deactivateServer(serverName: string): void {
    this._bumpRefreshGeneration(serverName);
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

  /** Re-activate all Pi tools belonging to a server (called on reconnect). */
  activateServer(serverName: string): void {
    this._activateServerTools(serverName);
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
   * Discover a server's tools, normalizing aborts into {@link AuthCancelledError}
   * and every other failure into an `McpError("protocol")`.
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
      if (
        err instanceof AuthCancelledError ||
        effectiveSignal?.aborted ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        throw err instanceof AuthCancelledError ? err : new AuthCancelledError(serverName);
      }
      if (isOAuthUnauthorizedError(err)) {
        await this.onAuthError?.(serverName, err);
      }
      throw new McpError(
        `Failed to list tools from ${serverName}: ${err instanceof Error ? err.message : String(err)}`,
        serverName,
        "protocol",
        err,
      );
    }
  }

  /**
   * Register the freshly discovered tools, deactivate the ones the server
   * dropped, then activate the server's current set.
   */
  private _reconcileTools(serverName: string, tools: McpToolDefinition[], client: Client): void {
    const registeredForServer = this.serverToolNames.get(serverName) ?? new Set<string>();

    // Build the set of currently valid Pi tool names for this server
    const currentToolNames = new Set<string>();
    for (const tool of tools) {
      const piName = this._resolveUniqueToolName(serverName, tool.name, currentToolNames);
      currentToolNames.add(piName);
      this.toolOwners.set(piName, serverName);
      // Always re-register — on reconnect the client reference changes and
      // Pi's registerTool overwrites by name, so this is idempotent.
      this._registerTool(piName, serverName, tool, client);
    }

    // Deactivate tools that were removed from the server (no longer in tools/list)
    for (const existingName of registeredForServer) {
      if (currentToolNames.has(existingName)) continue;
      this._deactivateServerTool(serverName, existingName);
      if (this.toolOwners.get(existingName) === serverName) {
        this.toolOwners.delete(existingName);
      }
    }

    this.serverToolNames.set(serverName, currentToolNames);
    this._activateServerTools(serverName);
  }

  private _isToolNameTaken(name: string, serverName: string, seenInBatch: ReadonlySet<string>): boolean {
    if (seenInBatch.has(name)) return true;
    const owner = this.toolOwners.get(name);
    return owner !== undefined && owner !== serverName;
  }

  private _findSuffixedToolName(
    hashedCandidate: string,
    serverName: string,
    seenInBatch: ReadonlySet<string>,
  ): string {
    let suffix = 2;
    while (true) {
      const tag = `_${suffix}`;
      const candidate = `${hashedCandidate.slice(0, MAX_TOOL_NAME_LEN - tag.length)}${tag}`;
      if (!this._isToolNameTaken(candidate, serverName, seenInBatch)) {
        return candidate;
      }
      suffix++;
    }
  }

  private _resolveUniqueToolName(
    serverName: string,
    rawToolName: string,
    seenInBatch: ReadonlySet<string>,
  ): string {
    const baseCandidate = buildToolName(this.settings.toolPrefix, serverName, rawToolName, false);
    if (!this._isToolNameTaken(baseCandidate, serverName, seenInBatch)) {
      return baseCandidate;
    }

    const hashedCandidate = buildToolName(this.settings.toolPrefix, serverName, rawToolName, true);
    if (!this._isToolNameTaken(hashedCandidate, serverName, seenInBatch)) {
      return hashedCandidate;
    }

    return this._findSuffixedToolName(hashedCandidate, serverName, seenInBatch);
  }

  private _registerTool(
    piName: string,
    serverName: string,
    tool: McpToolDefinition,
    client: Client,
  ): void {
    const annotations = tool.annotations;
    const description = buildToolDescription(tool, annotations);
    const notifyAuthError = (err: unknown) => this.onAuthError?.(serverName, err);
    const runTool = (params: unknown, signal: AbortSignal | undefined) =>
      this._executeToolCall(serverName, tool.name, client, params, signal);

    this.pi.registerTool({
      name: piName,
      label: annotations?.title ?? tool.name,
      description,
      promptSnippet: description.slice(0, 120),
      parameters: convertJsonSchemaToTypebox(tool.inputSchema),

      async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
        try {
          return await runTool(params, signal);
        } catch (err) {
          if (err instanceof McpError) throw err;
          if (isOAuthUnauthorizedError(err)) {
            await notifyAuthError(err);
          }
          // Protocol-level errors (JSON-RPC error response, timeout, etc.)
          throw new McpError(
            err instanceof Error ? err.message : String(err),
            serverName,
            "protocol",
            err,
          );
        }
      },
    });
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
    signal: AbortSignal | undefined,
  ): Promise<ToolCallOutcome> {
    if (signal?.aborted) {
      throw new McpError("Tool execution cancelled", serverName, "protocol");
    }

    const result = await callToolWithClient(
      client,
      toolName,
      params,
      this.serverTimeouts.get(serverName) ?? this.settings.requestTimeoutMs,
      signal,
    );
    const content = buildToolCallContent(result);

    // Tool execution errors (isError: true) — distinct from protocol errors
    if (result.isError) {
      throw new McpError(toolErrorText(content) || "Tool reported an error", serverName, "tool");
    }

    return { content, details: {} };
  }

  private _activateServerTools(serverName: string): void {
    const serverTools = this.serverToolNames.get(serverName);
    if (!serverTools || serverTools.size === 0) return;

    const currentActive = new Set(this.pi.getActiveTools());
    for (const name of serverTools) currentActive.add(name);
    this.pi.setActiveTools(Array.from(currentActive));
  }

  private _deactivateServerTools(serverName: string): void {
    const serverTools = this.serverToolNames.get(serverName);
    if (!serverTools || serverTools.size === 0) return;

    const ownedByServer = new Set<string>();
    for (const toolName of serverTools) {
      const owner = this.toolOwners.get(toolName);
      if (owner !== undefined && owner !== serverName) continue;
      ownedByServer.add(toolName);
    }
    if (ownedByServer.size === 0) return;

    const currentActive = this.pi.getActiveTools();
    const remaining = currentActive.filter((n) => !ownedByServer.has(n));
    this.pi.setActiveTools(remaining);
  }

  /** Deactivate a single tool by Pi name (used when a tool is removed on list_changed). */
  private _deactivateServerTool(serverName: string, piName: string): void {
    const owner = this.toolOwners.get(piName);
    if (owner !== undefined && owner !== serverName) return;

    const currentActive = this.pi.getActiveTools();
    const remaining = currentActive.filter((n) => n !== piName);
    this.pi.setActiveTools(remaining);
  }
}
