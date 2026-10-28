/**
 * Unit tests for src/tool-bridge.ts
 * Tests schema conversion, tool naming, content conversion, and bridge logic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError as SdkMcpError } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { McpError } from "../src/errors.js";
import type { TSchema } from "typebox";
import { convertJsonSchemaToTypebox } from "../src/schema-convert.js";
import { listAllTools } from "../src/tool-discovery.js";
import {
  buildToolName,
  convertMcpContent,
  ToolBridge,
} from "../src/tool-bridge.js";

type SchemaTuple = [SchemaJson, SchemaJson, SchemaJson, SchemaJson, ...SchemaJson[]];
type SchemaProps = Record<
  | "name"
  | "age"
  | "address"
  | "city"
  | "zip"
  | "str"
  | "num"
  | "int"
  | "bool"
  | "anyOfStr"
  | "oneOfInt"
  | "filter"
  | "mode"
  | "id"
  | "email"
  | "actor"
  | "host"
  | "limit"
  | "tag"
  | "next"
  | "value"
  | "start"
  | "b"
  | "count"
  | "self"
  | "left"
  | "right"
  | "mirrorId"
  | "containerChild"
  | "escapedRef"
  | "protoRef",
  SchemaJson
> &
  Record<string, SchemaJson>;

interface SchemaJson extends TSchema {
  type?: string;
  description?: string;
  title?: string;
  default?: unknown;
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
  const?: unknown;
  required?: string[];
  properties: SchemaProps;
  patternProperties?: Record<string, SchemaJson>;
  additionalProperties: SchemaJson;
  items: SchemaJson & SchemaTuple;
  anyOf: SchemaTuple;
  oneOf: SchemaTuple;
  allOf: SchemaTuple;
}

type TestToolDefinition = Omit<ToolDefinition, "description" | "execute"> & {
  description: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => ReturnType<ToolDefinition["execute"]>;
};

// ── Schema Conversion ─────────────────────────────────────────────────────────

describe("convertJsonSchemaToTypebox", () => {
  it("converts string type", () => {
    const schema = convertJsonSchemaToTypebox({ type: "string" }) as SchemaJson;
    assert.equal(schema.type, "string");
  });

  it("converts string with description", () => {
    const schema = convertJsonSchemaToTypebox({
      type: "string",
      description: "A name",
    }) as SchemaJson;
    assert.equal(schema.description, "A name");
  });

  it("converts string enum to Union of Literals", () => {
    const schema = convertJsonSchemaToTypebox({
      type: "string",
      enum: ["json", "text", "yaml"],
    }) as SchemaJson;
    assert.ok(schema.anyOf, "Should be a Union (anyOf)");
    assert.equal(schema.anyOf.length, 3);
    assert.equal(schema.anyOf[0].const, "json");
    assert.equal(schema.anyOf[1].const, "text");
    assert.equal(schema.anyOf[2].const, "yaml");
  });

  it("converts number type", () => {
    const schema = convertJsonSchemaToTypebox({ type: "number" }) as SchemaJson;
    assert.equal(schema.type, "number");
  });

  it("converts integer as Integer", () => {
    const schema = convertJsonSchemaToTypebox({ type: "integer" }) as SchemaJson;
    assert.equal(schema.type, "integer");
  });

  it("converts boolean type", () => {
    const schema = convertJsonSchemaToTypebox({ type: "boolean" }) as SchemaJson;
    assert.equal(schema.type, "boolean");
  });

  it("converts array type", () => {
    const schema = convertJsonSchemaToTypebox({
      type: "array",
      items: { type: "string" },
    }) as SchemaJson;
    assert.equal(schema.type, "array");
  });

  it("converts object type with required and optional properties", () => {
    const schema = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    }) as SchemaJson;
    assert.ok(schema.properties, "Should have properties");
    // TypeBox (Pi's version) expresses optionality via the `required` array,
    // not via Symbol modifiers. 'name' is required, 'age' is optional.
    assert.ok(schema.required?.includes("name"), "'name' should be in required[]");
    assert.ok(!schema.required?.includes("age"), "'age' should NOT be in required[]");
  });

  it("converts nested objects recursively", () => {
    const schema = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        address: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
      required: ["address"],
    }) as SchemaJson;
    assert.ok(schema.properties, "Should have properties");
    const inner = schema.properties.address;
    assert.ok(inner.properties, "Nested object should have properties");
  });

  it("falls back to Any for unknown type", () => {
    const schema = convertJsonSchemaToTypebox({ type: "unknown-type" }) as SchemaJson;
    // Any schema has no specific type field — check it doesn't throw and returns object
    assert.ok(typeof schema === "object");
  });

  it("converts oneOf to Union", () => {
    const schema = convertJsonSchemaToTypebox({
      oneOf: [{ type: "string" }, { type: "number" }],
    }) as SchemaJson;
    assert.ok(schema.anyOf, "oneOf should produce a Union (anyOf)");
    assert.equal(schema.anyOf.length, 2);
    assert.equal(schema.anyOf[0].type, "string");
    assert.equal(schema.anyOf[1].type, "number");
  });

  it("converts anyOf to Union with Null ordered first", () => {
    const schema = convertJsonSchemaToTypebox({
      anyOf: [{ type: "boolean" }, { type: "null" }],
    }) as SchemaJson;
    assert.ok(schema.anyOf, "anyOf should produce a Union");
    assert.equal(schema.anyOf.length, 2);
    assert.equal(schema.anyOf[0].type, "null");
    assert.equal(schema.anyOf[1].type, "boolean");

    const withNonArrayOneOf = convertJsonSchemaToTypebox({
      oneOf: "invalid-non-array",
      anyOf: [{ type: "string" }, { type: "null" }],
    }) as SchemaJson;
    assert.equal(withNonArrayOneOf.anyOf.length, 2);
    assert.equal(withNonArrayOneOf.anyOf[0].type, "null");
    assert.equal(withNonArrayOneOf.anyOf[1].type, "string");
  });

  it("converts object-composing allOf to an object that keeps the Intersect members", () => {
    const schema = convertJsonSchemaToTypebox({
      allOf: [
        { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        { type: "object", properties: { age: { type: "number" } }, required: ["age"] },
      ],
    }) as SchemaJson;
    assert.equal(schema.type, "object");
    assert.equal(schema.properties.name.type, "string");
    assert.equal(schema.properties.age.type, "number");
    assert.deepEqual(schema.required, ["name", "age"]);
    assert.ok(schema.allOf, "allOf members are preserved (Intersect semantics)");
    assert.equal(schema.allOf.length, 2);
  });

  it("infers an object schema when allOf composes object sub-schemas or $refs without repeating type", async () => {
    const { validateToolArguments } = await import("@earendil-works/pi-ai");
    const defs = {
      Pagination: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1 },
          tag: { type: "string" },
        },
      },
    };
    const wrapper = {
      allOf: [
        { $ref: "#/$defs/Pagination" },
        { properties: { str: { type: "string" } }, required: ["str"] },
      ],
    };
    const implicit = convertJsonSchemaToTypebox({
      type: "object",
      properties: { filter: wrapper },
      required: ["filter"],
      $defs: defs,
    }) as SchemaJson;
    const filter = implicit.properties.filter;
    assert.equal(filter.type, "object", "allOf of objects must infer type: object");
    assert.equal(filter.properties.limit.type, "integer");
    assert.equal(filter.properties.limit.minimum, 1);
    assert.equal(filter.properties.tag.type, "string");
    assert.equal(filter.properties.str.type, "string");
    assert.deepEqual(filter.required, ["str"]);
    assert.ok(Array.isArray(filter.allOf), "allOf members are preserved");

    // End-to-end Pi validation: optional nulls inside the allOf-composed object are
    // stripped by normalizeOptionalNulls instead of coerced into 0 / "" by Value.Convert.
    const validated = validateToolArguments(
      { name: "search", description: "search", parameters: implicit },
      {
        type: "toolCall",
        id: "call_1",
        name: "search",
        arguments: { filter: { limit: null, tag: null, str: "hello" } },
      },
    );
    assert.deepEqual(validated, { filter: { str: "hello" } });

    // The wrapper converts identically whether or not it repeats `type: "object"`.
    const explicit = convertJsonSchemaToTypebox({
      type: "object",
      properties: { filter: { type: "object", ...wrapper } },
      required: ["filter"],
      $defs: defs,
    }) as SchemaJson;
    assert.deepEqual(filter, explicit.properties.filter);

    // A top-level allOf tool schema keeps `properties` for provider adapters that
    // build `input_schema` from `schema.properties`.
    const topLevel = convertJsonSchemaToTypebox({
      allOf: [{ $ref: "#/$defs/Pagination" }, { properties: { str: { type: "string" } } }],
      $defs: defs,
    }) as SchemaJson;
    assert.equal(topLevel.type, "object");
    assert.equal(topLevel.properties.limit.type, "integer");
    assert.equal(topLevel.properties.str.type, "string");
  });

  it("flattens nested allOf chains, chained $ref definitions, and sibling properties alongside $ref", () => {
    const schema = convertJsonSchemaToTypebox({
      allOf: [
        {
          allOf: [
            {
              $ref: "#/$defs/Base",
              properties: { str: { type: "string" } },
              required: ["str"],
            },
            { properties: { id: { type: "string" } }, required: ["id"] },
          ],
        },
        { properties: { mode: { type: "string" } } },
      ],
      $defs: {
        Base: { $ref: "#/$defs/Root" },
        Root: {
          type: "object",
          properties: { num: { type: "integer" } },
          required: ["num"],
        },
      },
    }) as SchemaJson;
    assert.equal(schema.type, "object");
    assert.equal(schema.properties.num.type, "integer");
    assert.equal(schema.properties.str.type, "string");
    assert.equal(schema.properties.id.type, "string");
    assert.equal(schema.properties.mode.type, "string");
    assert.deepEqual([...(schema.required ?? [])].sort(), ["id", "num", "str"]);
  });

  it("terminates on allOf $ref cycles (including recursive allOf-wrapped $ref properties) and leaves non-object allOf members as an Intersect", () => {
    const cyclic = convertJsonSchemaToTypebox({
      allOf: [{ $ref: "#/$defs/A" }],
      $defs: {
        A: { allOf: [{ $ref: "#/$defs/B" }] },
        B: { allOf: [{ $ref: "#/$defs/A" }, { properties: { id: { type: "string" } } }] },
      },
    }) as SchemaJson;
    assert.equal(cyclic.type, "object");
    assert.equal(cyclic.properties.id.type, "string");

    // Recursive Pydantic/OpenAPI field (`allOf: [{ $ref }]` inside merged properties)
    // and root `#` self-reference inside `allOf` must terminate without stack overflow.
    const recursiveNode = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        start: { allOf: [{ $ref: "#/$defs/Node" }] },
      },
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: {
              allOf: [{ $ref: "#/$defs/Node" }],
              description: "Next node in list",
            },
          },
        },
      },
    }) as SchemaJson;
    assert.equal(recursiveNode.properties.start.type, "object");
    assert.equal(recursiveNode.properties.start.properties.value.type, "string");
    assert.equal(recursiveNode.properties.start.properties.next.description, "Next node in list");

    const rootCyclicAllOf = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        self: { allOf: [{ $ref: "#" }] },
      },
    }) as SchemaJson;
    assert.equal(rootCyclicAllOf.type, "object");
    assert.equal(rootCyclicAllOf.properties.self.type, "object");

    // Junk members and unresolvable $refs are skipped, not fatal; sibling properties on an
    // unresolvable $ref member still infer an object schema.
    const mixed = convertJsonSchemaToTypebox({
      allOf: [
        "not-a-schema",
        { $ref: "#/$defs/Missing", properties: { id: { type: "string" } } },
      ],
    }) as SchemaJson;
    assert.equal(mixed.type, "object");
    assert.equal(mixed.properties.id.type, "string");

    const notObjects = convertJsonSchemaToTypebox({
      allOf: [{ type: "string" }, { minLength: 2 }],
    }) as SchemaJson;
    assert.equal(notObjects.type, undefined, "primitive allOf must stay a bare Intersect");
    assert.equal(notObjects.properties, undefined);
    assert.equal(notObjects.allOf.length, 2);
  });

  it("resolves $ref to #/$defs/", () => {
    const schema = convertJsonSchemaToTypebox({
      $ref: "#/$defs/MyString",
      $defs: { MyString: { type: "string" } },
    }) as SchemaJson;
    assert.equal(schema.type, "string", "$ref should resolve to the referenced type");
  });

  it("resolves $ref to #/definitions/", () => {
    const schema = convertJsonSchemaToTypebox({
      $ref: "#/definitions/Foo",
      definitions: { Foo: { type: "boolean" } },
    }) as SchemaJson;
    assert.equal(schema.type, "boolean");
  });

  it("resolves $ref with description passthrough", () => {
    const schema = convertJsonSchemaToTypebox({
      $ref: "#/$defs/Inner",
      description: "A description from the ref",
      $defs: { Inner: { type: "string" } },
    }) as SchemaJson;
    assert.equal(schema.type, "string");
    assert.equal(schema.description, "A description from the ref");
  });

  it("falls back to Any for unresolvable $ref", () => {
    const schema = convertJsonSchemaToTypebox({ $ref: "#/definitions/NonExistent" }) as SchemaJson;
    assert.ok(typeof schema === "object");
  });

  it("falls back to Any for external $ref", () => {
    const schema = convertJsonSchemaToTypebox({ $ref: "external-schema.json#/Foo" }) as SchemaJson;
    assert.ok(typeof schema === "object");
  });

  it("handles nullable types: {type: ['string', 'null']} with Null first to prevent Value.Convert coercion", async () => {
    const { Value } = await import("typebox/value");
    const schema = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        str: { type: ["string", "null"] },
        num: { type: ["number", "null"] },
        int: { type: ["integer", "null"] },
        bool: { type: ["boolean", "null"] },
        anyOfStr: { anyOf: [{ type: "string" }, { type: "null" }] },
        oneOfInt: { oneOf: [{ type: "integer" }, { type: "null" }] },
        filter: { anyOf: [{ $ref: "#/$defs/Filter" }, { type: "null" }] },
        mode: { enum: ["a", "b", null] },
      },
      required: ["str", "num", "int", "bool", "anyOfStr", "oneOfInt", "filter", "mode"],
      $defs: {
        Filter: {
          type: "object",
          properties: { tag: { type: "string" } },
        },
      },
    }) as SchemaJson;

    assert.equal(schema.properties.str.anyOf[0].type, "null");
    assert.equal(schema.properties.str.anyOf[1].type, "string");
    assert.equal(schema.properties.num.anyOf[0].type, "null");
    assert.equal(schema.properties.num.anyOf[1].type, "number");
    assert.equal(schema.properties.int.anyOf[0].type, "null");
    assert.equal(schema.properties.int.anyOf[1].type, "integer");
    assert.equal(schema.properties.bool.anyOf[0].type, "null");
    assert.equal(schema.properties.bool.anyOf[1].type, "boolean");
    assert.equal(schema.properties.anyOfStr.anyOf[0].type, "null");
    assert.equal(schema.properties.oneOfInt.anyOf[0].type, "null");
    assert.equal(schema.properties.filter.anyOf[0].type, "null");
    assert.equal(schema.properties.mode.anyOf[0].type, "null");

    const convertedNulls = Value.Convert(schema, {
      str: null,
      num: null,
      int: null,
      bool: null,
      anyOfStr: null,
      oneOfInt: null,
      filter: null,
      mode: null,
    });
    assert.deepEqual(convertedNulls, {
      str: null,
      num: null,
      int: null,
      bool: null,
      anyOfStr: null,
      oneOfInt: null,
      filter: null,
      mode: null,
    });
  });

  it("handles multi-type arrays such as ['string', 'number'] and ['string', 'number', 'null']", () => {
    const twoTypes = convertJsonSchemaToTypebox({
      type: ["string", "number"],
      description: "String or number ID",
    }) as SchemaJson;
    assert.ok(Array.isArray(twoTypes.anyOf));
    assert.equal(twoTypes.anyOf.length, 2);
    assert.equal(twoTypes.anyOf[0].type, "string");
    assert.equal(twoTypes.anyOf[1].type, "number");
    assert.equal(twoTypes.description, "String or number ID");

    const withNull = convertJsonSchemaToTypebox({
      type: ["string", "number", "null"],
    }) as SchemaJson;
    assert.equal(withNull.anyOf.length, 3);
    assert.equal(withNull.anyOf[0].type, "null");
    assert.equal(withNull.anyOf[1].type, "string");
    assert.equal(withNull.anyOf[2].type, "number");

    const onlyNull = convertJsonSchemaToTypebox({
      type: ["null"],
      description: "Null only",
    }) as SchemaJson;
    assert.equal(onlyNull.type, "null");
    assert.equal(onlyNull.description, "Null only");
  });

  it("handles null input gracefully", () => {
    const schema = convertJsonSchemaToTypebox(null as unknown as Record<string, unknown>) as SchemaJson;
    assert.ok(typeof schema === "object");
  });

  it("handles empty object schema (no properties)", () => {
    const result = convertJsonSchemaToTypebox({ type: "object" }) as SchemaJson;
    assert.equal(result.type, "object");
    assert.deepEqual(result.properties, {});
    assert.equal(result.patternProperties, undefined);
  });

  it("preserves object properties when top-level anyOf/oneOf/allOf is present and infers implicit objects/arrays", () => {
    const objWithAnyOf = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        id: { type: "string" },
        email: { type: "string" },
      },
      anyOf: [{ required: ["id"] }, { required: ["email"] }],
    }) as SchemaJson;
    assert.equal(objWithAnyOf.type, "object");
    assert.equal(objWithAnyOf.properties.id.type, "string");
    assert.equal(objWithAnyOf.properties.email.type, "string");
    assert.ok(Array.isArray(objWithAnyOf.anyOf));
    assert.deepEqual(objWithAnyOf.anyOf[0].required, ["id"]);
    assert.deepEqual(objWithAnyOf.anyOf[1].required, ["email"]);

    const objWithOneOf = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        id: { type: "string" },
        email: { type: "string" },
      },
      oneOf: [{ required: ["id"] }, { required: ["email"] }],
    }) as SchemaJson;
    assert.equal(objWithOneOf.type, "object");
    assert.equal(objWithOneOf.properties.id.type, "string");
    assert.equal(objWithOneOf.properties.email.type, "string");
    assert.ok(Array.isArray(objWithOneOf.oneOf));

    const objWithAllOf = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
      allOf: [
        {
          properties: { email: { type: "string" } },
          required: ["email"],
        },
        { $ref: "#/$defs/Audit" },
      ],
      $defs: {
        Audit: {
          type: "object",
          properties: { actor: { type: "string" } },
          required: ["actor"],
        },
      },
    }) as SchemaJson;
    assert.equal(objWithAllOf.type, "object");
    assert.equal(objWithAllOf.properties.id.type, "string");
    assert.equal(objWithAllOf.properties.email.type, "string");
    assert.equal(objWithAllOf.properties.actor.type, "string");
    assert.deepEqual(objWithAllOf.required, ["id", "email", "actor"]);
    assert.ok(Array.isArray(objWithAllOf.allOf));

    const implicitObj = convertJsonSchemaToTypebox({
      properties: { host: { type: "string" } },
      required: ["host"],
      additionalProperties: { type: "integer" },
      minProperties: 1,
      maxProperties: 5,
    }) as SchemaJson;
    assert.equal(implicitObj.type, "object");
    assert.equal(implicitObj.properties.host.type, "string");
    assert.deepEqual(implicitObj.required, ["host"]);
    assert.equal(implicitObj.additionalProperties.type, "integer");
    assert.equal(implicitObj.minProperties, 1);
    assert.equal(implicitObj.maxProperties, 5);

    const implicitArray = convertJsonSchemaToTypebox({
      items: { type: "boolean" },
    }) as SchemaJson;
    assert.equal(implicitArray.type, "array");
    assert.equal(implicitArray.items.type, "boolean");
  });

  it("prevents infinite recursion on deeply nested schemas and cyclic $ref while resolving shared DAG $refs and RFC 6901 pointers", () => {
    let deepSchema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 15; i++) {
      deepSchema = { type: "object", properties: { nested: deepSchema }, required: [] };
    }
    assert.doesNotThrow(() => convertJsonSchemaToTypebox(deepSchema));

    // Self-recursive $ref cycle
    const cyclic = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        value: { type: "string" },
        next: { $ref: "#/$defs/Node" },
      },
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: { $ref: "#/$defs/Node" },
          },
        },
      },
    }) as SchemaJson;
    assert.equal(cyclic.type, "object");
    assert.equal(cyclic.properties.next.type, "object");
    assert.equal(cyclic.properties.next.properties.value.type, "string");

    // Mutually recursive $ref cycle (A -> B -> A)
    const mutualCyclic = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        start: { $ref: "#/$defs/A" },
      },
      $defs: {
        A: {
          type: "object",
          properties: {
            label: { type: "string" },
            b: { $ref: "#/$defs/B" },
          },
        },
        B: {
          type: "object",
          properties: {
            count: { type: "integer" },
            a: { $ref: "#/$defs/A" },
          },
        },
      },
    }) as SchemaJson;
    assert.equal(mutualCyclic.properties.start.type, "object");
    assert.equal(mutualCyclic.properties.start.properties.b.type, "object");
    assert.equal(mutualCyclic.properties.start.properties.b.properties.count.type, "integer");

    // Root "#" reference cycle
    const rootCyclic = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        self: { $ref: "#" },
      },
    }) as SchemaJson;
    assert.equal(rootCyclic.type, "object");
    assert.equal(rootCyclic.properties.self.type, "object");

    // Shared non-cyclic DAG $ref (must resolve both branches, not treat second as cycle)
    const dag = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        left: { $ref: "#/$defs/Leaf" },
        right: { $ref: "#/$defs/Leaf" },
      },
      $defs: {
        Leaf: { type: "integer" },
      },
    }) as SchemaJson;
    assert.equal(dag.properties.left.type, "integer");
    assert.equal(dag.properties.right.type, "integer");

    // Multi-segment JSON Pointer (#/$defs/Container/properties/child), array index, & RFC 6901 ~0 / ~1 unescaping
    const multiSegment = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        source: {
          type: "object",
          properties: {
            nestedId: { type: "integer" },
          },
        },
        mirrorId: { $ref: "#/properties/source/properties/nestedId" },
        containerChild: { $ref: "#/$defs/Container/properties/child" },
        escapedRef: { $ref: "#/$defs/a~1b~0c" },
        protoRef: { $ref: "#/__proto__" },
      },
      $defs: {
        Container: {
          type: "object",
          properties: {
            child: { type: "string" },
          },
        },
        "a/b~c": { type: "boolean" },
      },
    }) as SchemaJson;
    assert.equal(multiSegment.properties.mirrorId.type, "integer");
    assert.equal(multiSegment.properties.containerChild.type, "string");
    assert.equal(multiSegment.properties.escapedRef.type, "boolean");
    assert.equal(multiSegment.properties.protoRef.type, undefined);
  });

  it("supports const, untyped/numeric/nullable enum, tuple items/prefixItems, and validation constraints", () => {
    const constStr = convertJsonSchemaToTypebox({ const: "fixed", description: "Fixed literal" }) as SchemaJson;
    assert.equal(constStr.const, "fixed");
    assert.equal(constStr.description, "Fixed literal");

    const constNull = convertJsonSchemaToTypebox({ const: null }) as SchemaJson;
    assert.equal(constNull.type, "null");

    const untypedEnum = convertJsonSchemaToTypebox({
      enum: ["alpha", 2, true, null],
      description: "Mixed nullable enum",
    }) as SchemaJson;
    assert.equal(untypedEnum.description, "Mixed nullable enum");
    assert.equal(untypedEnum.anyOf.length, 4);
    assert.equal(untypedEnum.anyOf[0].type, "null");
    assert.equal(untypedEnum.anyOf[1].const, "alpha");
    assert.equal(untypedEnum.anyOf[2].const, 2);
    assert.equal(untypedEnum.anyOf[3].const, true);

    const tuplePrefix = convertJsonSchemaToTypebox({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "integer" }],
    }) as SchemaJson;
    assert.equal(tuplePrefix.type, "array");
    assert.equal(Array.isArray(tuplePrefix.items), true);
    assert.equal(tuplePrefix.items[0].type, "string");
    assert.equal(tuplePrefix.items[1].type, "integer");

    const tupleItems = convertJsonSchemaToTypebox({
      type: "array",
      items: [{ type: "boolean" }, { type: "number" }],
    }) as SchemaJson;
    assert.equal(tupleItems.type, "array");
    assert.equal(Array.isArray(tupleItems.items), true);
    assert.equal(tupleItems.items[0].type, "boolean");
    assert.equal(tupleItems.items[1].type, "number");

    const constrainedString = convertJsonSchemaToTypebox({
      type: "string",
      title: "Username",
      default: "anon",
      format: "slug",
      pattern: "^[a-z]+$",
      minLength: 2,
      maxLength: 16,
    }) as SchemaJson;
    assert.equal(constrainedString.title, "Username");
    assert.equal(constrainedString.default, "anon");
    assert.equal(constrainedString.format, "slug");
    assert.equal(constrainedString.pattern, "^[a-z]+$");
    assert.equal(constrainedString.minLength, 2);
    assert.equal(constrainedString.maxLength, 16);

    const constrainedNum = convertJsonSchemaToTypebox({
      type: "number",
      minimum: 1,
      maximum: 100,
      exclusiveMinimum: 0,
      exclusiveMaximum: 101,
      multipleOf: 5,
    }) as SchemaJson;
    assert.equal(constrainedNum.minimum, 1);
    assert.equal(constrainedNum.maximum, 100);
    assert.equal(constrainedNum.exclusiveMinimum, 0);
    assert.equal(constrainedNum.exclusiveMaximum, 101);
    assert.equal(constrainedNum.multipleOf, 5);

    const constrainedArr = convertJsonSchemaToTypebox({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 10,
      uniqueItems: true,
    }) as SchemaJson;
    assert.equal(constrainedArr.minItems, 1);
    assert.equal(constrainedArr.maxItems, 10);
    assert.equal(constrainedArr.uniqueItems, true);
  });
});

// ── Tool Name Sanitization ────────────────────────────────────────────────────

describe("buildToolName", () => {
  it("produces valid identifier for normal names", () => {
    const name = buildToolName("mcp", "supabase", "create_project");
    assert.equal(name, "mcp_supabase_create_project");
    assert.match(name, /^[a-zA-Z0-9_]+$/);
  });

  it("sanitizes hyphens in server and tool names", () => {
    const name = buildToolName("mcp", "my-server", "my-tool");
    assert.match(name, /^[a-zA-Z0-9_]+$/);
    assert.ok(!name.includes("-"));
  });

  it("sanitizes dots and slashes", () => {
    const name = buildToolName("mcp", "server.v2", "path/to/tool");
    assert.match(name, /^[a-zA-Z0-9_]+$/);
  });

  it("truncates names exceeding 64 chars and appends hash over raw unsanitized input", () => {
    const longServer = "a".repeat(30);
    const longToolA = "b-c" + "d".repeat(30);
    const longToolB = "b_c" + "d".repeat(30);
    const nameA = buildToolName("mcp", longServer, longToolA);
    const nameB = buildToolName("mcp", longServer, longToolB);
    assert.ok(nameA.length <= 64, `Expected ≤64 chars, got ${nameA.length}`);
    assert.ok(nameB.length <= 64, `Expected ≤64 chars, got ${nameB.length}`);
    assert.match(nameA, /^[a-zA-Z0-9_]+$/);
    assert.notEqual(nameA, nameB, "Raw inputs that sanitize identically must produce distinct hashes");
  });

  it("short names are not truncated or hashed unless forceHash is true", () => {
    const name = buildToolName("mcp", "foo", "bar");
    assert.equal(name, "mcp_foo_bar");
    const forcedA = buildToolName("mcp", "a_b", "c", true);
    const forcedB = buildToolName("mcp", "a", "b_c", true);
    assert.match(forcedA, /^mcp_a_b_c_[0-9a-f]{8}$/);
    assert.match(forcedB, /^mcp_a_b_c_[0-9a-f]{8}$/);
    assert.notEqual(forcedA, forcedB);
  });
});

// ── Tool Bridge ───────────────────────────────────────────────────────────────

describe("ToolBridge", () => {
  it("registers tools and activates them", async () => {
    const registeredTools: TestToolDefinition[] = [];
    let activeTools: string[] = [];

    const mockPi = {
      registerTool: (t: unknown) => registeredTools.push(t as TestToolDefinition),
      getAllTools: () => registeredTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, sourceInfo: { path: "test", line: 0 } })),
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };

    const mockClient = {
      request: async () => ({
        tools: [
          {
            name: "echo",
            description: "Echo tool",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
          {
            name: "count",
            description: "Count items",
            inputSchema: {
              type: "object",
              properties: { n: { type: "integer" } },
              required: ["n"],
            },
          },
        ],
        // No nextCursor — single page
      }),
    } as unknown as Client;

    const settings = {
      toolPrefix: "mcp",
      requestTimeoutMs: 30000,
      maxRetries: 5,
    };

    const bridge = new ToolBridge(settings, mockPi);
    await bridge.refreshTools("myserver", mockClient);

    // Tools should be registered
    assert.equal(registeredTools.length, 2);
    assert.equal(registeredTools[0]?.name, "mcp_myserver_echo");
    assert.equal(registeredTools[1]?.name, "mcp_myserver_count");

    // Tools should be activated
    assert.ok(activeTools.includes("mcp_myserver_echo"));
    assert.ok(activeTools.includes("mcp_myserver_count"));
    assert.deepEqual(bridge.getToolActivity("myserver"), { discovered: 2, active: 2 });
    activeTools = ["mcp_myserver_echo", "unrelated_tool"];
    assert.deepEqual(bridge.getToolActivity("myserver"), { discovered: 2, active: 1 });
    assert.deepEqual(bridge.getToolActivity("unknown"), { discovered: 0, active: 0 });
  });

  it("deactivates server tools on disconnect", async () => {
    const registeredTools: TestToolDefinition[] = [];
    let activeTools: string[] = ["mcp_myserver_echo", "mcp_myserver_count", "other_tool"];

    const mockPi = {
      registerTool: (t: unknown) => registeredTools.push(t as TestToolDefinition),
      getAllTools: () => registeredTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, sourceInfo: { path: "test", line: 0 } })),
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);

    // Simulate already-registered tools
    const serverTools = new Set(["mcp_myserver_echo", "mcp_myserver_count"]);
    (bridge as unknown as { serverToolNames: Map<string, Set<string>> }).serverToolNames.set("myserver", serverTools);

    bridge.deactivateServer("myserver");

    // Server tools should be removed, other_tool preserved
    assert.ok(!activeTools.includes("mcp_myserver_echo"));
    assert.ok(!activeTools.includes("mcp_myserver_count"));
    assert.ok(activeTools.includes("other_tool"));
    assert.deepEqual(bridge.getToolActivity("myserver"), { discovered: 2, active: 0 });
  });

  it("re-registers tools on repeated refresh to capture new client", async () => {
    const registeredTools: TestToolDefinition[] = [];
    let activeTools: string[] = [];

    const mockPi = {
      registerTool: (t: unknown) => registeredTools.push(t as TestToolDefinition),
      getAllTools: () => registeredTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, sourceInfo: { path: "test", line: 0 } })),
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };

    const mockClient = {
      request: async () => ({
        tools: [{
          name: "echo",
          description: "Echo",
          inputSchema: { type: "object", properties: {}, required: [] },
        }],
      }),
    } as unknown as Client;

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);

    await bridge.refreshTools("myserver", mockClient);
    await bridge.refreshTools("myserver", mockClient); // re-register with same client
    await bridge.refreshTools("myserver", mockClient); // re-register with same client

    // Tools are re-registered each time (Pi's registerTool overwrites by name)
    // This ensures reconnection captures the new client reference
    assert.equal(registeredTools.length, 3);
    // But only one tool name is active (no duplicates)
    assert.equal(activeTools.length, 1);
    assert.equal(activeTools[0], "mcp_myserver_echo");
  });

  it("includes annotation hints in tool description", async () => {
    const registeredTools: TestToolDefinition[] = [];
    let annotationActiveTools: string[] = [];
    const mockPi = {
      registerTool: (t: unknown) => registeredTools.push(t as TestToolDefinition),
      getAllTools: () => registeredTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, sourceInfo: { path: "test", line: 0 } })),
      getActiveTools: () => annotationActiveTools,
      setActiveTools: (names: string[]) => { annotationActiveTools = names; },
    };
    const mockClient = {
      request: async () => ({
        tools: [{
          name: "delete_record",
          description: "Delete a record",
          inputSchema: { type: "object", properties: {}, required: [] },
          annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false },
        }],
      }),
    } as unknown as Client;

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);
    await bridge.refreshTools("myserver", mockClient);

    const tool = registeredTools[0]!;
    assert.ok(tool.description.includes("⚠️ destructive"));
  });

  it("passes through MCP image content and filters non-text blocks on isError", async () => {
    const registeredTools: TestToolDefinition[] = [];
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: (t: unknown) => registeredTools.push(t as TestToolDefinition),
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };

    let callResponse: Record<string, unknown> = {
      content: [
        { type: "text", text: "Screenshot captured" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
      isError: false,
    };

    const mockClient = {
      request: async (req: { method: string }) => {
        if (req.method === "tools/list") {
          return {
            tools: [{
              name: "screenshot",
              description: "Take a screenshot",
              inputSchema: { type: "object", properties: {}, required: [] },
            }],
          };
        }
        return callResponse;
      },
    } as unknown as Client;

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);
    await bridge.refreshTools("myserver", mockClient);

    const tool = registeredTools[0]!;
    const okResult = await tool.execute("call-1", {}, undefined, undefined, undefined);
    assert.deepEqual(okResult.content, [
      { type: "text", text: "Screenshot captured" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);

    // When isError is true with mixed image + text content, only text blocks form the error message
    callResponse = {
      content: [
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        { type: "text", text: "Render failed" },
      ],
      isError: true,
    };
    await assert.rejects(
      () => tool.execute("call-2", {}, undefined, undefined, undefined),
      (err: { message?: string; code?: string }) => {
        assert.equal(err.message, "Render failed");
        assert.equal(err.code, "tool");
        return true;
      },
    );

    // When isError is true with only image content, falls back to "Tool reported an error"
    callResponse = {
      content: [
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
      isError: true,
    };
    await assert.rejects(
      () => tool.execute("call-3", {}, undefined, undefined, undefined),
      (err: { message?: string; code?: string }) => {
        assert.equal(err.message, "Tool reported an error");
        assert.equal(err.code, "tool");
        return true;
      },
    );
  });

  it("disambiguates intra-server and cross-server tool name collisions and isolates server deactivation", async () => {
    const registeredTools = new Map<string, ToolDefinition>();
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: (t: unknown) => registeredTools.set((t as ToolDefinition).name, t as ToolDefinition),
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };
    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);

    // Intra-server collision: "my-tool" and "my_tool" on server "alpha"
    const clientAlpha = {
      request: async () => ({
        tools: [
          { name: "my-tool", inputSchema: { type: "object" } },
          { name: "my_tool", inputSchema: { type: "object" } },
        ],
      }),
    } as unknown as Client;
    await bridge.refreshTools("alpha", clientAlpha);
    assert.equal(activeTools.length, 2, "Both colliding intra-server tools must be active");
    assert.ok(activeTools.includes("mcp_alpha_my_tool"));
    assert.ok(activeTools.some((n) => /^mcp_alpha_my_tool_[0-9a-f]{8}$/.test(n)));

    // Cross-server collision: server "a_b" tool "c" vs server "a" tool "b_c"
    const clientAB = {
      request: async () => ({
        tools: [{ name: "c", inputSchema: { type: "object" } }],
      }),
    } as unknown as Client;
    const clientA = {
      request: async () => ({
        tools: [{ name: "b_c", inputSchema: { type: "object" } }],
      }),
    } as unknown as Client;

    await bridge.refreshTools("a_b", clientAB);
    await bridge.refreshTools("a", clientA);

    assert.ok(activeTools.includes("mcp_a_b_c"), "First server keeps canonical name");
    const hashedName = buildToolName("mcp", "a", "b_c", true);
    assert.ok(activeTools.includes(hashedName), "Second server gets disambiguated hashed name");

    // Deactivating server "a" must NOT deactivate server "a_b"'s tool
    bridge.deactivateServer("a");
    assert.ok(activeTools.includes("mcp_a_b_c"), "Server a_b tool must remain active");
    assert.ok(!activeTools.includes(hashedName), "Server a tool must be deactivated");

    // Removing server "a_b" must release ownership of "mcp_a_b_c"
    bridge.removeServer("a_b");
    assert.ok(!activeTools.includes("mcp_a_b_c"));
    await bridge.refreshTools("a", clientA);
    assert.ok(activeTools.includes("mcp_a_b_c"), "Server a claims canonical name once a_b is removed");
  });

  it("discards stale out-of-order refreshTools responses via monotonic generation guard", async () => {
    const registeredTools = new Map<string, ToolDefinition>();
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: (t: unknown) => registeredTools.set((t as ToolDefinition).name, t as ToolDefinition),
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };
    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);

    let resolveSlow!: (val: unknown) => void;
    const slowClient = {
      request: () =>
        new Promise((resolve) => {
          resolveSlow = resolve;
        }),
    } as unknown as Client;
    const fastClient = {
      request: async () => ({
        tools: [{ name: "fresh_tool", inputSchema: { type: "object" } }],
      }),
    } as unknown as Client;

    const slowRefresh = bridge.refreshTools("srv", slowClient);
    const fastRefresh = bridge.refreshTools("srv", fastClient);
    await fastRefresh;
    assert.deepEqual(activeTools, ["mcp_srv_fresh_tool"]);

    // Now resolve the earlier slow refresh with stale tools
    resolveSlow({
      tools: [{ name: "stale_tool", inputSchema: { type: "object" } }],
    });
    await slowRefresh;

    // Stale tool must NOT overwrite or activate
    assert.deepEqual(activeTools, ["mcp_srv_fresh_tool"]);
    assert.equal(registeredTools.has("mcp_srv_stale_tool"), false);

    // Also test in-flight refresh discarded when deactivateServer is called
    let resolveBeforeDeactivate!: (val: unknown) => void;
    const clientBeforeDeactivate = {
      request: () =>
        new Promise((resolve) => {
          resolveBeforeDeactivate = resolve;
        }),
    } as unknown as Client;
    const pendingRefresh = bridge.refreshTools("srv", clientBeforeDeactivate);
    bridge.deactivateServer("srv");
    assert.deepEqual(activeTools, []);
    resolveBeforeDeactivate({
      tools: [{ name: "zombie_tool", inputSchema: { type: "object" } }],
    });
    await pendingRefresh;
    assert.deepEqual(activeTools, []);
  });

  it("throws McpError on pre-aborted signal and falls back to structuredContent when content is empty", async () => {
    const registeredTools: TestToolDefinition[] = [];
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: (t: unknown) => registeredTools.push(t as TestToolDefinition),
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };

    let callCount = 0;
    const mockClient = {
      request: async (req: { method: string }) => {
        if (req.method === "tools/list") {
          return {
            tools: [{ name: "structured", inputSchema: { type: "object" } }],
          };
        }
        callCount++;
        return {
          content: [],
          structuredContent: { ok: true, count: 42 },
        };
      },
    } as unknown as Client;

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);
    await bridge.refreshTools("myserver", mockClient);

    const tool = registeredTools[0]!;
    const abortController = new AbortController();
    abortController.abort();

    await assert.rejects(
      () => tool.execute("call-aborted", {}, abortController.signal, undefined, undefined),
      (err: { name?: string; message?: string; code?: string }) => {
        assert.equal(err.name, "McpError");
        assert.equal(err.message, "Tool execution cancelled");
        assert.equal(err.code, "protocol");
        return true;
      },
    );
    assert.equal(callCount, 0, "Must not call client.request when signal is already aborted");

    const structuredRes = await tool.execute("call-ok", {}, undefined, undefined, undefined);
    assert.equal(callCount, 1);
    assert.deepEqual(structuredRes.content, [
      { type: "text", text: JSON.stringify({ ok: true, count: 42 }, null, 2) },
    ]);
  });
});

// ── Content Conversion ────────────────────────────────────────────────────────

describe("convertMcpContent", () => {
  it("passes through image blocks as PiImageContent", () => {
    const out = convertMcpContent([
      { type: "image", data: "YWJj", mimeType: "image/jpeg" },
      { type: "image", data: "ZGVm" },
    ]);
    assert.deepEqual(out, [
      { type: "image", data: "YWJj", mimeType: "image/jpeg" },
      { type: "image", data: "ZGVm", mimeType: "image/png" },
    ]);
  });

  it("converts text, audio, and resource blocks to PiTextContent including empty resource text", () => {
    const out = convertMcpContent([
      { type: "text", text: "hello" },
      { type: "audio", mimeType: "audio/wav", data: "AAA=" },
      { type: "resource", resource: { uri: "file:///a.txt", text: "file body" } },
      { type: "resource", resource: { uri: "file:///empty.txt", text: "" } },
      { type: "resource", resource: { uri: "file:///b.bin", blob: "BBB=" } },
    ]);
    assert.deepEqual(out, [
      { type: "text", text: "hello" },
      { type: "text", text: "[Audio: audio/wav, base64 encoded]" },
      { type: "text", text: "file body" },
      { type: "text", text: "" },
      { type: "text", text: "[Resource blob: file:///b.bin]" },
    ]);
  });
});

// ── Paginated listAllTools ─────────────────────────────────────────────────────

describe("listAllTools pagination", () => {
  it("follows nextCursor until exhausted", async () => {
    const pages = [
      { tools: [{ name: "tool_a", inputSchema: {} }], nextCursor: "page2" },
      { tools: [{ name: "tool_b", inputSchema: {} }], nextCursor: "page3" },
      { tools: [{ name: "tool_c", inputSchema: {} }] }, // no nextCursor = last page
    ];
    let pageIndex = 0;

    const mockClient = {
      request: async (_req: unknown) => {
        const page = pages[pageIndex++];
        return page;
      },
    } as unknown as Client;

    const tools = await listAllTools(mockClient, 30000);
    assert.equal(tools.length, 3);
    assert.equal(tools[0]?.name, "tool_a");
    assert.equal(tools[1]?.name, "tool_b");
    assert.equal(tools[2]?.name, "tool_c");
    assert.equal(pageIndex, 3); // exactly 3 requests made
  });

  it("stops at the max-page guard when a broken server keeps returning a cursor", async () => {
    let requests = 0;
    const mockClient = {
      request: async () => {
        requests++;
        // A malfunctioning server that never stops paginating.
        return {
          tools: [{ name: `tool_${requests}`, inputSchema: {} }],
          nextCursor: `page${requests + 1}`,
        };
      },
    } as unknown as Client;

    const tools = await listAllTools(mockClient, 30000);
    assert.equal(requests, 100, "must stop requesting after the 100-page guard trips");
    assert.equal(tools.length, 100);
  });
});


// ── Request-timeout classification (#209) ────────────────────────────────────

describe("ToolBridge request-timeout classification", () => {
  interface CapturedTool {
    name: string;
    execute: (
      id: string,
      params: unknown,
      signal: AbortSignal | undefined,
      update: unknown,
      ctx: unknown,
    ) => Promise<unknown>;
  }

  function sdkTimeout(): Error {
    return SdkMcpError.fromError(ErrorCode.RequestTimeout, "Request timed out", { timeout: 100 });
  }

  function makeBridge(): { bridge: ToolBridge; tools: CapturedTool[] } {
    const tools: CapturedTool[] = [];
    const mockPi = {
      registerTool: (t: unknown) => tools.push(t as CapturedTool),
      getActiveTools: () => [] as string[],
      setActiveTools: () => undefined,
    };
    const bridge = new ToolBridge(
      { toolPrefix: "mcp", requestTimeoutMs: 100, maxRetries: 2 },
      mockPi,
    );
    return { bridge, tools };
  }

  it("labels a tools/list SDK timeout as 'timeout' so connect retries apply", async () => {
    const client = {
      request: async () => {
        throw sdkTimeout();
      },
    };
    const { bridge } = makeBridge();

    await assert.rejects(
      () => bridge.refreshTools("srv", client as unknown as Client),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.equal(err.code, "timeout");
        assert.match(err.message, /Failed to list tools from srv/);
        return true;
      },
    );
  });

  it("still labels a non-timeout tools/list failure as 'protocol'", async () => {
    const client = {
      request: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    };
    const { bridge } = makeBridge();

    await assert.rejects(
      () => bridge.refreshTools("srv", client as unknown as Client),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.equal(err.code, "protocol");
        return true;
      },
    );
  });

  it("reports an in-flight abort as a cancellation, not as a timeout", async () => {
    // Mirror Protocol.request: an abort rejects the request with the SDK's RequestTimeout
    // error carrying the abort reason, so the bridge must test cancellation first.
    const client = {
      request: async (req: { method: string }, _schema: unknown, options?: { signal?: AbortSignal }) => {
        if (req.method === "tools/list") {
          return { tools: [{ name: "wait", inputSchema: { type: "object" } }] };
        }
        return await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(SdkMcpError.fromError(ErrorCode.RequestTimeout, "AbortError: This operation was aborted"));
          });
        });
      },
    };
    const { bridge, tools } = makeBridge();
    await bridge.refreshTools("srv", client as unknown as Client);
    const tool = tools[0];
    assert.ok(tool);

    const controller = new AbortController();
    const pending = tool.execute("call-abort", {}, controller.signal, undefined, undefined);
    setTimeout(() => controller.abort(new Error("AbortError: This operation was aborted")), 10);
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof McpError);
      assert.equal(err.code, "protocol");
      assert.equal(err.message, "Tool execution cancelled");
      return true;
    });
  });

  it("still recognizes an abort-shaped rejection when no signal reaches the bridge", async () => {
    // WHY: the SDK's abort listener sets signal.aborted before rejecting, so this leg only
    // fires for a rejection produced by a signal we were never handed — keep it exercised.
    const client = {
      request: async (req: { method: string }) => {
        if (req.method === "tools/list") {
          return { tools: [{ name: "wait", inputSchema: { type: "object" } }] };
        }
        throw SdkMcpError.fromError(ErrorCode.RequestTimeout, "AbortError: This operation was aborted");
      },
    };
    const { bridge, tools } = makeBridge();
    await bridge.refreshTools("srv", client as unknown as Client);
    const tool = tools[0];
    assert.ok(tool);
    await assert.rejects(
      () => tool.execute("call-abort-nosignal", {}, undefined, undefined, undefined),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.equal(err.code, "protocol");
        assert.equal(err.message, "Tool execution cancelled");
        return true;
      },
    );
  });

  it("labels a tools/call SDK timeout as 'timeout' and a protocol failure as 'protocol'", async () => {
    let callError: Error | undefined;
    const client = {
      request: async (req: { method: string }) => {
        if (req.method === "tools/list") {
          return { tools: [{ name: "do_it", inputSchema: { type: "object" } }] };
        }
        throw callError ?? new Error("no error configured");
      },
    };
    const { bridge, tools } = makeBridge();
    await bridge.refreshTools("srv", client as unknown as Client);
    const tool = tools[0];
    assert.ok(tool, "refreshTools must register the discovered tool");

    callError = sdkTimeout();
    await assert.rejects(
      () => tool.execute("call-timeout", {}, undefined, undefined, undefined),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.equal(err.code, "timeout");
        return true;
      },
    );

    callError = new Error("Unexpected token < in JSON");
    await assert.rejects(
      () => tool.execute("call-protocol", {}, undefined, undefined, undefined),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.equal(err.code, "protocol");
        return true;
      },
    );
  });
});

describe("ToolBridge error classification does not swallow server JSON-RPC errors", () => {
  it("keeps a server-side JSON-RPC error whose message mentions a timeout as 'protocol'", async () => {
    // A server error response carries its own negative JSON-RPC code; only the SDK's own
    // RequestTimeout (-32001) is a client-side timeout, so the message must not decide.
    const client = {
      request: async () => {
        throw SdkMcpError.fromError(ErrorCode.InternalError, "Upstream query timed out");
      },
    };
    const tools: Array<{ execute: (id: string, params: unknown, s: AbortSignal | undefined, u: unknown, c: unknown) => Promise<unknown> }> = [];
    const bridge = new ToolBridge(
      { toolPrefix: "mcp", requestTimeoutMs: 100, maxRetries: 2 },
      { registerTool: (t: unknown) => tools.push(t as never), getActiveTools: () => [], setActiveTools: () => undefined },
    );
    await assert.rejects(
      () => bridge.refreshTools("srv", client as unknown as Client),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.equal(err.code, "protocol");
        return true;
      },
    );
  });
});
