/**
 * Pure MCP tool metadata, annotation hints (#265), and content block conversion
 * (#260 resource_link / embedded resource / image / audio / text) for pi-mcp.
 */

import type { ToolAnnotations } from "@earendil-works/pi-coding-agent";
import { convertResourceContent } from "./resource-bridge.js";
import type { McpToolDefinition } from "./tool-discovery.js";

export type PiTextContent = { type: "text"; text: string };
export type PiImageContent = { type: "image"; data: string; mimeType: string };
export type PiContent = PiTextContent | PiImageContent;

/** Tool call result shape Pi expects from `execute`. */
export interface ToolCallOutcome {
  content: PiContent[];
  details: Record<string, never>;
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
