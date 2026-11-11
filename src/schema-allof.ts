/**
 * Pure raw JSON Schema shape inference and `allOf` property/`required` flattening for pi-mcp.
 */

import { resolveRefTarget } from "./schema-refs.js";

// ─── Raw JSON Schema Context & Accumulators ───────────────────────────────────

export interface ConversionContext {
  rootDefs: Record<string, Record<string, unknown>>;
  effectiveRoot: Record<string, unknown>;
  seenRefs: ReadonlySet<string>;
}

/** A property schema paired with the `$ref` path that was dereferenced to reach it. */
export interface MergedProperty {
  schema: Record<string, unknown>;
  seenRefs: ReadonlySet<string>;
}

/** Accumulates flattened `allOf` contributions plus the refs already walked. */
export interface AllOfMerge {
  properties: Record<string, MergedProperty>;
  required: Set<string>;
  visitedRefs: Set<string>;
}

// ─── Raw JSON Schema Shape & Keyword Inference ────────────────────────────────

export function isPlainObject(val: unknown): val is Record<string, unknown> {
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

/** Whether `ref` is already on the active resolution path. */
function isRefSeenOnPath(
  ref: string,
  ctx: ConversionContext,
  extraRefs: ReadonlySet<string>,
): boolean {
  return ctx.seenRefs.has(ref) || extraRefs.has(ref);
}

/** Whether a `$ref` on an `allOf` member resolves to an object-like schema. */
function isRefToObjectSchema(
  ref: unknown,
  ctx: ConversionContext,
  seenRefs: Set<string>,
): boolean {
  if (typeof ref !== "string" || isRefSeenOnPath(ref, ctx, seenRefs)) {
    return false;
  }
  seenRefs.add(ref);
  const resolved = resolveRefTarget(ref, ctx.rootDefs, ctx.effectiveRoot);
  return resolved ? isObjectLikeSubSchema(resolved, ctx, seenRefs) : false;
}

/** Whether a sub-schema describes an object directly, through a `$ref`, or through a nested `allOf`. */
function isObjectLikeSubSchema(
  sub: Record<string, unknown>,
  ctx: ConversionContext,
  seenRefs: Set<string>,
): boolean {
  return (
    sub["type"] === "object" ||
    hasObjectSchemaKeywords(sub) ||
    hasAllOfObjectSubSchema(sub, ctx, seenRefs) ||
    isRefToObjectSchema(sub["$ref"], ctx, seenRefs)
  );
}

/**
 * Whether `allOf` composes object sub-schemas / `$ref`s to object definitions.
 * WHY: JSON Schema generators (Pydantic, FastAPI, OpenAPI 3.0) omit `type: "object"`
 * on the `allOf` wrapper. Without object inference the schema becomes a bare
 * `Type.Intersect`, which has no `properties` — Pi's `normalizeOptionalNulls` then
 * skips it (coercing optional `null`s into `"null"` / `0` / `false`) and Anthropic's
 * adapter sends an empty `input_schema`.
 */
function hasAllOfObjectSubSchema(
  schema: Record<string, unknown>,
  ctx: ConversionContext,
  seenRefs: Set<string> = new Set<string>(),
): boolean {
  const allOf = schema["allOf"];
  if (!Array.isArray(allOf)) {
    return false;
  }
  return allOf.some((sub) => isPlainObject(sub) && isObjectLikeSubSchema(sub, ctx, seenRefs));
}

export function hasObjectSchemaShape(
  schema: Record<string, unknown>,
  ctx: ConversionContext,
): boolean {
  return hasObjectSchemaKeywords(schema) || hasAllOfObjectSubSchema(schema, ctx);
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

export function inheritCombinatorType(sub: unknown, rawType: unknown): Record<string, unknown> {
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

/**
 * The rest keyword of a tuple: 2020-12 `items` after `prefixItems` (falling back to a legacy
 * sibling `additionalItems`), or draft-07 `additionalItems` after an array `items`.
 * WHY: both drafts leave later positions unconstrained when that keyword is absent, while
 * `Type.Tuple` defaults to `additionalItems: false` — which would reject every rest element
 * with the same `schema is false` failure this conversion exists to prevent. A tuple is closed
 * only when the source schema says so (`items: false` / `additionalItems: false`).
 */
export function tupleRestKeyword(
  hasPrefixItems: boolean,
  schema: Record<string, unknown>,
): unknown {
  if (!hasPrefixItems) {
    return schema["additionalItems"];
  }
  return schema["items"] ?? schema["additionalItems"];
}

export function inferSchemaType(
  schema: Record<string, unknown>,
  ctx: ConversionContext,
): string | undefined {
  const rawType = schema["type"];
  if (typeof rawType === "string") {
    return rawType;
  }
  if (hasObjectSchemaShape(schema, ctx)) {
    return "object";
  }
  if (hasArraySchemaKeywords(schema)) {
    return "array";
  }
  return undefined;
}

// ─── Recursive `allOf` Raw Property & `required` Flattening ───────────────────

/** Merge a sub-schema's properties without overwriting properties declared by the caller. */
function mergeSubSchemaProperties(
  props: unknown,
  mergedProperties: Record<string, MergedProperty>,
  seenRefs: ReadonlySet<string>,
): void {
  if (!isPlainObject(props)) {
    return;
  }
  for (const [key, value] of Object.entries(props)) {
    if (!(key in mergedProperties)) {
      mergedProperties[key] = {
        schema: value as Record<string, unknown>,
        seenRefs,
      };
    }
  }
}

/** Merge a sub-schema's `required` names into the caller's required set. */
function mergeSubSchemaRequired(req: unknown, required: Set<string>): void {
  if (!Array.isArray(req)) {
    return;
  }
  for (const reqKey of req) {
    if (typeof reqKey === "string") {
      required.add(reqKey);
    }
  }
}

/**
 * Follow an `allOf` member's `$ref` if not yet visited, recording `ref` on the active
 * resolution path for any properties inherited from the referenced definition.
 * WHY: generators chain definitions (`A: { $ref: B }`) and emit recursive fields wrapped
 * in `allOf: [{ $ref: "#/$defs/Node" }]`; carrying `nextActiveRefs` onto inherited
 * properties ensures `convertJsonSchemaToTypebox` breaks `$ref` cycles on inlined fields.
 */
function mergeAllOfRef(
  ref: unknown,
  merge: AllOfMerge,
  ctx: ConversionContext,
  activeRefs: ReadonlySet<string>,
): void {
  if (typeof ref !== "string" || isRefSeenOnPath(ref, ctx, merge.visitedRefs)) {
    return;
  }
  merge.visitedRefs.add(ref);
  const resolved = resolveRefTarget(ref, ctx.rootDefs, ctx.effectiveRoot);
  if (!resolved) {
    return;
  }
  const nextActiveRefs = new Set(activeRefs);
  nextActiveRefs.add(ref);
  mergeAllOfSubSchema(resolved, merge, ctx, nextActiveRefs);
}

/** Merge one `allOf` member (and every `$ref` or nested `allOf` beneath it) into the accumulator. */
export function mergeAllOfSubSchema(
  sub: unknown,
  merge: AllOfMerge,
  ctx: ConversionContext,
  activeRefs: ReadonlySet<string> = ctx.seenRefs,
): void {
  if (!isPlainObject(sub)) {
    return;
  }
  mergeSubSchemaProperties(sub["properties"], merge.properties, activeRefs);
  mergeSubSchemaRequired(sub["required"], merge.required);
  mergeAllOfRef(sub["$ref"], merge, ctx, activeRefs);
  const nested = sub["allOf"];
  if (Array.isArray(nested)) {
    for (const nestedSub of nested) {
      mergeAllOfSubSchema(nestedSub, merge, ctx, activeRefs);
    }
  }
}

/**
 * Collect an object schema's own `properties` and `required` names plus any flattened
 * `allOf` sub-schema members (recursing through nested `allOf` and `$ref` definitions).
 */
export function collectObjectSchemaMembers(
  schema: Record<string, unknown>,
  ctx: ConversionContext,
): AllOfMerge {
  const merge: AllOfMerge = {
    properties: {},
    required: new Set<string>(),
    visitedRefs: new Set<string>(),
  };
  mergeSubSchemaRequired(schema["required"], merge.required);
  mergeSubSchemaProperties(schema["properties"], merge.properties, ctx.seenRefs);
  if (Array.isArray(schema["allOf"])) {
    for (const sub of schema["allOf"] as unknown[]) {
      mergeAllOfSubSchema(sub, merge, ctx);
    }
  }
  return merge;
}
