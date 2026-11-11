/**
 * Tool bridge for pi-mcp.
 *
 * Converts MCP tools to Pi tools and manages their lifecycle:
 *   - Paginated tools/list (cursor loop per spec)
 *   - JSON Schema → TypeBox conversion (common types + Type.Any() fallback)
 *   - Tool name sanitization (Pi-compatible identifiers)
 *   - Tool annotations → description hints + structured Pi `annotations`
 *   - AbortSignal → SDK's built-in cancellation (notifications/cancelled)
 *   - Protocol error vs tool execution error distinction
 *   - Activate/deactivate pattern (register once, toggle on server state change)
 *   - Images and embedded image resources → ImageContent; resource links → read hints
 */

import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionAPI, ToolAnnotations } from "@earendil-works/pi-coding-agent";
import { McpError, AuthCancelledError } from "./errors.js";
import type { Settings } from "./config.js";
import { isCancellationError, isOAuthUnauthorizedError, isSdkTimeoutError } from "./connect-policy.js";
import { convertJsonSchemaToTypebox } from "./schema-convert.js";
import { listAllTools, type McpToolDefinition } from "./tool-discovery.js";
import { convertResourceContent } from "./resource-bridge.js";

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

/** True when sanitizing the raw tool name loses nothing (already a valid Pi identifier body). */
function isLosslessToolName(rawToolName: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(rawToolName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedStringField(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string | undefined {
  const nested = record[key];
  if (!isRecord(nested)) return undefined;
  const value = nested[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * Name of a provider tool definition: `{ name }` (Anthropic, Responses, Gemini
 * `functionDeclarations`), `{ function: { name } }` (Chat Completions, Mistral), or
 * `{ toolSpec: { name } }` (Bedrock Converse).
 */
function payloadToolName(definition: unknown): string | undefined {
  if (!isRecord(definition)) return undefined;
  const name = definition["name"];
  if (typeof name === "string") return name;
  return (
    nestedStringField(definition, "function", "name") ??
    nestedStringField(definition, "toolSpec", "name")
  );
}

/**
 * Keep a slot's `cache_control` breakpoint on that slot when another tool definition moves into
 * it: Pi's Anthropic and OpenAI-completions adapters attach `cache_control` to the last tool
 * slot before `before_provider_request` runs, so moving that object earlier would strand later
 * tools outside the cached prefix and diverge from a session that started in sorted order.
 */
function withSlotCacheControl(entry: unknown, slotEntry: unknown): unknown {
  const entryRecord = entry as Record<string, unknown>;
  const slotCache = (slotEntry as { cache_control?: unknown }).cache_control;
  if (entryRecord["cache_control"] === slotCache) return entry;
  if (slotCache === undefined) {
    const { cache_control: _dropped, ...rest } = entryRecord;
    return rest;
  }
  return { ...entryRecord, cache_control: slotCache };
}

/** Order one tool-definition array in place of its owned slots, keeping slot `cache_control`. */
function orderDefinitionList(
  definitions: unknown,
  isOwned: (name: string) => boolean,
): unknown[] | undefined {
  if (!Array.isArray(definitions) || definitions.length === 0) return undefined;
  const ordered = orderOwnedEntries(definitions, payloadToolName, isOwned);
  if (ordered === undefined) return undefined;
  return ordered.map((entry, index) =>
    entry === definitions[index] ? entry : withSlotCacheControl(entry, definitions[index]),
  );
}

/** Order one Gemini `Tool` entry's `functionDeclarations` array when present. */
function orderGoogleToolGroup(
  group: unknown,
  isOwned: (name: string) => boolean,
): unknown {
  if (!isRecord(group)) return group;
  const ordered = orderDefinitionList(group["functionDeclarations"], isOwned);
  return ordered === undefined ? group : { ...group, functionDeclarations: ordered };
}

/** Order Gemini / Vertex `config.tools[].functionDeclarations` without mutating untouched groups. */
function orderGoogleConfigTools(
  config: unknown,
  isOwned: (name: string) => boolean,
): Record<string, unknown> | undefined {
  if (!isRecord(config) || !Array.isArray(config["tools"])) return undefined;
  const tools = config["tools"];
  const nextTools = tools.map((group) => orderGoogleToolGroup(group, isOwned));
  const changed = nextTools.some((group, index) => group !== tools[index]);
  return changed ? { ...config, tools: nextTools } : undefined;
}

/** Order Bedrock Converse `toolConfig.tools` (`{ toolSpec: { name } }`) when present. */
function orderBedrockToolConfig(
  toolConfig: unknown,
  isOwned: (name: string) => boolean,
): Record<string, unknown> | undefined {
  if (!isRecord(toolConfig)) return undefined;
  const ordered = orderDefinitionList(toolConfig["tools"], isOwned);
  return ordered === undefined ? undefined : { ...toolConfig, tools: ordered };
}

/** Order nested provider tool containers: Bedrock `toolConfig.tools` or Google `config.tools`. */
function orderNestedPayloadTools(
  payload: Record<string, unknown>,
  isOwned: (name: string) => boolean,
): Record<string, unknown> | undefined {
  const orderedToolConfig = orderBedrockToolConfig(payload["toolConfig"], isOwned);
  if (orderedToolConfig !== undefined) return { ...payload, toolConfig: orderedToolConfig };

  const orderedGoogleConfig = orderGoogleConfigTools(payload["config"], isOwned);
  return orderedGoogleConfig === undefined ? undefined : { ...payload, config: orderedGoogleConfig };
}

/**
 * Sort the entries `isOwned` selects into name order inside the slots they already occupy, and
 * return `undefined` when the result is identical to `entries`.
 *
 * WHY: this bridge cannot move what it does not own — another extension's tools keep the position
 * they were given, and so does Pi's trailing Anthropic `__pi_deferred_placeholder__`, which Pi
 * requires last — while the bridge's own tools, whose insertion order depends on which server
 * connected first and on `tools/list` order, end up in one deterministic order (#278).
 */
function orderOwnedEntries<T>(
  entries: readonly T[],
  nameOf: (entry: T) => string | undefined,
  isOwned: (name: string) => boolean,
): T[] | undefined {
  const owned: Array<{ slot: number; name: string; entry: T }> = [];
  entries.forEach((entry, slot) => {
    const name = nameOf(entry);
    if (name !== undefined && isOwned(name)) owned.push({ slot, name, entry });
  });
  if (owned.length < 2) return undefined;

  const slots = owned.map((candidate) => candidate.slot);
  owned.sort((left, right) => compareCodePoints(left.name, right.name));
  const ordered = [...entries];
  owned.forEach((candidate, index) => {
    const slot = slots[index];
    if (slot === undefined) return;
    ordered[slot] = candidate.entry;
  });
  const unchanged = ordered.every((entry, index) => entry === entries[index]);
  return unchanged ? undefined : ordered;
}

/** Compare strings by Unicode code point, not by UTF-16 code unit. */
function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, (ch) => ch.codePointAt(0) ?? 0);
  const right = Array.from(b, (ch) => ch.codePointAt(0) ?? 0);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/**
 * Order a server's tools so Pi-name assignment depends only on the tool set and never on
 * the order `tools/list` happened to return (#213): a lossless raw name wins the unhashed
 * `<prefix>_<server>_<tool>` identifier over one that needs character substitution
 * (`my_tool` over `my-tool`), and remaining ties fall back to code-point order of the raw
 * name. Without a total order here, the first response's order decided which colliding
 * tool owned the unhashed name, so a reconnect could silently swap tool targets.
 */
function compareToolsForNameAssignment(a: McpToolDefinition, b: McpToolDefinition): number {
  const aLossless = isLosslessToolName(a.name);
  const bLossless = isLosslessToolName(b.name);
  if (aLossless !== bLossless) return aLossless ? -1 : 1;
  return compareCodePoints(a.name, b.name);
}

/**
 * Order a server's tools for Pi-name assignment. The server's own `tools/list` order is kept —
 * so registration order only moves where it must — except that tools competing for the same
 * unhashed identifier are emitted as one deterministic group in the position of the group's
 * first member. Which tool the server listed first is not part of the MCP contract, so it must
 * not decide who wins that identifier (#213).
 */
function orderToolsForNameAssignment(
  prefix: string,
  serverName: string,
  tools: readonly McpToolDefinition[],
): readonly McpToolDefinition[] {
  const groups = new Map<string, McpToolDefinition[]>();
  for (const tool of tools) {
    const baseName = buildToolName(prefix, serverName, tool.name, false);
    const group = groups.get(baseName);
    if (group) group.push(tool);
    else groups.set(baseName, [tool]);
  }

  const emitted = new Set<string>();
  const ordered: McpToolDefinition[] = [];
  for (const tool of tools) {
    const baseName = buildToolName(prefix, serverName, tool.name, false);
    if (emitted.has(baseName)) continue;
    emitted.add(baseName);
    ordered.push(...(groups.get(baseName) ?? []).sort(compareToolsForNameAssignment));
  }
  return ordered;
}

// ─── Content Conversion ───────────────────────────────────────────────────────

type PiTextContent = { type: "text"; text: string };
type PiImageContent = { type: "image"; data: string; mimeType: string };

function pickNonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function convertResourceLink(obj: Record<string, unknown>): PiTextContent {
  const uri = pickNonEmptyText(obj["uri"]) ?? "unknown";
  const title = pickNonEmptyText(obj["title"]) ?? pickNonEmptyText(obj["name"]);
  const label = title ? ` ${JSON.stringify(title)}` : "";
  const details: string[] = [];
  const mimeType = pickNonEmptyText(obj["mimeType"]);
  if (mimeType) {
    details.push(mimeType);
  }
  if (typeof obj["size"] === "number" && Number.isSafeInteger(obj["size"]) && obj["size"] >= 0) {
    details.push(`${obj["size"]} bytes`);
  }
  const metadata = details.length > 0 ? ` (${details.join(", ")})` : "";
  const descriptionText = pickNonEmptyText(obj["description"]);
  const description = descriptionText ? `\n${descriptionText}` : "";
  return {
    type: "text",
    text: `[Resource link: ${uri}${label}${metadata} — Use mcp_read_resource to read]${description}`,
  };
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
    const resource = obj["resource"];
    return convertResourceContent(typeof resource === "object" && resource !== null ? resource : {});
  }
  return obj["type"] === "resource_link" ? convertResourceLink(obj) : undefined;
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

const ANNOTATION_HINT_KEYS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

/**
 * Build the structured `annotations` Pi reads from a registered tool, so permission extensions
 * can inspect the hints. Copies only the four boolean hints (keeping `false`), ignores `title`
 * and non-boolean values, and returns `undefined` when none apply so the field is omitted.
 */
function buildToolAnnotations(
  annotations: McpToolDefinition["annotations"],
): ToolAnnotations | undefined {
  if (!annotations) return undefined;
  const result: ToolAnnotations = {};
  for (const key of ANNOTATION_HINT_KEYS) {
    const value = annotations[key];
    if (typeof value === "boolean") result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
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

/** True when two tool-name lists have the same length and the same entries in order. */
function sameToolList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((name, index) => name === right[index]);
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

  /**
   * Re-apply this bridge's deterministic tool order to Pi's active list when owned tools have
   * been reordered externally, and do nothing when already ordered.
   *
   * WHY: `/tree` navigation (`session_tree`) restores active tools from the transcript's
   * first-appearance order without re-running `refreshTools`, and another extension may call
   * `pi.setActiveTools` between connects; re-normalizing keeps `sections.tools` in the system
   * prompt aligned with `orderPayloadTools` without re-activating inactive tools (#278).
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
   * Mistral), AWS Bedrock Converse `toolConfig.tools`, and Google/Vertex
   * `config.tools[].functionDeclarations` — and return the payload untouched when they already
   * are. Only entries this bridge owns move, and only among the slots they already occupy:
   * another extension's tool and Pi's reserved trailing declarations (`__pi_deferred_placeholder__`,
   * `cachePoint`, non-function Gemini tool groups) keep their positions.
   *
   * WHY: request tool arrays are not built from the active list — Pi replays the transcript's
   * tool declarations in first-appearance order and emits no delta for a pure reorder, so a
   * server that connects after the first turn leaves its tools at the end, in connect order.
   * Sorting the payload makes the declared tools a function of the tool set, so the prompt head
   * stays stable across sessions and a server-side prefix cache keeps its KV entries (#278).
   */
  orderPayloadTools(payload: unknown): unknown {
    if (!isRecord(payload)) return payload;
    const isOwned = (name: string): boolean => this.toolOwners.has(name);
    const orderedTopLevel = orderDefinitionList(payload["tools"], isOwned);
    if (orderedTopLevel !== undefined) return { ...payload, tools: orderedTopLevel };
    return orderNestedPayloadTools(payload, isOwned) ?? payload;
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
  private _reconcileTools(serverName: string, tools: McpToolDefinition[], client: Client): void {
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
    // WHY: `tools/list` order carries no meaning (a server may reorder it freely), so colliding
    // names are assigned over a deterministic order of the tool set — otherwise the exact-match
    // tool could lose the unhashed name to a lossy one and a later refresh would swap which MCP
    // tool that name executes (#213).
    for (const tool of orderToolsForNameAssignment(this.settings.toolPrefix, serverName, tools)) {
      const piName = this._resolveUniqueToolName(serverName, tool.name, currentToolNames);
      currentToolNames.add(piName);
      currentRawNames.set(piName, tool.name);
      this.toolOwners.set(piName, serverName);
      // Always re-register — on reconnect the client reference changes and
      // Pi's registerTool overwrites by name, so this is idempotent.
      this._registerTool(piName, serverName, tool, client);
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
    // `deactivateServer` activates the whole discovered set (#214).
    const desiredActive = previousStateByRawName
      ? this._resolveLiveDesiredActive(serverName, currentRawNames, previousStateByRawName)
      : currentToolNames;

    this.serverToolNames.set(serverName, currentToolNames);
    this.rawToolNames.set(serverName, currentRawNames);
    this.activeServers.add(serverName);
    this._reconcileActiveTools(ownedPreviousNames, desiredActive, activeBefore);
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
    const toolAnnotations = buildToolAnnotations(annotations);
    const runTool = (params: unknown, signal: AbortSignal | undefined) =>
      this._executeToolCall(serverName, tool.name, client, params, signal);
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
      ...(toolAnnotations ? { annotations: toolAnnotations } : {}),

      async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
        try {
          return await runTool(params, signal);
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
    signal: AbortSignal | undefined,
  ): Promise<ToolCallOutcome> {
    if (signal?.aborted) {
      throw new McpError("Tool execution cancelled", serverName, "protocol");
    }

    let result: ToolCallResponse;
    try {
      result = await callToolWithClient(
        client,
        toolName,
        params,
        this.serverTimeouts.get(serverName) ?? this.settings.requestTimeoutMs,
        signal,
      );
    } catch (err) {
      // WHY: an abort mid-call is rejected by the SDK with its RequestTimeout error, so the
      // cancellation has to be recognised here — otherwise a caller cancellation is reported
      // as a server timeout, and blamed on the server (#209).
      if (isCancellationError(err, signal)) {
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
   * previous snapshot restores the state it left in when dropped on this connection, or
   * activates as newly discovered.
   */
  private _resolveLiveDesiredActive(
    serverName: string,
    currentRawNames: ReadonlyMap<string, string>,
    previousStateByRawName: ReadonlyMap<string, boolean>,
  ): Set<string> {
    const dropped = this.droppedToolState.get(serverName);
    const desiredActive = new Set<string>();
    const seenRawNames = new Set<string>();
    for (const [piName, rawName] of currentRawNames) {
      seenRawNames.add(rawName);
      const shouldActivate =
        previousStateByRawName.get(rawName) ?? dropped?.get(rawName) ?? true;
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
