import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectObjectSchemaMembers,
  hasObjectSchemaShape,
  inferSchemaType,
  inheritCombinatorType,
  isPlainObject,
  mergeAllOfSubSchema,
  tupleRestKeyword,
  type AllOfMerge,
  type ConversionContext,
} from "../src/schema-allof.js";

function makeContext(
  effectiveRoot: Record<string, unknown> = {},
  rootDefs: Record<string, Record<string, unknown>> = {},
  seenRefs: ReadonlySet<string> = new Set(),
): ConversionContext {
  return { rootDefs, effectiveRoot, seenRefs };
}

describe("schema-allof pure raw JSON Schema helpers", () => {
  it("stays free of typebox and schema-convert imports", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../src/schema-allof.ts"), "utf8");
    assert.doesNotMatch(source, /["']typebox(?:\/|["'])/);
    assert.doesNotMatch(source, /["']\.\/schema-convert(?:\.[jt]s)?["']/);
  });

  it("identifies plain objects and rejects primitives, null, and arrays", () => {
    assert.equal(isPlainObject({ a: 1 }), true);
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject(["a"]), false);
    assert.equal(isPlainObject("string"), false);
    assert.equal(isPlainObject(undefined), false);
  });

  it("detects object schema shape from direct keywords, nested allOf, and cycle-safe $ref chains", () => {
    const emptyCtx = makeContext();
    assert.equal(hasObjectSchemaShape({ properties: { id: { type: "string" } } }, emptyCtx), true);
    assert.equal(hasObjectSchemaShape({ required: ["id"] }, emptyCtx), true);
    assert.equal(hasObjectSchemaShape({ additionalProperties: false }, emptyCtx), true);
    assert.equal(hasObjectSchemaShape({ minProperties: 1 }, emptyCtx), true);
    assert.equal(hasObjectSchemaShape({ maxProperties: 5 }, emptyCtx), true);
    assert.equal(hasObjectSchemaShape({ type: "string" }, emptyCtx), false);

    const defs: Record<string, Record<string, unknown>> = {
      Base: { $ref: "#/$defs/Leaf" },
      Leaf: { properties: { name: { type: "string" } } },
      CycleA: { allOf: [{ $ref: "#/$defs/CycleB" }] },
      CycleB: { allOf: [{ $ref: "#/$defs/CycleA" }] },
      Scalar: { type: "number" },
    };
    const root = { $defs: defs };
    const ctx = makeContext(root, defs);

    assert.equal(
      hasObjectSchemaShape({ allOf: [{ allOf: [{ $ref: "#/$defs/Base" }] }] }, ctx),
      true,
    );
    assert.equal(
      hasObjectSchemaShape({ allOf: [{ $ref: "#/$defs/CycleA" }, { $ref: "#/$defs/Scalar" }] }, ctx),
      false,
    );
    assert.equal(
      hasObjectSchemaShape({ allOf: [{ $ref: "#/$defs/Missing" }] }, ctx),
      false,
    );
    assert.equal(
      hasObjectSchemaShape(
        { allOf: [{ $ref: "#/$defs/CycleA" }, { $ref: "#/$defs/Base" }] },
        ctx,
      ),
      true,
    );
    assert.equal(
      hasObjectSchemaShape(
        { allOf: [{ $ref: "#/$defs/Base" }] },
        makeContext(root, defs, new Set(["#/$defs/Base"])),
      ),
      false,
    );
  });

  it("inherits combinator rawType only when sub-schema has no explicit type or combinator key", () => {
    assert.deepEqual(inheritCombinatorType({ minLength: 2 }, "string"), {
      type: "string",
      minLength: 2,
    });
    assert.deepEqual(inheritCombinatorType({ type: "number", minimum: 0 }, "string"), {
      type: "number",
      minimum: 0,
    });
    assert.deepEqual(inheritCombinatorType({ $ref: "#/$defs/Item" }, "string"), {
      $ref: "#/$defs/Item",
    });
    assert.deepEqual(inheritCombinatorType({ enum: ["a", "b"] }, "string"), {
      enum: ["a", "b"],
    });
    assert.deepEqual(inheritCombinatorType({ minLength: 2 }, undefined), {
      minLength: 2,
    });
    assert.equal(inheritCombinatorType(null, "string"), null);
  });

  it("selects the tuple rest keyword for Draft 2020-12 prefixItems vs Draft-07 array items", () => {
    const restSchema = { type: "integer" };
    assert.equal(
      tupleRestKeyword(true, { prefixItems: [{ type: "string" }], items: restSchema }),
      restSchema,
    );
    assert.equal(
      tupleRestKeyword(true, { prefixItems: [{ type: "string" }], additionalItems: false }),
      false,
    );
    assert.equal(
      tupleRestKeyword(false, {
        items: [{ type: "string" }],
        additionalItems: restSchema,
      }),
      restSchema,
    );
    assert.equal(tupleRestKeyword(false, { items: [{ type: "string" }] }), undefined);
  });

  it("infers schema type from explicit type, object shape, or array keywords", () => {
    const ctx = makeContext();
    assert.equal(inferSchemaType({ type: "boolean" }, ctx), "boolean");
    assert.equal(inferSchemaType({ properties: { x: { type: "number" } } }, ctx), "object");
    assert.equal(inferSchemaType({ items: { type: "string" } }, ctx), "array");
    assert.equal(inferSchemaType({ prefixItems: [{ type: "string" }] }, ctx), "array");
    assert.equal(inferSchemaType({ description: "untyped" }, ctx), undefined);
  });

  it("flattens object and allOf properties/required with precedence and per-property seenRefs", () => {
    const defs: Record<string, Record<string, unknown>> = {
      Parent: {
        properties: {
          id: { type: "integer" },
          inherited: { type: "string" },
        },
        required: ["id", "inherited", 42 as unknown as string],
        allOf: [{ $ref: "#/$defs/GrandParent" }, { $ref: "#/$defs/Parent" }],
      },
      GrandParent: {
        properties: {
          inherited: { type: "number" },
          rootProp: { type: "boolean" },
        },
        required: ["rootProp"],
      },
    };
    const root = { $defs: defs };
    const ctx = makeContext(root, defs, new Set(["#/$defs/Initial"]));

    const merged = collectObjectSchemaMembers(
      {
        properties: {
          id: { type: "string" },
        },
        required: ["topReq"],
        allOf: [
          "not-an-object",
          { $ref: "#/$defs/Missing" },
          { $ref: "#/$defs/Parent" },
          {
            allOf: [
              {
                properties: { inlineProp: { type: "array" } },
                required: ["inlineProp"],
              },
            ],
          },
        ],
      },
      ctx,
    );

    assert.deepEqual(merged.properties["id"]?.schema, { type: "string" });
    assert.deepEqual([...(merged.properties["id"]?.seenRefs ?? [])], ["#/$defs/Initial"]);

    assert.deepEqual(merged.properties["inherited"]?.schema, { type: "string" });
    assert.deepEqual([...(merged.properties["inherited"]?.seenRefs ?? [])], [
      "#/$defs/Initial",
      "#/$defs/Parent",
    ]);

    assert.deepEqual(merged.properties["rootProp"]?.schema, { type: "boolean" });
    assert.deepEqual([...(merged.properties["rootProp"]?.seenRefs ?? [])], [
      "#/$defs/Initial",
      "#/$defs/Parent",
      "#/$defs/GrandParent",
    ]);

    assert.deepEqual(merged.properties["inlineProp"]?.schema, { type: "array" });
    assert.deepEqual(
      new Set(merged.required),
      new Set(["topReq", "id", "inherited", "rootProp", "inlineProp"]),
    );

    // Direct mergeAllOfSubSchema call on a non-object is a no-op
    const emptyAccumulator: AllOfMerge = {
      properties: {},
      required: new Set(),
      visitedRefs: new Set(),
    };
    mergeAllOfSubSchema(null, emptyAccumulator, ctx);
    assert.deepEqual(emptyAccumulator.properties, {});
    assert.equal(emptyAccumulator.required.size, 0);
  });

  it("preserves Object.prototype property names as own enumerable properties in collectObjectSchemaMembers and mergeAllOfSubSchema (#330)", () => {
    const protoKeys = [
      "toString",
      "constructor",
      "valueOf",
      "hasOwnProperty",
      "prototype",
      "__proto__",
    ] as const;

    const rawSchema = JSON.parse(`{
      "type": "object",
      "$defs": {
        "Mixin": {
          "properties": {
            "toString": { "type": "number" },
            "constructor": { "type": "number" },
            "valueOf": { "type": "boolean" },
            "hasOwnProperty": { "type": "string" },
            "prototype": { "type": "string" },
            "__proto__": { "type": "boolean" }
          },
          "required": ["constructor", "__proto__"]
        }
      },
      "properties": {
        "toString": { "type": "string" },
        "normal": { "type": "string" }
      },
      "required": ["toString"],
      "allOf": [{ "$ref": "#/$defs/Mixin" }]
    }`) as Record<string, unknown>;

    const defs = rawSchema["$defs"] as Record<string, Record<string, unknown>>;
    const ctx = makeContext(rawSchema, defs);
    const merged = collectObjectSchemaMembers(rawSchema, ctx);

    assert.equal(Object.getPrototypeOf(merged.properties), null);
    for (const key of protoKeys) {
      assert.equal(
        Object.hasOwn(merged.properties, key),
        true,
        `Expected own property "${key}" in merged.properties`,
      );
    }
    assert.equal(Object.hasOwn(merged.properties, "normal"), true);
    // Own-property precedence: top-level `toString` ({ type: "string" }) beats Mixin ({ type: "number" })
    assert.deepEqual(merged.properties["toString"]?.schema, { type: "string" });
    assert.deepEqual(merged.properties["constructor"]?.schema, { type: "number" });
    assert.deepEqual(merged.properties["__proto__"]?.schema, { type: "boolean" });
    assert.deepEqual(new Set(merged.required), new Set(["toString", "constructor", "__proto__"]));

    // Direct mergeAllOfSubSchema call with a caller-supplied `{}` accumulator must also preserve `__proto__`
    // as an own enumerable data property without mutating the accumulator's prototype.
    const plainAcc: AllOfMerge = {
      properties: {},
      required: new Set(),
      visitedRefs: new Set(),
    };
    const subSchema = JSON.parse('{"properties":{"__proto__":{"type":"boolean"},"toString":{"type":"string"}}}') as Record<
      string,
      unknown
    >;
    mergeAllOfSubSchema(subSchema, plainAcc, ctx);
    assert.equal(Object.getPrototypeOf(plainAcc.properties), Object.prototype);
    assert.equal(Object.hasOwn(plainAcc.properties, "__proto__"), true);
    assert.equal(Object.hasOwn(plainAcc.properties, "toString"), true);
    assert.deepEqual(plainAcc.properties["__proto__"]?.schema, { type: "boolean" });
  });
});
