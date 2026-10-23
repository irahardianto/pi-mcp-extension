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
  const clone = Object.defineProperties<TSchema>({}, Object.getOwnPropertyDescriptors(schema));
  return Object.assign(clone, opts);
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
    case undefined:
    default:
      return Type.Any(opts);
  }
}
