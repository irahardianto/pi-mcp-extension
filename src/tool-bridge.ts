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
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import * as Type from "typebox";
import type { TSchema } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { McpError, AuthCancelledError } from "./errors.js";
import type { Settings } from "./config.js";
import { isOAuthUnauthorizedError } from "./server-manager.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Subset of Pi's ExtensionAPI used by the bridge. */
export type PiExtensionAPI = Pick<ExtensionAPI, "registerTool" | "getActiveTools" | "setActiveTools">;

export type ToolRefreshOptions = {
  requestTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
};

// WHY: Store per-client default { requestTimeoutMs, signal } in a WeakMap so 2-argument
// onToolRefresh callbacks ((name, client) => bridge.refreshTools(name, client)) still
// inherit the server's configured requestTimeoutMs and handshake AbortSignal.
const clientRefreshDefaults = new WeakMap<Client, ToolRefreshOptions>();

export function setClientDefaultOptions(client: Client, options: ToolRefreshOptions): void {
  if (client && typeof client === "object") {
    clientRefreshDefaults.set(client, options);
  }
}

export function getClientDefaultOptions(client: Client): ToolRefreshOptions | undefined {
  if (client && typeof client === "object") {
    return clientRefreshDefaults.get(client);
  }
  return undefined;
}



// ─── Schema Conversion ────────────────────────────────────────────────────────

const KIND_SYMBOL = Symbol.for("TypeBox.Kind");

function isNullSchema(m: TSchema): boolean {
  const rec = m as Record<string | symbol, unknown>;
  return (
    Type.IsNull(m) ||
    rec["~kind"] === "Null" ||
    rec[KIND_SYMBOL] === "Null" ||
    rec["type"] === "null"
  );
}

/**
 * Place Type.Null() members before non-null union members.
 * WHY: Pi's validateToolArguments runs TypeBox's Value.Convert(schema, args).
 * When Type.String(), Type.Number(), Type.Integer(), or Type.Boolean() precedes
 * Type.Null() in Type.Union([...]), Value.Convert coerces `null` into `""`, `0`,
 * or `false` before reaching the Null branch.
 */
export function orderUnionMembers(members: TSchema[]): TSchema[] {
  const nulls: TSchema[] = [];
  const nonNulls: TSchema[] = [];
  for (const m of members) {
    if (isNullSchema(m)) {
      nulls.push(m);
    } else {
      nonNulls.push(m);
    }
  }
  return [...nulls, ...nonNulls];
}

function extractSchemaOptions(schema: Record<string, unknown>): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  if (typeof schema["description"] === "string") opts["description"] = schema["description"];
  if (typeof schema["title"] === "string") opts["title"] = schema["title"];
  if ("default" in schema && schema["default"] !== undefined) opts["default"] = schema["default"];
  if (typeof schema["format"] === "string") opts["format"] = schema["format"];
  if (typeof schema["pattern"] === "string") opts["pattern"] = schema["pattern"];
  if (typeof schema["minLength"] === "number") opts["minLength"] = schema["minLength"];
  if (typeof schema["maxLength"] === "number") opts["maxLength"] = schema["maxLength"];
  if (typeof schema["minimum"] === "number") opts["minimum"] = schema["minimum"];
  if (typeof schema["maximum"] === "number") opts["maximum"] = schema["maximum"];
  if (typeof schema["exclusiveMinimum"] === "number") opts["exclusiveMinimum"] = schema["exclusiveMinimum"];
  if (typeof schema["exclusiveMaximum"] === "number") opts["exclusiveMaximum"] = schema["exclusiveMaximum"];
  if (typeof schema["multipleOf"] === "number") opts["multipleOf"] = schema["multipleOf"];
  if (typeof schema["minItems"] === "number") opts["minItems"] = schema["minItems"];
  if (typeof schema["maxItems"] === "number") opts["maxItems"] = schema["maxItems"];
  if (typeof schema["uniqueItems"] === "boolean") opts["uniqueItems"] = schema["uniqueItems"];
  if (typeof schema["minProperties"] === "number") opts["minProperties"] = schema["minProperties"];
  if (typeof schema["maxProperties"] === "number") opts["maxProperties"] = schema["maxProperties"];
  return opts;
}

function withSchemaOptions(schema: TSchema, opts: Record<string, unknown>): TSchema {
  if (Object.keys(opts).length === 0) return schema;
  const clone = Object.defineProperties({}, Object.getOwnPropertyDescriptors(schema)) as TSchema;
  return Object.assign(clone, opts);
}

function unescapeJsonPointer(segment: string): string {
  // WHY: RFC 6901 §4 requires unescaping "~1" to "/" before "~0" to "~" so "~01" becomes "~1".
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function stepJsonPointer(curr: unknown, part: string): unknown {
  if (!curr || typeof curr !== "object") {
    return undefined;
  }
  if (Array.isArray(curr)) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(part)) {
      return undefined;
    }
    const idx = Number(part);
    return idx >= 0 && idx < curr.length ? curr[idx] : undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(curr, part)) {
    return undefined;
  }
  return (curr as Record<string, unknown>)[part];
}

export function resolveRefTarget(
  ref: string,
  rootDefs: Record<string, Record<string, unknown>> | undefined,
  rootSchema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (ref === "#") {
    return rootSchema;
  }
  if (!ref.startsWith("#/")) {
    return undefined;
  }

  const parts = ref.slice(2).split("/").map(unescapeJsonPointer);

  if (
    (parts[0] === "$defs" || parts[0] === "definitions") &&
    parts.length >= 2 &&
    rootDefs &&
    Object.prototype.hasOwnProperty.call(rootDefs, parts[1]!)
  ) {
    const defEntry = rootDefs[parts[1]!];
    if (defEntry && typeof defEntry === "object" && !Array.isArray(defEntry)) {
      if (parts.length === 2) {
        return defEntry;
      }
      let curr: unknown = defEntry;
      for (let i = 2; i < parts.length; i++) {
        curr = stepJsonPointer(curr, parts[i]!);
        if (curr === undefined) break;
      }
      if (curr && typeof curr === "object" && !Array.isArray(curr)) {
        return curr as Record<string, unknown>;
      }
    }
  }

  let curr: unknown = rootSchema;
  for (const part of parts) {
    curr = stepJsonPointer(curr, part);
    if (curr === undefined) {
      return undefined;
    }
  }
  if (curr && typeof curr === "object" && !Array.isArray(curr)) {
    return curr as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Convert a JSON Schema object to a TypeBox schema.
 * Handles the common subset used by real-world MCP servers:
 *   - Primitives (string, number, integer, boolean, null)
 *   - Arrays, tuples (prefixItems / array items), objects (with required/optional/additionalProperties)
 *   - Enums and const (string, numeric, boolean, and nullable enums → Union of Literals)
 *   - Nullable and multi-type arrays ("type": ["string", "null"]) with Type.Null() ordered first
 *   - Cycle-safe $ref (#, #/$defs/, #/definitions/, and arbitrary RFC 6901 JSON Pointers)
 *   - oneOf / anyOf → TypeBox Union
 *   - allOf → TypeBox Intersect
 * Falls back to Type.Any() for unresolvable $ref, recursive cycles, or missing type.
 */
export function convertJsonSchemaToTypebox(
  schema: Record<string, unknown>,
  defs?: Record<string, Record<string, unknown>>,
  rootSchema?: Record<string, unknown>,
  seenRefs: ReadonlySet<string> = new Set(),
): TSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return Type.Any();
  }

  const effectiveRoot = rootSchema ?? schema;
  const opts = extractSchemaOptions(schema);

  // Extract $defs / definitions for $ref resolution (carried through recursive calls)
  const localDefs = (schema["$defs"] ?? schema["definitions"]) as
    | Record<string, Record<string, unknown>>
    | undefined;
  const rootDefs: Record<string, Record<string, unknown>> = {
    ...(localDefs && typeof localDefs === "object" && !Array.isArray(localDefs) ? localDefs : {}),
    ...defs,
  };

  // ── Handle $ref ──────────────────────────────────────────────────────────
  if (typeof schema["$ref"] === "string") {
    const ref = schema["$ref"];
    if (seenRefs.has(ref)) {
      // WHY: Break recursive $ref cycles along the active resolution path to prevent
      // stack overflow or exponential blowup on self-referential schemas.
      return Type.Any(opts);
    }

    const resolved = resolveRefTarget(ref, rootDefs, effectiveRoot);
    if (!resolved) {
      return Type.Any(opts);
    }

    // Merge sibling metadata from the $ref site into the resolved schema
    const merged: Record<string, unknown> = { ...resolved };
    if (typeof schema["description"] === "string") {
      merged["description"] = schema["description"];
    }
    if (typeof schema["title"] === "string") {
      merged["title"] = schema["title"];
    }
    if ("default" in schema && schema["default"] !== undefined) {
      merged["default"] = schema["default"];
    }

    const nextSeen = new Set(seenRefs);
    nextSeen.add(ref);
    return convertJsonSchemaToTypebox(merged, rootDefs, effectiveRoot, nextSeen);
  }

  // ── Handle const ─────────────────────────────────────────────────────────
  if ("const" in schema && schema["const"] !== undefined) {
    const val = schema["const"];
    if (val === null) {
      return Type.Null(opts);
    }
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      return Type.Literal(val, opts);
    }
    return Type.Any(opts);
  }

  // ── Handle enum (untyped, string, number, boolean, or nullable) ──────────
  if (Array.isArray(schema["enum"])) {
    const enumVals = schema["enum"] as unknown[];
    const members: TSchema[] = [];
    let hasNullMember = false;
    for (const v of enumVals) {
      if (v === null) {
        members.push(Type.Null());
        hasNullMember = true;
      } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        members.push(Type.Literal(v));
      }
    }
    if (Array.isArray(schema["type"]) && schema["type"].includes("null") && !hasNullMember) {
      members.push(Type.Null());
    }
    if (members.length === 0) {
      return Type.Any(opts);
    }
    const ordered = orderUnionMembers(members);
    if (ordered.length === 1) {
      return withSchemaOptions(ordered[0]!, opts);
    }
    return Type.Union(ordered, opts);
  }

  const hasObjectKeywords =
    (typeof schema["properties"] === "object" &&
      schema["properties"] !== null &&
      !Array.isArray(schema["properties"])) ||
    Array.isArray(schema["required"]) ||
    schema["additionalProperties"] !== undefined ||
    typeof schema["minProperties"] === "number" ||
    typeof schema["maxProperties"] === "number";

  const hasArrayKeywords =
    schema["items"] !== undefined || Array.isArray(schema["prefixItems"]);

  const rawType = schema["type"];

  // ── Handle non-object combinators (oneOf / anyOf / allOf) ────────────────
  if (
    !hasObjectKeywords &&
    !hasArrayKeywords &&
    rawType !== "object" &&
    rawType !== "array" &&
    !Array.isArray(rawType)
  ) {
    const inheritType = (sub: unknown): Record<string, unknown> => {
      if (!sub || typeof sub !== "object" || Array.isArray(sub)) {
        return sub as Record<string, unknown>;
      }
      const subObj = sub as Record<string, unknown>;
      if (
        typeof rawType === "string" &&
        subObj["type"] === undefined &&
        subObj["$ref"] === undefined &&
        subObj["const"] === undefined &&
        subObj["enum"] === undefined &&
        subObj["oneOf"] === undefined &&
        subObj["anyOf"] === undefined &&
        subObj["allOf"] === undefined
      ) {
        return { type: rawType, ...subObj };
      }
      return subObj;
    };

    if (Array.isArray(schema["oneOf"])) {
      const members = orderUnionMembers(
        (schema["oneOf"] as unknown[]).map((sub) =>
          convertJsonSchemaToTypebox(inheritType(sub), rootDefs, effectiveRoot, seenRefs),
        ),
      );
      if (members.length === 0) return Type.Any(opts);
      return members.length === 1
        ? withSchemaOptions(members[0]!, opts)
        : Type.Union(members, opts);
    }

    if (Array.isArray(schema["anyOf"])) {
      const members = orderUnionMembers(
        (schema["anyOf"] as unknown[]).map((sub) =>
          convertJsonSchemaToTypebox(inheritType(sub), rootDefs, effectiveRoot, seenRefs),
        ),
      );
      if (members.length === 0) return Type.Any(opts);
      return members.length === 1
        ? withSchemaOptions(members[0]!, opts)
        : Type.Union(members, opts);
    }

    if (Array.isArray(schema["allOf"])) {
      const members = (schema["allOf"] as unknown[]).map((sub) =>
        convertJsonSchemaToTypebox(inheritType(sub), rootDefs, effectiveRoot, seenRefs),
      );
      if (members.length === 0) return Type.Any(opts);
      return members.length === 1
        ? withSchemaOptions(members[0]!, opts)
        : Type.Intersect(members, opts);
    }
  }

  // ── Handle multi-type arrays: { "type": ["string", "null"] } ─────────────
  if (Array.isArray(rawType)) {
    const typeList = rawType.filter((t): t is string => typeof t === "string");
    const hasNull = typeList.includes("null");
    const nonNull = typeList.filter((t) => t !== "null");

    if (nonNull.length === 0) {
      return hasNull ? Type.Null(opts) : Type.Any(opts);
    }
    if (nonNull.length === 1) {
      const inner = convertJsonSchemaToTypebox(
        { ...schema, type: nonNull[0] },
        rootDefs,
        effectiveRoot,
        seenRefs,
      );
      return hasNull ? Type.Union(orderUnionMembers([Type.Null(), inner]), opts) : inner;
    }
    const members: TSchema[] = nonNull.map((t) =>
      convertJsonSchemaToTypebox(
        { ...schema, type: t },
        rootDefs,
        effectiveRoot,
        seenRefs,
      ),
    );
    if (hasNull) {
      members.unshift(Type.Null());
    }
    return Type.Union(orderUnionMembers(members), opts);
  }

  const type =
    typeof rawType === "string"
      ? rawType
      : hasObjectKeywords
        ? "object"
        : hasArrayKeywords
          ? "array"
          : undefined;

  switch (type) {
    case "string":
      return Type.String(opts);
    case "number":
      return Type.Number(opts);
    case "integer":
      return Type.Integer(opts);
    case "boolean":
      return Type.Boolean(opts);
    case "null":
      return Type.Null(opts);
    case "array": {
      const tupleItems = Array.isArray(schema["prefixItems"])
        ? (schema["prefixItems"] as unknown[])
        : Array.isArray(schema["items"])
          ? (schema["items"] as unknown[])
          : undefined;
      if (tupleItems) {
        return Type.Tuple(
          tupleItems.map((item) =>
            convertJsonSchemaToTypebox(
              item as Record<string, unknown>,
              rootDefs,
              effectiveRoot,
              seenRefs,
            ),
          ),
          opts,
        );
      }
      const items = schema["items"];
      return Type.Array(
        items && typeof items === "object" && !Array.isArray(items)
          ? convertJsonSchemaToTypebox(
              items as Record<string, unknown>,
              rootDefs,
              effectiveRoot,
              seenRefs,
            )
          : Type.Unknown(),
        opts,
      );
    }
    case "object": {
      const rawProperties: Record<string, unknown> =
        typeof schema["properties"] === "object" &&
        schema["properties"] !== null &&
        !Array.isArray(schema["properties"])
          ? { ...(schema["properties"] as Record<string, unknown>) }
          : {};
      const required = new Set<string>(
        Array.isArray(schema["required"])
          ? (schema["required"] as unknown[]).filter((r): r is string => typeof r === "string")
          : [],
      );
      const additionalProperties = schema["additionalProperties"];

      let allOfSchemas: TSchema[] | undefined;
      if (Array.isArray(schema["allOf"])) {
        allOfSchemas = (schema["allOf"] as unknown[]).map((sub) =>
          convertJsonSchemaToTypebox(
            sub as Record<string, unknown>,
            rootDefs,
            effectiveRoot,
            seenRefs,
          ),
        );
        for (const sub of schema["allOf"] as unknown[]) {
          if (sub && typeof sub === "object" && !Array.isArray(sub)) {
            const subObj = sub as Record<string, unknown>;
            const resolvedSub =
              typeof subObj["$ref"] === "string" && !seenRefs.has(subObj["$ref"])
                ? (resolveRefTarget(subObj["$ref"], rootDefs, effectiveRoot) ?? subObj)
                : subObj;
            if (
              typeof resolvedSub["properties"] === "object" &&
              resolvedSub["properties"] !== null &&
              !Array.isArray(resolvedSub["properties"])
            ) {
              for (const [k, v] of Object.entries(resolvedSub["properties"] as Record<string, unknown>)) {
                if (!(k in rawProperties)) {
                  rawProperties[k] = v;
                }
              }
            }
            if (Array.isArray(resolvedSub["required"])) {
              for (const reqKey of resolvedSub["required"]) {
                if (typeof reqKey === "string") {
                  required.add(reqKey);
                }
              }
            }
          }
        }
      }

      const props: Record<string, TSchema> = {};
      for (const [key, value] of Object.entries(rawProperties)) {
        const converted = convertJsonSchemaToTypebox(
          value as Record<string, unknown>,
          rootDefs,
          effectiveRoot,
          seenRefs,
        );
        props[key] = required.has(key) ? converted : Type.Optional(converted);
      }

      const objOpts: Record<string, unknown> = { ...opts };
      if (typeof additionalProperties === "boolean") {
        objOpts["additionalProperties"] = additionalProperties;
      } else if (
        typeof additionalProperties === "object" &&
        additionalProperties !== null &&
        !Array.isArray(additionalProperties)
      ) {
        objOpts["additionalProperties"] = convertJsonSchemaToTypebox(
          additionalProperties as Record<string, unknown>,
          rootDefs,
          effectiveRoot,
          seenRefs,
        );
      }

      if (required.size > 0) {
        objOpts["required"] = Array.from(required);
      }

      if (Array.isArray(schema["oneOf"])) {
        objOpts["oneOf"] = orderUnionMembers(
          (schema["oneOf"] as unknown[]).map((sub) =>
            convertJsonSchemaToTypebox(
              sub as Record<string, unknown>,
              rootDefs,
              effectiveRoot,
              seenRefs,
            ),
          ),
        );
      }
      if (Array.isArray(schema["anyOf"])) {
        objOpts["anyOf"] = orderUnionMembers(
          (schema["anyOf"] as unknown[]).map((sub) =>
            convertJsonSchemaToTypebox(
              sub as Record<string, unknown>,
              rootDefs,
              effectiveRoot,
              seenRefs,
            ),
          ),
        );
      }
      if (allOfSchemas) {
        objOpts["allOf"] = allOfSchemas;
      }

      // WHY: Always emit Type.Object(props, objOpts) even when `props` is empty (`{}`)
      // so empty object schemas serialize as `{ type: "object", properties: {} }`
      // rather than `Type.Record` (`patternProperties`), which Gemini and OpenAI reject.
      return Type.Object(props, objOpts);
    }
    default:
      return Type.Any(opts);
  }
}

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

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    title?: string;
  };
}

/**
 * Fetch all tools from a server using cursor-based pagination.
 * The MCP spec mandates clients follow nextCursor until exhausted.
 * Includes a max-page guard to prevent infinite loops from broken servers.
 */
export async function listAllTools(
  client: Client,
  requestTimeoutMs: number,
  signal?: AbortSignal,
  serverName = "<unknown>",
): Promise<McpToolDefinition[]> {
  const tools: McpToolDefinition[] = [];
  let cursor: string | undefined;
  const MAX_PAGES = 100;
  let pageCount = 0;

  do {
    if (signal?.aborted) {
      throw new AuthCancelledError(serverName);
    }
    if (pageCount >= MAX_PAGES) {
      console.warn(
        `[pi-mcp] tools/list pagination exceeded ${MAX_PAGES} pages, stopping. The server may be malfunctioning.`,
      );
      break;
    }
    const requestOptions = {
      timeout: requestTimeoutMs,
      ...(signal ? { signal } : {}),
    };
    const callPromise =
      typeof client.listTools === "function"
        ? client.listTools(cursor ? { cursor } : undefined, requestOptions)
        : client.request(
            { method: "tools/list", params: cursor ? { cursor } : {} },
            ListToolsResultSchema,
            requestOptions,
          );

    let result: Awaited<typeof callPromise>;
    if (signal) {
      callPromise.catch(() => {
        // WHY: Suppress unhandled rejection if in-flight listTools rejects after abort wins the race.
      });
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<never>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new AuthCancelledError(serverName));
          return;
        }
        onAbort = () => reject(new AuthCancelledError(serverName));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        result = await Promise.race([callPromise, abortPromise]);
      } finally {
        if (onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
      }
    } else {
      result = await callPromise;
    }

    tools.push(...(result.tools as McpToolDefinition[]));
    cursor = result.nextCursor;
    pageCount++;
  } while (cursor);

  return tools;
}

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
    this.settings = settings;
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
    const defaults = getClientDefaultOptions(client);
    const effectiveTimeoutMs =
      options?.requestTimeoutMs ?? defaults?.requestTimeoutMs ?? this.settings.requestTimeoutMs;
    const effectiveSignal = options?.signal ?? defaults?.signal;
    this.serverTimeouts.set(serverName, effectiveTimeoutMs);

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
