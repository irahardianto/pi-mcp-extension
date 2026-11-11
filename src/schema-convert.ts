/**
 * Pure MCP JSON Schema → TypeBox conversion for pi-mcp.
 */

import * as Type from "typebox";
import type { TSchema } from "typebox";
import {
  collectObjectSchemaMembers,
  inferSchemaType,
  inheritCombinatorType,
  isPlainObject,
  tupleRestKeyword,
  type ConversionContext,
} from "./schema-allof.js";
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

/**
 * Convert one tuple rest schema (an object schema or a boolean) to a TypeBox schema.
 * Any other value (`undefined`, `null`, a number, a string, an array) is not a schema
 * keyword: later positions stay unconstrained instead of inheriting the closed default.
 */
function convertTupleRestSchema(rest: unknown, ctx: ConversionContext): TSchema | boolean {
  if (typeof rest === "boolean") {
    return rest;
  }
  if (isPlainObject(rest)) {
    return convertJsonSchemaToTypebox(rest, ctx.rootDefs, ctx.effectiveRoot, ctx.seenRefs);
  }
  return true;
}

/**
 * Add a tuple's rest schema to its TypeBox options as `additionalItems`.
 * WHY: `Type.Tuple` forces `additionalItems: false`, so a variadic tuple such as
 * `{ prefixItems: [{ type: "string" }], items: { type: "integer" } }` (`[string, ...integer[]]`)
 * rejects every rest element with `schema is false` in Pi's `validateToolArguments`.
 * TypeBox types `TTuple.additionalItems` as the literal `false` and `Type.TupleOptions()`
 * drops the key, so this override is runtime-only: any `Type.Instantiate`-style rebuild of a
 * tuple loses it and has to re-apply it. The rest schema is also validated but never
 * `Value.Convert`-coerced — TypeBox's tuple converter only visits the declared positions —
 * so `["ls", "1"]` stays a string and is rejected where a plain array would coerce it.
 */
function withTupleRestSchema(
  rest: unknown,
  opts: Record<string, unknown>,
  ctx: ConversionContext,
): Record<string, unknown> {
  return { ...opts, additionalItems: convertTupleRestSchema(rest, ctx) };
}

function convertArraySchema(
  schema: Record<string, unknown>,
  opts: Record<string, unknown>,
  ctx: ConversionContext,
): TSchema {
  const prefixItems = Array.isArray(schema["prefixItems"])
    ? (schema["prefixItems"] as unknown[])
    : undefined;
  const tupleItems =
    prefixItems ?? (Array.isArray(schema["items"]) ? (schema["items"] as unknown[]) : undefined);
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
      withTupleRestSchema(tupleRestKeyword(prefixItems !== undefined, schema), opts, ctx),
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

function convertObjectSchema(
  schema: Record<string, unknown>,
  opts: Record<string, unknown>,
  ctx: ConversionContext,
): TSchema {
  const merge = collectObjectSchemaMembers(schema, ctx);
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
  }

  const props: Record<string, TSchema> = {};
  for (const [key, entry] of Object.entries(merge.properties)) {
    const converted = convertJsonSchemaToTypebox(
      entry.schema,
      ctx.rootDefs,
      ctx.effectiveRoot,
      entry.seenRefs,
    );
    props[key] = merge.required.has(key) ? converted : Type.Optional(converted);
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

  if (merge.required.size > 0) {
    objOpts["required"] = Array.from(merge.required);
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
  return null;
}

/**
 * Convert a JSON Schema object to a TypeBox schema.
 * Handles the common subset used by real-world MCP servers:
 *   - Primitives (string, number, integer, boolean, null)
 *   - Arrays, tuples (prefixItems / array items, with a variadic `items` after
 *     `prefixItems` or `additionalItems` after a draft-07 tuple), objects
 *     (with required/optional/additionalProperties)
 *   - Enums and const (string, numeric, boolean, and nullable enums → Union of Literals)
 *   - Nullable and multi-type arrays ("type": ["string", "null"]) with Type.Null() ordered first
 *   - Cycle-safe $ref (#, #/$defs/, #/definitions/, and arbitrary RFC 6901 JSON Pointers)
 *   - oneOf / anyOf → TypeBox Union
 *   - allOf → TypeBox Intersect; when it composes object sub-schemas or `$ref`s to
 *     object definitions, an object schema with merged `properties` / `required`
 *     (recursing through nested `allOf` and chained `$ref`s) that keeps the members
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

  const type = inferSchemaType(schema, ctx);
  if (type !== "object" && type !== "array") {
    const combinator = convertCombinatorSchema(schema, type, opts, ctx);
    if (combinator) {
      return combinator;
    }
  }

  return convertTypedSchema(type, schema, opts, ctx);
}
