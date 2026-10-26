/**
 * Pure MCP JSON Schema → TypeBox conversion for pi-mcp.
 */

import * as Type from "typebox";
import type { TSchema } from "typebox";
import { resolveRefTarget } from "./schema-refs.js";

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

type SchemaOptionKind = "string" | "number" | "boolean" | "defined";

// WHY: Order matters for byte-stable serialized schemas — keep this table in the
// same sequence the hand-written checks used before it became a lookup loop.
const SCHEMA_OPTION_KEYS: ReadonlyArray<readonly [string, SchemaOptionKind]> = [
  ["description", "string"],
  ["title", "string"],
  ["default", "defined"],
  ["format", "string"],
  ["pattern", "string"],
  ["minLength", "number"],
  ["maxLength", "number"],
  ["minimum", "number"],
  ["maximum", "number"],
  ["exclusiveMinimum", "number"],
  ["exclusiveMaximum", "number"],
  ["multipleOf", "number"],
  ["minItems", "number"],
  ["maxItems", "number"],
  ["uniqueItems", "boolean"],
  ["minProperties", "number"],
  ["maxProperties", "number"],
];

function hasSchemaOptionValue(
  schema: Record<string, unknown>,
  key: string,
  kind: SchemaOptionKind,
): boolean {
  const value = schema[key];
  if (kind === "defined") {
    return key in schema && value !== undefined;
  }
  return typeof value === kind;
}

function extractSchemaOptions(schema: Record<string, unknown>): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  for (const [key, kind] of SCHEMA_OPTION_KEYS) {
    if (hasSchemaOptionValue(schema, key, kind)) {
      opts[key] = schema[key];
    }
  }
  return opts;
}

function withSchemaOptions(schema: TSchema, opts: Record<string, unknown>): TSchema {
  if (Object.keys(opts).length === 0) return schema;
  const clone = Object.defineProperties<TSchema>({}, Object.getOwnPropertyDescriptors(schema));
  return Object.assign(clone, opts);
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function hasObjectSchemaKeywords(schema: Record<string, unknown>): boolean {
  if (isPlainObject(schema["properties"]) || Array.isArray(schema["required"])) {
    return true;
  }
  return (
    schema["additionalProperties"] !== undefined ||
    typeof schema["minProperties"] === "number" ||
    typeof schema["maxProperties"] === "number"
  );
}

function hasArraySchemaKeywords(schema: Record<string, unknown>): boolean {
  return schema["items"] !== undefined || Array.isArray(schema["prefixItems"]);
}

interface ConversionContext {
  rootDefs: Record<string, Record<string, unknown>>;
  effectiveRoot: Record<string, unknown>;
  seenRefs: ReadonlySet<string>;
}

function convertRefSchema(
  ref: string,
  schema: Record<string, unknown>,
  opts: Record<string, unknown>,
  ctx: ConversionContext,
): TSchema {
  if (ctx.seenRefs.has(ref)) {
    // WHY: Break recursive $ref cycles along the active resolution path to prevent
    // stack overflow or exponential blowup on self-referential schemas.
    return Type.Any(opts);
  }

  const resolved = resolveRefTarget(ref, ctx.rootDefs, ctx.effectiveRoot);
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

  const nextSeen = new Set(ctx.seenRefs);
  nextSeen.add(ref);
  return convertJsonSchemaToTypebox(merged, ctx.rootDefs, ctx.effectiveRoot, nextSeen);
}

function convertConstSchema(val: unknown, opts: Record<string, unknown>): TSchema {
  if (val === null) {
    return Type.Null(opts);
  }
  if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
    return Type.Literal(val, opts);
  }
  return Type.Any(opts);
}

function convertEnumSchema(schema: Record<string, unknown>, opts: Record<string, unknown>): TSchema {
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

function convertPreTypeSchema(
  schema: Record<string, unknown>,
  opts: Record<string, unknown>,
  ctx: ConversionContext,
): TSchema | null {
  if (typeof schema["$ref"] === "string") {
    return convertRefSchema(schema["$ref"], schema, opts, ctx);
  }
  if ("const" in schema && schema["const"] !== undefined) {
    return convertConstSchema(schema["const"], opts);
  }
  if (Array.isArray(schema["enum"])) {
    return convertEnumSchema(schema, opts);
  }
  return null;
}

const EXPLICIT_SCHEMA_TYPE_KEYS = [
  "type",
  "$ref",
  "const",
  "enum",
  "oneOf",
  "anyOf",
  "allOf",
] as const;

function inheritCombinatorType(sub: unknown, rawType: unknown): Record<string, unknown> {
  if (!isPlainObject(sub)) {
    return sub as Record<string, unknown>;
  }
  if (
    typeof rawType === "string" &&
    EXPLICIT_SCHEMA_TYPE_KEYS.every((key) => sub[key] === undefined)
  ) {
    return { type: rawType, ...sub };
  }
  return sub;
}

function wrapCombinatorMembers(
  members: TSchema[],
  opts: Record<string, unknown>,
  combine: (m: TSchema[]) => TSchema,
): TSchema {
  if (members.length === 0) return Type.Any(opts);
  if (members.length === 1) return withSchemaOptions(members[0]!, opts);
  return combine(members);
}

function convertCombinatorSchema(
  schema: Record<string, unknown>,
  rawType: unknown,
  opts: Record<string, unknown>,
  ctx: ConversionContext,
): TSchema | undefined {
  if (Array.isArray(schema["oneOf"]) || Array.isArray(schema["anyOf"])) {
    const list = Array.isArray(schema["oneOf"])
      ? (schema["oneOf"] as unknown[])
      : (schema["anyOf"] as unknown[]);
    const members = orderUnionMembers(
      list.map((sub) =>
        convertJsonSchemaToTypebox(
          inheritCombinatorType(sub, rawType),
          ctx.rootDefs,
          ctx.effectiveRoot,
          ctx.seenRefs,
        ),
      ),
    );
    return wrapCombinatorMembers(members, opts, (m) => Type.Union(m, opts));
  }

  if (Array.isArray(schema["allOf"])) {
    const members = (schema["allOf"] as unknown[]).map((sub) =>
      convertJsonSchemaToTypebox(
        inheritCombinatorType(sub, rawType),
        ctx.rootDefs,
        ctx.effectiveRoot,
        ctx.seenRefs,
      ),
    );
    return wrapCombinatorMembers(members, opts, (m) => Type.Intersect(m, opts));
  }

  return undefined;
}

function convertMultiTypeSchema(
  schema: Record<string, unknown>,
  rawType: readonly unknown[],
  opts: Record<string, unknown>,
  ctx: ConversionContext,
): TSchema {
  const typeList = rawType.filter((t): t is string => typeof t === "string");
  const hasNull = typeList.includes("null");
  const nonNull = typeList.filter((t) => t !== "null");

  if (nonNull.length === 0) {
    return hasNull ? Type.Null(opts) : Type.Any(opts);
  }
  if (nonNull.length === 1) {
    const inner = convertJsonSchemaToTypebox(
      { ...schema, type: nonNull[0] },
      ctx.rootDefs,
      ctx.effectiveRoot,
      ctx.seenRefs,
    );
    return hasNull ? Type.Union(orderUnionMembers([Type.Null(), inner]), opts) : inner;
  }
  const members: TSchema[] = nonNull.map((t) =>
    convertJsonSchemaToTypebox(
      { ...schema, type: t },
      ctx.rootDefs,
      ctx.effectiveRoot,
      ctx.seenRefs,
    ),
  );
  if (hasNull) {
    members.unshift(Type.Null());
  }
  return Type.Union(orderUnionMembers(members), opts);
}

function convertArraySchema(
  schema: Record<string, unknown>,
  opts: Record<string, unknown>,
  ctx: ConversionContext,
): TSchema {
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
          ctx.rootDefs,
          ctx.effectiveRoot,
          ctx.seenRefs,
        ),
      ),
      opts,
    );
  }
  const items = schema["items"];
  return Type.Array(
    isPlainObject(items)
      ? convertJsonSchemaToTypebox(
          items,
          ctx.rootDefs,
          ctx.effectiveRoot,
          ctx.seenRefs,
        )
      : Type.Unknown(),
    opts,
  );
}

function mergeAllOfSubSchema(
  sub: unknown,
  rawProperties: Record<string, unknown>,
  required: Set<string>,
  ctx: ConversionContext,
): void {
  if (!isPlainObject(sub)) {
    return;
  }
  const resolvedSub =
    typeof sub["$ref"] === "string" && !ctx.seenRefs.has(sub["$ref"])
      ? (resolveRefTarget(sub["$ref"], ctx.rootDefs, ctx.effectiveRoot) ?? sub)
      : sub;

  const props = resolvedSub["properties"];
  if (isPlainObject(props)) {
    for (const [k, v] of Object.entries(props)) {
      if (!(k in rawProperties)) {
        rawProperties[k] = v;
      }
    }
  }

  const req = resolvedSub["required"];
  if (Array.isArray(req)) {
    for (const reqKey of req) {
      if (typeof reqKey === "string") {
        required.add(reqKey);
      }
    }
  }
}

function convertObjectSchema(
  schema: Record<string, unknown>,
  opts: Record<string, unknown>,
  ctx: ConversionContext,
): TSchema {
  const rawProperties: Record<string, unknown> = isPlainObject(schema["properties"])
    ? { ...schema["properties"] }
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
        ctx.rootDefs,
        ctx.effectiveRoot,
        ctx.seenRefs,
      ),
    );
    for (const sub of schema["allOf"] as unknown[]) {
      mergeAllOfSubSchema(sub, rawProperties, required, ctx);
    }
  }

  const props: Record<string, TSchema> = {};
  for (const [key, value] of Object.entries(rawProperties)) {
    const converted = convertJsonSchemaToTypebox(
      value as Record<string, unknown>,
      ctx.rootDefs,
      ctx.effectiveRoot,
      ctx.seenRefs,
    );
    props[key] = required.has(key) ? converted : Type.Optional(converted);
  }

  const objOpts: Record<string, unknown> = { ...opts };
  if (typeof additionalProperties === "boolean") {
    objOpts["additionalProperties"] = additionalProperties;
  } else if (isPlainObject(additionalProperties)) {
    objOpts["additionalProperties"] = convertJsonSchemaToTypebox(
      additionalProperties,
      ctx.rootDefs,
      ctx.effectiveRoot,
      ctx.seenRefs,
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
          ctx.rootDefs,
          ctx.effectiveRoot,
          ctx.seenRefs,
        ),
      ),
    );
  }
  if (Array.isArray(schema["anyOf"])) {
    objOpts["anyOf"] = orderUnionMembers(
      (schema["anyOf"] as unknown[]).map((sub) =>
        convertJsonSchemaToTypebox(
          sub as Record<string, unknown>,
          ctx.rootDefs,
          ctx.effectiveRoot,
          ctx.seenRefs,
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

const PRIMITIVE_FACTORIES: Record<string, (opts: Record<string, unknown>) => TSchema> = {
  string: Type.String,
  number: Type.Number,
  integer: Type.Integer,
  boolean: Type.Boolean,
  null: Type.Null,
};

function convertTypedSchema(
  type: string | undefined,
  schema: Record<string, unknown>,
  opts: Record<string, unknown>,
  ctx: ConversionContext,
): TSchema {
  if (type && type in PRIMITIVE_FACTORIES) {
    return PRIMITIVE_FACTORIES[type]!(opts);
  }
  if (type === "array") {
    return convertArraySchema(schema, opts, ctx);
  }
  if (type === "object") {
    return convertObjectSchema(schema, opts, ctx);
  }
  return Type.Any(opts);
}

function resolveNonTypedSchema(
  schema: Record<string, unknown>,
  opts: Record<string, unknown>,
  ctx: ConversionContext,
): TSchema | null {
  const preType = convertPreTypeSchema(schema, opts, ctx);
  if (preType) {
    return preType;
  }
  const rawType = schema["type"];
  if (Array.isArray(rawType)) {
    return convertMultiTypeSchema(schema, rawType, opts, ctx);
  }
  if (
    !hasObjectSchemaKeywords(schema) &&
    !hasArraySchemaKeywords(schema) &&
    rawType !== "object" &&
    rawType !== "array"
  ) {
    return convertCombinatorSchema(schema, rawType, opts, ctx) ?? null;
  }
  return null;
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
  if (!isPlainObject(schema)) {
    return Type.Any();
  }

  const effectiveRoot = rootSchema ?? schema;
  const opts = extractSchemaOptions(schema);

  // Extract $defs / definitions for $ref resolution (carried through recursive calls)
  const localDefs = (schema["$defs"] ?? schema["definitions"]) as
    | Record<string, Record<string, unknown>>
    | undefined;
  const rootDefs: Record<string, Record<string, unknown>> = {
    ...(isPlainObject(localDefs) ? localDefs : {}),
    ...defs,
  };

  const ctx: ConversionContext = { rootDefs, effectiveRoot, seenRefs };
  const nonTyped = resolveNonTypedSchema(schema, opts, ctx);
  if (nonTyped) {
    return nonTyped;
  }

  const rawType = schema["type"];
  const type =
    typeof rawType === "string"
      ? rawType
      : hasObjectSchemaKeywords(schema)
        ? "object"
        : hasArraySchemaKeywords(schema)
          ? "array"
          : undefined;

  return convertTypedSchema(type, schema, opts, ctx);
}
