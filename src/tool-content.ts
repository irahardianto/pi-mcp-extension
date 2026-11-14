/**
 * Pure MCP tool metadata, annotation hints (#265), and content block conversion
 * (#260 resource_link / embedded resource / image / audio / text) for pi-mcp.
 */

import * as Type from "typebox";
import type { TSchema } from "typebox";
import type { ToolAnnotations } from "@earendil-works/pi-coding-agent";
import { convertResourceContent } from "./resource-bridge.js";
import type { McpToolDefinition } from "./tool-discovery.js";

export type PiTextContent = { type: "text"; text: string };
export type PiImageContent = { type: "image"; data: string; mimeType: string };
export type PiContent = PiTextContent | PiImageContent;

/** JSON-serializable value compatible with Pi's `AgentToolResult["structuredContent"]`. */
export type McpJsonValue =
  | string
  | number
  | boolean
  | null
  | McpJsonValue[]
  | { [key: string]: McpJsonValue };

/** Tool call result shape Pi expects from `execute`. */
export interface ToolCallOutcome {
  content: PiContent[];
  details: Record<string, never>;
  structuredContent?: McpJsonValue;
}

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

/** Append the tool's annotation hints to its description so the LLM sees them. */
export function buildToolDescription(
  tool: McpToolDefinition,
  annotations: McpToolDefinition["annotations"] = tool.annotations,
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

export const ANNOTATION_HINT_KEYS = [
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
export function buildToolAnnotations(
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

/**
 * Convert a callTool result into Pi content blocks, falling back to
 * `structuredContent` when the server returned no content blocks.
 */
export function buildToolCallContent(result: ToolCallResponse): PiContent[] {
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
export function toolErrorText(content: readonly PiContent[]): string {
  return content
    .filter((c): c is PiTextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
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
 * alongside `structuredContent` (#257).
 */
export function buildMcpScriptResult(result: ToolCallResponse): McpJsonValue {
  const { _meta: _ignored, ...rest } = result;
  const normalized: Record<string, unknown> = {
    ...rest,
    content: Array.isArray(result.content) ? result.content : [],
  };
  return toMcpJsonObject(normalized, 0, new WeakSet<object>());
}

