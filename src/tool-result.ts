/**
 * Pure Pi 1.3.0 MCP `CallToolResult` output-schema relocation (`buildMcpResultSchema`),
 * script-facing `structuredContent` normalization (`buildMcpScriptResult`), and Pi 1.3.0+
 * tool-error-result runtime capability detection (`supportsToolErrorResult`) (#257).
 */

import * as Type from "typebox";
import type { TSchema } from "typebox";

/** JSON-serializable value compatible with Pi's `AgentToolResult["structuredContent"]`. */
export type McpJsonValue =
  | string
  | number
  | boolean
  | null
  | McpJsonValue[]
  | { [key: string]: McpJsonValue };

/**
 * The subset of an SDK `tools/call` response the bridge consumes.
 * Legacy servers answer with `toolResult` instead of `content`, so every field
 * stays optional and unvalidated here — `convertMcpContent` handles the blocks.
 * The index signature keeps the SDK's compatibility result assignable.
 */
export interface ToolCallResponse {
  [key: string]: unknown;
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
}

const MAX_RELOCATE_DEPTH = 32;
const STRUCTURED_CONTENT_POINTER = "#/properties/structuredContent";
const SCHEMA_DATA_KEYWORDS = new Set(["const", "enum", "default", "examples"]);
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "$defs",
  "definitions",
]);

const CONTENT_BLOCK_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
    text: { type: "string" },
    data: { type: "string" },
    mimeType: { type: "string" },
  },
  required: ["type"],
  additionalProperties: true,
};

interface RelocateContext {
  pointer: string;
  depth: number;
  seen: WeakSet<object>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relocateRefPointer(value: unknown, pointer: string): string | undefined {
  if (typeof value !== "string") return undefined;
  return value === "#" || value.startsWith("#/") ? `${pointer}${value.slice(1)}` : undefined;
}

function relocateSchemaEntry(key: string, value: unknown, ctx: RelocateContext): unknown {
  if (key === "$ref") {
    return relocateRefPointer(value, ctx.pointer) ?? value;
  }
  if (SCHEMA_DATA_KEYWORDS.has(key)) {
    return value;
  }
  if (SCHEMA_MAP_KEYWORDS.has(key) && isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, sub]) => [name, relocateOutputSchema(sub, ctx)]),
    );
  }
  return relocateOutputSchema(value, ctx);
}

function relocateOutputSchema(schema: unknown, ctx: RelocateContext): unknown {
  if (ctx.depth >= MAX_RELOCATE_DEPTH || typeof schema !== "object" || schema === null) {
    return schema;
  }
  if (ctx.seen.has(schema)) return {};
  const nextCtx: RelocateContext = {
    pointer: ctx.pointer,
    depth: ctx.depth + 1,
    seen: ctx.seen,
  };
  ctx.seen.add(schema);
  try {
    return Array.isArray(schema)
      ? schema.map((item) => relocateOutputSchema(item, nextCtx))
      : Object.fromEntries(
          Object.entries(schema).map(([key, value]) => [
            key,
            relocateSchemaEntry(key, value, nextCtx),
          ]),
        );
  } finally {
    ctx.seen.delete(schema);
  }
}

/**
 * Build Pi 1.3.0's `CallToolResult` output schema for an MCP tool so `codemode`'s
 * `searchTools()` / `describeTool()` renders `{ content, structuredContent, isError }` with the
 * tool's own `outputSchema` relocated under `#/properties/structuredContent`.
 */
export function buildMcpResultSchema(outputSchema?: Record<string, unknown>): TSchema {
  const structuredContent = isPlainRecord(outputSchema)
    ? relocateOutputSchema(outputSchema, {
        pointer: STRUCTURED_CONTENT_POINTER,
        depth: 0,
        seen: new WeakSet<object>(),
      })
    : {};
  return Type.Unsafe({
    type: "object",
    properties: {
      content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
      structuredContent,
      isError: { type: "boolean" },
    },
    required: ["content"],
    additionalProperties: true,
  });
}

function toMcpJsonObject(
  record: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>,
): { [key: string]: McpJsonValue } {
  // WHY: `Object.fromEntries` defines properties via `CreateDataProperty` instead of `[[Set]]`,
  // so an own `"__proto__"` key parsed from untrusted MCP JSON cannot mutate the result's prototype.
  const entries: Array<[string, McpJsonValue]> = [];
  for (const [key, entry] of Object.entries(record)) {
    const converted = toMcpJsonValue(entry, depth + 1, seen);
    if (converted !== undefined) {
      entries.push([key, converted]);
    }
  }
  return Object.fromEntries(entries);
}

function toMcpJsonPrimitive(value: unknown): McpJsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    // WHY: `value + 0` canonicalizes `-0` to `+0` without branching, matching `JSON.stringify`.
    return Number.isFinite(value) ? value + 0 : null;
  }
  return undefined;
}

function toMcpJsonValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): McpJsonValue | undefined {
  const primitive = toMcpJsonPrimitive(value);
  if (primitive !== undefined) return primitive;
  if (depth >= MAX_RELOCATE_DEPTH || typeof value !== "object" || value === null || seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  try {
    return Array.isArray(value)
      ? value.map((item) => toMcpJsonValue(item, depth + 1, seen) ?? null)
      : toMcpJsonObject(value as Record<string, unknown>, depth, seen);
  } finally {
    seen.delete(value);
  }
}

/**
 * Build the `CallToolResult` value (without `_meta`) exposed as `AgentToolResult.structuredContent`
 * so `codemode` scripts receive raw MCP `content` blocks (including images for `image(block)`)
 * alongside `structuredContent` and canonical boolean `isError` (#257).
 */
export function buildMcpScriptResult(result: ToolCallResponse): McpJsonValue {
  const { _meta: _ignored, ...rest } = result;
  const normalized: Record<string, unknown> = {
    ...rest,
    content: Array.isArray(result.content) ? result.content : [],
    ...(result.isError !== undefined ? { isError: Boolean(result.isError) } : {}),
  };
  return toMcpJsonObject(normalized, 0, new WeakSet<object>());
}

/**
 * True when `execute` received Pi 1.3.0+'s `ExtensionToolContext` (`createToolContext`), which
 * defines `executeTool` alongside `AgentToolResult.isError` and `structuredContent`.
 *
 * WHY: Pi `< 1.3.0` (`createContext()`) and direct `execute(..., undefined)` callers lack
 * `AgentToolResult.isError` support and would treat a non-throwing `{ isError: true }` return as a
 * successful tool call, whereas Pi 1.3.0+ preserves `structuredContent` and `isError: true` for
 * `codemode` scripts and `tool_result` hooks when returned directly (#257).
 */
export function supportsToolErrorResult(ctx: unknown): boolean {
  if (!isPlainRecord(ctx)) return false;
  return typeof ctx["executeTool"] === "function";
}
