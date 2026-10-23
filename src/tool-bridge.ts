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

export function convertMcpContent(items: unknown[]): (PiTextContent | PiImageContent)[] {
  return items.map((item: unknown) => {
    if (!item || typeof item !== "object") {
      return { type: "text", text: String(item) };
    }
    const obj = item as Record<string, unknown>;
    switch (obj["type"]) {
      case "text":
        return { type: "text", text: String(obj["text"] ?? "") };
      case "image":
        return {
          type: "image",
          data: String(obj["data"] ?? ""),
          mimeType: String(obj["mimeType"] ?? "image/png"),
        };
      case "audio":
        return {
          type: "text",
          text: `[Audio: ${String(obj["mimeType"] ?? "unknown")}, base64 encoded]`,
        };
      case "resource": {
        const r = obj["resource"] as Record<string, unknown> | undefined;
        // WHY: Check `typeof r?.["text"] === "string"` rather than truthiness so
        // empty text resources (`text: ""`) are preserved as `""` instead of `[Resource: uri]`.
        if (typeof r?.["text"] === "string") return { type: "text", text: r["text"] };
        if (r?.["blob"]) return { type: "text", text: `[Resource blob: ${String(r["uri"])}]` };
        return { type: "text", text: `[Resource: ${String(r?.["uri"] ?? "unknown")}]` };
      }
      default:
        return { type: "text", text: JSON.stringify(item) };
    }
  });
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
    const isCurrent = typeof isCurrentOrOptions === "function" ? isCurrentOrOptions : () => true;
    const options = typeof isCurrentOrOptions === "object" ? isCurrentOrOptions : maybeOptions;
    const explicitTimeoutMs = options?.requestTimeoutMs;
    const effectiveTimeoutMs = explicitTimeoutMs ?? this.settings.requestTimeoutMs;
    const effectiveSignal = options?.signal;
    if (explicitTimeoutMs !== undefined) {
      this.serverTimeouts.set(serverName, explicitTimeoutMs);
    } else {
      this.serverTimeouts.delete(serverName);
    }

    const gen = (this.refreshGenerations.get(serverName) ?? 0) + 1;
    this.refreshGenerations.set(serverName, gen);

    let tools: McpToolDefinition[];
    try {
      tools = await listAllTools(client, effectiveTimeoutMs, effectiveSignal, serverName);
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

    // WHY: Discard stale tools/list responses if a newer refreshTools(),
    // deactivateServer(), or removeServerTools() occurred while listAllTools() was in flight.
    if (this.refreshGenerations.get(serverName) !== gen || !isCurrent()) return;
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
      if (!currentToolNames.has(existingName)) {
        this._deactivateServerTool(serverName, existingName);
        if (this.toolOwners.get(existingName) === serverName) {
          this.toolOwners.delete(existingName);
        }
      }
    }

    this.serverToolNames.set(serverName, currentToolNames);

    // Activate all current tools for this server
    this._activateServerTools(serverName);
  }

  /** Report discovery separately from the tools currently exposed by Pi. */
  getToolActivity(serverName: string): { discovered: number; active: number } {
    const names = this.serverToolNames.get(serverName) ?? new Set<string>();
    const active = new Set(this.pi.getActiveTools());
    return { discovered: names.size, active: [...names].filter((name) => active.has(name)).length };
  }

  /** Deactivate all Pi tools belonging to a server (called on disconnect). */
  deactivateServer(serverName: string): void {
    const gen = (this.refreshGenerations.get(serverName) ?? 0) + 1;
    this.refreshGenerations.set(serverName, gen);
    this._deactivateServerTools(serverName);
  }

  /** Remove all tracking data for a server (called when config changes remove a server). */
  removeServer(serverName: string): void {
    this.removeServerTools(serverName);
  }

  /** Remove all tools and ownership tracking for a server. */
  removeServerTools(serverName: string): void {
    const gen = (this.refreshGenerations.get(serverName) ?? 0) + 1;
    this.refreshGenerations.set(serverName, gen);
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

  private _resolveUniqueToolName(
    serverName: string,
    rawToolName: string,
    seenInBatch: ReadonlySet<string>,
  ): string {
    const isTaken = (name: string): boolean => {
      if (seenInBatch.has(name)) return true;
      const owner = this.toolOwners.get(name);
      return owner !== undefined && owner !== serverName;
    };

    const baseCandidate = buildToolName(this.settings.toolPrefix, serverName, rawToolName, false);
    if (!isTaken(baseCandidate)) {
      return baseCandidate;
    }

    const hashedCandidate = buildToolName(this.settings.toolPrefix, serverName, rawToolName, true);
    if (!isTaken(hashedCandidate)) {
      return hashedCandidate;
    }

    let suffix = 2;
    while (true) {
      const tag = `_${suffix}`;
      const candidate = `${hashedCandidate.slice(0, MAX_TOOL_NAME_LEN - tag.length)}${tag}`;
      if (!isTaken(candidate)) {
        return candidate;
      }
      suffix++;
    }
  }

  private _registerTool(
    piName: string,
    serverName: string,
    tool: McpToolDefinition,
    client: Client,
  ): void {
    // Build description with annotation hints for LLM guidance
    let description = tool.description ?? `MCP tool: ${tool.name}`;
    const ann = tool.annotations;
    if (ann) {
      const hints: string[] = [];
      if (ann.readOnlyHint) hints.push("read-only");
      if (ann.destructiveHint) hints.push("⚠️ destructive");
      if (ann.idempotentHint) hints.push("idempotent");
      if (ann.openWorldHint) hints.push("may have side effects");
      if (hints.length > 0) description += ` [${hints.join(", ")}]`;
    }

    const schema = convertJsonSchemaToTypebox(tool.inputSchema);
    const getEffectiveTimeoutMs = () =>
      this.serverTimeouts.get(serverName) ?? this.settings.requestTimeoutMs;
    const notifyAuthError = (err: unknown) => this.onAuthError?.(serverName, err);

    this.pi.registerTool({
      name: piName,
      label: ann?.title ?? tool.name,
      description,
      promptSnippet: description.slice(0, 120),
      parameters: schema,

      async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
        if (signal?.aborted) {
          throw new McpError("Tool execution cancelled", serverName, "protocol");
        }

        const effectiveTimeoutMs = getEffectiveTimeoutMs();
        const requestOptions = {
          timeout: effectiveTimeoutMs,
          ...(signal ? { signal } : {}),
        };

        try {
          const result =
            typeof client.callTool === "function"
              ? await client.callTool(
                  { name: tool.name, arguments: params as Record<string, unknown> },
                  CallToolResultSchema,
                  requestOptions,
                )
              : await client.request(
                  {
                    method: "tools/call",
                    params: { name: tool.name, arguments: params },
                  },
                  CallToolResultSchema,
                  // Pass AbortSignal to SDK — it will automatically send
                  // notifications/cancelled when the signal fires
                  requestOptions,
                );

          const content = convertMcpContent(
            (result.content ?? []) as Array<Record<string, unknown>>,
          );
          if (content.length === 0 && result.structuredContent !== undefined) {
            const serialized =
              typeof result.structuredContent === "string"
                ? result.structuredContent
                : JSON.stringify(result.structuredContent, null, 2);
            content.push({ type: "text", text: serialized });
          }

          // Tool execution errors (isError: true) — distinct from protocol errors
          if (result.isError) {
            const errorText = content
              .filter((c): c is PiTextContent => c.type === "text")
              .map((c) => c.text)
              .join("\n");
            throw new McpError(
              errorText || "Tool reported an error",
              serverName,
              "tool",
            );
          }

          return { content, details: {} };
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
