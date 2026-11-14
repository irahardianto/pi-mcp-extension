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
  formatProgressText,
  ToolBridge,
} from "../src/tool-bridge.js";
import {
  buildMcpResultSchema,
  buildMcpScriptResult,
  buildToolAnnotations,
  buildToolCallContent,
  buildToolCallOutcome,
  buildToolDescription,
  supportsToolErrorResult,
  toolErrorText,
} from "../src/tool-content.js";
import {
  compareToolsForNameAssignment,
  isLosslessToolName,
  MAX_TOOL_NAME_LEN,
  orderToolsForNameAssignment,
  resolveUniqueToolName,
} from "../src/tool-names.js";

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
  additionalItems?: SchemaJson | boolean;
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

  it("percent-decodes RFC 6901 §6 fragment tokens so encoded $defs names resolve", () => {
    const schema = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        response: { $ref: "#/$defs/Response%5BItem%5D" },
        profile: { $ref: "#/$defs/User%20Profile" },
      },
      required: ["response", "profile"],
      $defs: {
        "Response[Item]": {
          type: "object",
          properties: { total: { type: "integer" } },
          required: ["total"],
        },
        "User Profile": {
          type: "object",
          properties: { username: { type: "string" } },
          required: ["username"],
        },
      },
    }) as SchemaJson;
    const props = schema.properties as Record<string, SchemaJson>;
    assert.equal(props.response?.type, "object", "%5B/%5D must decode to the generic def name");
    assert.equal(
      (props.response?.properties as Record<string, SchemaJson>).total?.type,
      "integer",
      "resolved def must keep its own properties",
    );
    assert.equal(props.profile?.type, "object", "%20 must decode to a space");
    assert.equal(
      (props.profile?.properties as Record<string, SchemaJson>).username?.type,
      "string",
    );
  });

  it("decodes a fragment token before unescaping §4 escapes (§6 encoding wraps the pointer)", () => {
    const schema = convertJsonSchemaToTypebox({
      $ref: "#/$defs/a%7E1b",
      $defs: { "a/b": { type: "string" }, "a~1b": { type: "boolean" } },
    }) as SchemaJson;
    // "%7E1" is the encoded escape sequence "~1", which §4 turns into "/" -- so this points at
    // the key "a/b", not at a literal "a~1b" key. Decoding after unescaping would pick the wrong one.
    assert.equal(schema.type, "string", "%7E1 must decode to ~1 and then unescape to /");
  });

  it("treats a malformed percent escape in a fragment as a literal token instead of throwing", () => {
    const schema = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        literal: { $ref: "#/$defs/Bad%ZZName" },
        unknown: { $ref: "#/$defs/Lost%E0%A4%A" },
      },
      $defs: { "Bad%ZZName": { type: "string" } },
    }) as SchemaJson;
    const props = schema.properties as Record<string, SchemaJson>;
    assert.equal(props.literal?.type, "string", "malformed escapes fall back to the raw token");
    assert.deepEqual(props.unknown, {}, "an unresolvable malformed ref still degrades to Any");
  });

  it("decodes percent-encoded traversal segments, not just the $defs name", () => {
    const schema = convertJsonSchemaToTypebox({
      $ref: "#/$defs/Envelope%20Props/properties/user%2Dname",
      $defs: {
        "Envelope Props": { type: "object", properties: { "user-name": { type: "integer" } } },
      },
    }) as SchemaJson;
    assert.equal(schema.type, "integer", "nested pointer segments decode independently");
  });

  it("reads an encoded slash as a key first, then as a separator", () => {
    const literalKey = convertJsonSchemaToTypebox({
      $ref: "#/$defs/a%2Fb",
      $defs: { "a/b": { type: "string" }, a: { b: { type: "integer" } } },
    }) as SchemaJson;
    // The pointer is split before decoding, so "%2F" reaches the definition keyed "a/b" — a key
    // containing "/" is spelled "~1" in pointer form, so this is the ordinary reading.
    assert.equal(literalKey.type, "string");

    const separator = convertJsonSchemaToTypebox({
      $ref: "#/$defs/a%2Fb",
      $defs: { a: { b: { type: "integer" } } },
    }) as SchemaJson;
    // A resolver that decodes the whole fragment before splitting sees a separator here; the
    // fallback reaches the subtree instead of degrading the schema to Any.
    assert.equal(separator.type, "integer");
  });

  it("resolves the official JSON-Schema-Test-Suite escaped-pointer cases", () => {
    // draft2020-12/ref.json: "escaped pointer ref" and "refs with quote".
    const escaped = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        tilde: { $ref: "#/$defs/tilde~0field" },
        slash: { $ref: "#/$defs/slash~1field" },
        percent: { $ref: "#/$defs/percent%25field" },
      },
      $defs: {
        "tilde~field": { type: "integer" },
        "slash/field": { type: "integer" },
        "percent%field": { type: "integer" },
      },
    }) as SchemaJson;
    const props = escaped.properties as Record<string, SchemaJson>;
    for (const key of ["tilde", "slash", "percent"]) {
      assert.equal(props[key]?.type, "integer", `$ref for "${key}" must resolve`);
    }

    const quote = convertJsonSchemaToTypebox({
      type: "object",
      properties: { 'foo"bar': { $ref: "#/$defs/foo%22bar" } },
      $defs: { 'foo"bar': { type: "number" } },
    }) as SchemaJson;
    const quoted = quote.properties as Record<string, SchemaJson>;
    assert.equal(quoted['foo"bar']?.type, "number", "%22 must decode to a double quote");
  });

  it("decodes escaped tildes (%7E0 -> ~) and multibyte UTF-8 in a token", () => {
    const tilde = convertJsonSchemaToTypebox({
      $ref: "#/$defs/a%7E0b",
      $defs: { "a~b": { type: "boolean" }, "a~0b": { type: "string" } },
    }) as SchemaJson;
    assert.equal(tilde.type, "boolean", "%7E0 must decode to ~0 and then unescape to ~");

    const multibyte = convertJsonSchemaToTypebox({
      $ref: "#/$defs/caf%C3%A9",
      $defs: { café: { type: "integer" } },
    }) as SchemaJson;
    assert.equal(multibyte.type, "integer", "multi-byte escapes decode as one code point");
  });

  it("falls back to the undecoded token when a server emits a literal % in a definition name", () => {
    const schema = convertJsonSchemaToTypebox({
      type: "object",
      properties: { raw: { $ref: "#/$defs/with%20literal" } },
      $defs: { "with%20literal": { type: "string" } },
    }) as SchemaJson;
    // "with%20literal" decodes to "with literal" and misses; the raw token must still be tried,
    // because a server that skips §6 encoding would otherwise lose the schema it used to get.
    assert.equal((schema.properties as Record<string, SchemaJson>).raw?.type, "string");
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

  it("preserves variadic tuple rest schemas for prefixItems/items and draft-07 additionalItems", async () => {
    const { validateToolArguments } = await import("@earendil-works/pi-ai");

    // JSON Schema 2020-12: `prefixItems` + sibling `items` describes [string, ...integer[]].
    const variadic = convertJsonSchemaToTypebox({
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: "integer" },
    }) as SchemaJson;
    assert.equal((variadic.additionalItems as SchemaJson).type, "integer");

    // End-to-end Pi validation: rest elements must reach the tuple's rest schema instead of
    // hitting Type.Tuple's default `additionalItems: false` ("schema is false").
    const parameters = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        command: {
          type: "array",
          prefixItems: [{ type: "string" }],
          items: { type: "integer" },
        },
      },
      required: ["command"],
    });
    const validated = validateToolArguments(
      { name: "run", description: "run", parameters },
      { type: "toolCall", id: "call_1", name: "run", arguments: { command: ["ls", 1, 2] } },
    );
    assert.deepEqual(validated, { command: ["ls", 1, 2] });
    assert.throws(
      () =>
        validateToolArguments(
          { name: "run", description: "run", parameters },
          { type: "toolCall", id: "call_2", name: "run", arguments: { command: ["ls", "nope"] } },
        ),
      /command\.1: must be integer/,
      "rest elements are still validated against the rest schema",
    );
    // Rest elements are validated but not Value.Convert-coerced — TypeBox's tuple converter
    // only walks the declared positions — so "5" is rejected here where a plain array
    // with `items: { type: "integer" }` would have coerced it.
    assert.throws(
      () =>
        validateToolArguments(
          { name: "run", description: "run", parameters },
          { type: "toolCall", id: "call_3", name: "run", arguments: { command: ["ls", "5"] } },
        ),
      /command\.1: must be integer/,
    );

    // `items: true` admits anything, `items: false` closes the tuple, and an absent rest
    // keyword is unconstrained in both drafts (so a lone `prefixItems` is open too).
    const anyRest = convertJsonSchemaToTypebox({
      type: "array",
      prefixItems: [{ type: "string" }],
      items: true,
    }) as SchemaJson;
    assert.equal(anyRest.additionalItems, true);
    const closedRest = convertJsonSchemaToTypebox({
      type: "array",
      prefixItems: [{ type: "string" }],
      items: false,
    }) as SchemaJson;
    assert.equal(closedRest.additionalItems, false);
    const closedTupleParameters = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        v: { type: "array", prefixItems: [{ type: "string" }], items: false },
      },
      required: ["v"],
    });
    assert.throws(
      () =>
        validateToolArguments(
          { name: "run", description: "run", parameters: closedTupleParameters },
          { type: "toolCall", id: "call_4", name: "run", arguments: { v: ["a", 1] } },
        ),
      /v\.1: schema is false/,
      "an explicit items: false still closes the tuple",
    );
    const noRest = convertJsonSchemaToTypebox({
      type: "array",
      prefixItems: [{ type: "string" }],
    }) as SchemaJson;
    assert.equal(noRest.additionalItems, true);
    const invalidRest = convertJsonSchemaToTypebox({
      type: "array",
      prefixItems: [{ type: "string" }],
      items: 0,
    }) as SchemaJson;
    assert.equal(invalidRest.additionalItems, true, "a non-schema rest value is not a closure");
    const looseTupleParameters = convertJsonSchemaToTypebox({
      type: "object",
      properties: { v: { type: "array", prefixItems: [{ type: "string" }] } },
      required: ["v"],
    });
    assert.deepEqual(
      validateToolArguments(
        { name: "run", description: "run", parameters: looseTupleParameters },
        { type: "toolCall", id: "call_3", name: "run", arguments: { v: ["a", 1] } },
      ),
      { v: ["a", 1] },
      "prefixItems alone leaves the rest of the array unconstrained",
    );

    // Draft-07 tuples carry the rest schema in `additionalItems` next to an array `items`.
    const draft07Rest = convertJsonSchemaToTypebox({
      type: "array",
      items: [{ type: "string" }],
      additionalItems: { type: "boolean" },
    }) as SchemaJson;
    assert.equal((draft07Rest.additionalItems as SchemaJson).type, "boolean");
    const draft07Closed = convertJsonSchemaToTypebox({
      type: "array",
      items: [{ type: "string" }],
      additionalItems: false,
    }) as SchemaJson;
    assert.equal(draft07Closed.additionalItems, false);
    const draft07Loose = convertJsonSchemaToTypebox({
      type: "array",
      items: [{ type: "string" }],
    }) as SchemaJson;
    assert.equal(draft07Loose.additionalItems, true);

    // A rest schema that is a `$ref` resolves against the root `$defs` like any other branch.
    const refRest = convertJsonSchemaToTypebox({
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { $ref: "#/$defs/Cmd" },
      $defs: {
        Cmd: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
      },
    }) as SchemaJson;
    const refRestSchema = refRest.additionalItems as SchemaJson;
    assert.equal(refRestSchema.type, "object");
    assert.equal(refRestSchema.properties.n?.type, "integer");

    // End-to-end: the resolved `$ref` rest schema validates rest elements through a real tool.
    const refParameters = convertJsonSchemaToTypebox({
      type: "object",
      properties: {
        v: {
          type: "array",
          prefixItems: [{ type: "string" }],
          items: { $ref: "#/$defs/Cmd" },
        },
      },
      required: ["v"],
      $defs: {
        Cmd: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
      },
    });
    assert.deepEqual(
      validateToolArguments(
        { name: "run", description: "run", parameters: refParameters },
        { type: "toolCall", id: "call_5", name: "run", arguments: { v: ["a", { n: 1 }] } },
      ),
      { v: ["a", { n: 1 }] },
    );
    assert.throws(
      () =>
        validateToolArguments(
          { name: "run", description: "run", parameters: refParameters },
          { type: "toolCall", id: "call_6", name: "run", arguments: { v: ["a", { n: "x" }] } },
        ),
      /v\.1\.n: must be integer/,
    );
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

describe("orderToolsForNameAssignment and resolveUniqueToolName", () => {
  it("identifies lossless tool names and orders lossless before lossy then by code point", () => {
    assert.equal(isLosslessToolName("my_tool_2"), true);
    assert.equal(isLosslessToolName("my-tool"), false);
    assert.equal(isLosslessToolName("my.tool"), false);
    assert.equal(isLosslessToolName(""), false);

    assert.ok(
      compareToolsForNameAssignment(
        { name: "my_tool", inputSchema: {} },
        { name: "my-tool", inputSchema: {} },
      ) < 0,
    );
    assert.ok(
      compareToolsForNameAssignment(
        { name: "my-tool", inputSchema: {} },
        { name: "my_tool", inputSchema: {} },
      ) > 0,
    );
    assert.ok(
      compareToolsForNameAssignment(
        { name: "my-tool", inputSchema: {} },
        { name: "my.tool", inputSchema: {} },
      ) < 0,
    );
  });

  it("orders colliding tools deterministically while preserving non-colliding group positions", () => {
    const ordered = orderToolsForNameAssignment("mcp", "srv", [
      { name: "first_unrelated", inputSchema: {} },
      { name: "my.tool", inputSchema: {} },
      { name: "middle_unrelated", inputSchema: {} },
      { name: "my-tool", inputSchema: {} },
      { name: "my_tool", inputSchema: {} },
      { name: "last_unrelated", inputSchema: {} },
    ]);
    assert.deepEqual(
      ordered.map((t) => t.name),
      [
        "first_unrelated",
        "my_tool",
        "my-tool",
        "my.tool",
        "middle_unrelated",
        "last_unrelated",
      ],
    );
  });

  it("resolves unhashed, hashed, and cross-server suffixed unique tool names within 64 chars", () => {
    const seenInBatch = new Set<string>();
    const toolOwners = new Map<string, string>();

    const first = resolveUniqueToolName({
      prefix: "mcp",
      serverName: "srv",
      rawToolName: "my_tool",
      seenInBatch,
      toolOwners,
    });
    assert.equal(first, "mcp_srv_my_tool");
    seenInBatch.add(first);

    const second = resolveUniqueToolName({
      prefix: "mcp",
      serverName: "srv",
      rawToolName: "my-tool",
      seenInBatch,
      toolOwners,
    });
    assert.equal(second, buildToolName("mcp", "srv", "my-tool", true));
    seenInBatch.add(second);

    // Same server already owning the base name in toolOwners (not in seenInBatch) may reuse it
    const reused = resolveUniqueToolName({
      prefix: "mcp",
      serverName: "srv",
      rawToolName: "existing",
      seenInBatch: new Set(),
      toolOwners: new Map([["mcp_srv_existing", "srv"]]),
    });
    assert.equal(reused, "mcp_srv_existing");

    // Cross-server collision on both base and hashed candidates falls back to _2 / _3 within 64 chars
    const longServer = "s".repeat(30);
    const longTool = "t".repeat(30);
    const hashed = buildToolName("mcp", longServer, longTool, true);
    const foreignOwners = new Map<string, string>([
      [hashed, "other_server"],
      [`${hashed.slice(0, MAX_TOOL_NAME_LEN - 2)}_2`, "other_server"],
    ]);
    const suffixed = resolveUniqueToolName({
      prefix: "mcp",
      serverName: longServer,
      rawToolName: longTool,
      seenInBatch: new Set(),
      toolOwners: foreignOwners,
    });
    assert.ok(suffixed.endsWith("_3"));
    assert.ok(suffixed.length <= MAX_TOOL_NAME_LEN);
  });
});

// ── Tool Bridge ───────────────────────────────────────────────────────────────

/** A `tools/list` client exposing the given raw tool names; the array is read on every request. */
function listingClient(toolNames: string[]): Client {
  return {
    request: async () => ({
      tools: toolNames.map((name) => ({ name, inputSchema: { type: "object" } })),
    }),
  } as unknown as Client;
}

const BRIDGE_SETTINGS = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };

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
    assert.deepEqual(bridge.getToolActivity("myserver"), { discovered: 2, active: 2, expected: 2 });
    activeTools = ["mcp_myserver_echo", "unrelated_tool"];
    assert.deepEqual(bridge.getToolActivity("myserver"), { discovered: 2, active: 1, expected: 2 });
    assert.deepEqual(bridge.getToolActivity("unknown"), { discovered: 0, active: 0, expected: 0 });
  });

  it("registers every tool with its resolved exposure and activates only direct ones", async () => {
    const registered: TestToolDefinition[] = [];
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: (t: unknown) => registered.push(t as TestToolDefinition),
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };
    const bridge = new ToolBridge(BRIDGE_SETTINGS, mockPi);

    await bridge.refreshTools("db", listingClient(["search_users", "delete_user", "get_status"]), {
      exposure: "hidden",
      toolExposure: { "search_*": "direct", get_status: "deferred" },
    });

    assert.deepEqual(
      Object.fromEntries(registered.map((tool) => [tool.name, tool.exposure])),
      {
        mcp_db_delete_user: "hidden",
        mcp_db_get_status: "deferred",
        mcp_db_search_users: "direct",
      },
    );
    assert.deepEqual(activeTools, ["mcp_db_search_users"]);
    assert.deepEqual(bridge.getToolActivity("db"), { discovered: 3, active: 1, expected: 1 });
    assert.deepEqual(bridge.getInactiveDirectTools("db"), []);
    assert.deepEqual(bridge.getInactiveDirectTools("unknown"), []);
    const byName = new Map(registered.map((tool) => [tool.name, tool]));
    assert.equal(byName.get("mcp_db_get_status")?.defaultActive, false);
    assert.equal(byName.get("mcp_db_delete_user")?.defaultActive, false);
    assert.equal(
      byName.get("mcp_db_search_users")?.defaultActive,
      undefined,
      "a direct tool keeps Pi's default activation",
    );
  });

  it("never activates a newly discovered non-direct tool on a live refresh", async () => {
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: () => {},
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };
    const bridge = new ToolBridge(BRIDGE_SETTINGS, mockPi);
    const toolNames = ["echo"];
    const exposure = { exposure: "hidden", toolExposure: { echo: "direct" } } as const;

    await bridge.refreshTools("db", listingClient(toolNames), exposure);
    assert.deepEqual(activeTools, ["mcp_db_echo"]);

    toolNames.push("search");
    await bridge.refreshTools("db", listingClient(toolNames), exposure);
    assert.deepEqual(activeTools, ["mcp_db_echo"], "a new deferred tool must not be activated");
    assert.deepEqual(bridge.getToolActivity("db"), { discovered: 2, active: 1, expected: 1 });
  });

  it("preserves a deferred tool that tool_search activated, until the server reconnects", async () => {
    const toolNames = ["echo", "search"];
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: () => {},
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };
    const bridge = new ToolBridge(BRIDGE_SETTINGS, mockPi);
    const exposure = { exposure: "deferred", toolExposure: { echo: "direct" } } as const;

    await bridge.refreshTools("db", listingClient(toolNames), exposure);
    assert.deepEqual(activeTools, ["mcp_db_echo"]);

    // Pi's `tool_search` loads the deferred tool into the active set; a later refresh must
    // neither drop it nor turn its activation into a permanent exemption.
    activeTools = [...activeTools, "mcp_db_search"];
    await bridge.refreshTools("db", listingClient(toolNames), exposure);
    assert.deepEqual(activeTools, ["mcp_db_echo", "mcp_db_search"]);
    assert.deepEqual(bridge.getToolActivity("db"), { discovered: 2, active: 2, expected: 1 });

    // The verification helper reports the missing direct tool by name, even though the totals
    // still add up (active 1 = expected 1: a loaded deferred tool replaced it).
    activeTools = ["mcp_db_search"];
    assert.deepEqual(
      bridge.getInactiveDirectTools("db"),
      ["mcp_db_echo"],
      "a tool_search-loaded deferred tool must not hide an inactive direct tool behind the counts",
    );
    assert.deepEqual(bridge.getToolActivity("db"), { discovered: 2, active: 1, expected: 1 });

    // A reconnect after a stop re-derives the active set from exposure alone.
    bridge.deactivateServer("db");
    await bridge.refreshTools("db", listingClient(toolNames), exposure);
    assert.deepEqual(activeTools, ["mcp_db_echo"]);
    assert.deepEqual(bridge.getInactiveDirectTools("db"), []);
  });

  it("maps MCP codemode onto Pi deferred and attaches sanitized namespace metadata", async () => {
    const registered = new Map<string, TestToolDefinition>();
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: (t: unknown) => {
        const tool = t as TestToolDefinition;
        registered.set(tool.name, tool);
      },
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };
    const bridge = new ToolBridge(BRIDGE_SETTINGS, mockPi);
    // Build synthetic credential shapes at runtime so secret-scan never sees a literal key=secret.
    const fakeToken = ["secret", "abc123"].join("-");
    const fakeApiKey = ["secret", "xyz789"].join("-");
    const client = {
      request: async () => ({
        tools: [{ name: "query", inputSchema: { type: "object" } }],
      }),
      getInstructions: () => `Prefer read queries; token=${fakeToken}`,
    } as unknown as Client;

    await bridge.refreshTools("my-db", client, {
      exposure: "codemode",
      description: `Analytics warehouse api_key=${fakeApiKey}`,
    });

    const tool = registered.get("mcp_my_db_query");
    assert.ok(tool);
    assert.equal(
      tool.exposure,
      "deferred",
      "MCP codemode must register as Pi deferred so createCodemodeDescription never inlines schemas",
    );
    assert.equal(tool.defaultActive, false);
    assert.deepEqual(activeTools, []);
    assert.deepEqual(tool.namespace, {
      name: "mcp_my_db",
      aliases: ["my-db", "mcp__my_db"],
      description: "Analytics warehouse api_key=[REDACTED]",
      instructions: "Prefer read queries; token=[REDACTED]",
    });
  });

  it("re-registers stopped, removed, and withdrawn tools as hidden and rejects stale execute calls", async () => {
    const registrations: TestToolDefinition[] = [];
    const latestByName = new Map<string, TestToolDefinition>();
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: (t: unknown) => {
        const tool = t as TestToolDefinition;
        registrations.push(tool);
        latestByName.set(tool.name, tool);
      },
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };
    const bridge = new ToolBridge(BRIDGE_SETTINGS, mockPi);
    let currentTools = ["echo", "withdrawn", "secret"];
    let clientCallCount = 0;
    const client = {
      request: async () => ({
        tools: currentTools.map((name) => ({ name, inputSchema: { type: "object" } })),
      }),
      callTool: async () => {
        clientCallCount += 1;
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as Client;
    const exposure = {
      exposure: "codemode",
      toolExposure: { echo: "direct", secret: "hidden" },
    } as const;

    await bridge.refreshTools("db", client, exposure);
    // A hidden tool cannot be executed even while the server is connected
    await assert.rejects(
      () => latestByName.get("mcp_db_secret")!.execute("id-1", {}, undefined, undefined, undefined),
      (err: unknown) => err instanceof McpError && err.code === "tool",
    );
    assert.equal(clientCallCount, 0);

    // Live withdrawal hides the dropped tool and blocks stale execute calls
    const staleWithdrawn = latestByName.get("mcp_db_withdrawn")!;
    currentTools = ["echo", "secret"];
    await bridge.refreshTools("db", client, exposure);
    assert.equal(latestByName.get("mcp_db_withdrawn")?.exposure, "hidden");
    await assert.rejects(
      () => staleWithdrawn.execute("id-2", {}, undefined, undefined, undefined),
      (err: unknown) => err instanceof McpError && err.code === "tool",
    );
    assert.equal(clientCallCount, 0);

    // Stopping the server hides remaining non-hidden tools and skips already-hidden ones
    const countBeforeStop = registrations.length;
    bridge.deactivateServer("db");
    assert.equal(latestByName.get("mcp_db_echo")?.exposure, "hidden");
    assert.equal(latestByName.get("mcp_db_echo")?.defaultActive, false);
    assert.equal(
      registrations.length - countBeforeStop,
      1,
      "only non-hidden owned tools need a hiding re-registration on stop",
    );
    await assert.rejects(
      () => latestByName.get("mcp_db_echo")!.execute("id-3", {}, undefined, undefined, undefined),
      (err: unknown) => err instanceof McpError && err.code === "connection",
    );
    assert.equal(clientCallCount, 0);

    // Removing an already-stopped server does not redundantly re-register hidden tools
    const countBeforeRemove = registrations.length;
    bridge.removeServerTools("db");
    assert.equal(registrations.length, countBeforeRemove);

    // Reconnecting restores normal exposure and callability
    await bridge.refreshTools("db", client, exposure);
    assert.equal(latestByName.get("mcp_db_echo")?.exposure, "direct");
    const ok = await latestByName
      .get("mcp_db_echo")!
      .execute("id-4", {}, undefined, undefined, undefined);
    assert.equal(clientCallCount, 1);
    assert.equal(ok.content[0]?.type, "text");
  });

  it("applies live exposure narrowing, widening, and hidden enforcement on refreshTools", async () => {
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: () => {},
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };
    const bridge = new ToolBridge(BRIDGE_SETTINGS, mockPi);
    const tools = ["alpha", "beta", "gamma"];

    await bridge.refreshTools("db", listingClient(tools), {
      exposure: "direct",
      toolExposure: { beta: "deferred", gamma: "hidden" },
    });
    assert.deepEqual(activeTools, ["mcp_db_alpha"]);

    // Even if an external caller forced a hidden tool into activeTools, a live refresh strips it;
    // narrowing alpha (direct -> deferred) deactivates it, and widening beta (deferred -> direct) activates it.
    activeTools = ["mcp_db_alpha", "mcp_db_gamma"];
    await bridge.refreshTools("db", listingClient(tools), {
      exposure: "deferred",
      toolExposure: { beta: "direct", gamma: "hidden" },
    });
    assert.deepEqual(activeTools, ["mcp_db_beta"]);
  });

  it("auto-activates reaching codemode / tool_search tools and warns when unreachable or filtered by --tools", async () => {
    let activeTools = ["read"];
    let baseTools: Array<{ name: string; reachesTools?: boolean }> = [
      { name: "read" },
      { name: "codemode", reachesTools: true },
      { name: "tool_search", reachesTools: true },
    ];
    let allowMcpTools = true;
    const registeredMcp = new Map<string, { name: string }>();
    const warnings: string[] = [];
    const mockPi = {
      registerTool: (def: { name: string }) => {
        if (allowMcpTools) {
          registeredMcp.set(def.name, { name: def.name });
        }
      },
      getAllTools: () => [...baseTools, ...registeredMcp.values()],
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };
    const bridge = new ToolBridge(BRIDGE_SETTINGS, mockPi);
    bridge.setDiscoveryWarningCallback((msg) => warnings.push(msg));

    // Pre-activating from configured exposures adds codemode before tool_search deterministically
    bridge.ensureDiscoveryTools(["deferred", "codemode"]);
    assert.deepEqual(activeTools, ["read", "codemode", "tool_search"]);
    assert.deepEqual(warnings, []);

    // With autoEnableCodemode: false and neither discovery tool active, refreshTools warns
    activeTools = ["read"];
    bridge.setAutoEnableCodemode(false);
    await bridge.refreshTools("cm", listingClient(["run"]), { exposure: "codemode" });
    assert.deepEqual(activeTools, ["read"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /\(autoEnableCodemode is false\)/);

    // Non-reaching tools of the same name are ignored and trigger an unreachable warning
    baseTools = [{ name: "tool_search", reachesTools: false }];
    await bridge.refreshTools("def", listingClient(["find"]), { exposure: "deferred" });
    assert.deepEqual(activeTools, ["read"]);
    assert.equal(warnings.length, 2);

    // When Pi's --tools filter drops single-underscore mcp_* tools from getAllTools(),
    // ToolBridge flags the server, excludes filtered exposures, and emits an actionable warning
    baseTools = [{ name: "read" }, { name: "codemode", reachesTools: true }];
    registeredMcp.clear();
    allowMcpTools = false;
    bridge.setAutoEnableCodemode(true);
    await bridge.refreshTools("filtered", listingClient(["query"]), { exposure: "codemode" });
    assert.equal(bridge.hasAllIndirectToolsFiltered("filtered"), true);
    assert.deepEqual([...bridge.getServerExposures("filtered")], []);
    assert.equal(warnings.length, 3);
    assert.match(warnings[2]!, /include mcp_\* in --tools/);

    bridge.deactivateServer("filtered");
    assert.equal(bridge.hasAllIndirectToolsFiltered("filtered"), false);
  });

  it("does not resurrect another server's deactivated direct tool when deactivateServer or removeServerTools triggers --tools registry refresh", async () => {
    let activeTools = ["read"];
    const registered = new Map<string, TestToolDefinition>();
    const mockPi = {
      registerTool: (t: unknown) => {
        const def = t as TestToolDefinition & { exposure?: string; defaultActive?: boolean };
        registered.set(def.name, def);
        // Simulate Pi's AgentSession._refreshToolRegistry() when `--tools read,mcp_*` is active:
        // every registerTool() re-adds all declarable allowlisted tools into activeTools.
        const next = new Set(activeTools);
        for (const [name, entry] of registered) {
          const entryDef = entry as TestToolDefinition & { exposure?: string; defaultActive?: boolean };
          if (entryDef.exposure !== "hidden" && entryDef.defaultActive !== false) {
            next.add(name);
          } else {
            next.delete(name);
          }
        }
        activeTools = [...next];
      },
      getActiveTools: () => [...activeTools],
      setActiveTools: (names: string[]) => {
        activeTools = [...names];
      },
    };

    const bridge = new ToolBridge(BRIDGE_SETTINGS, mockPi);
    await bridge.refreshTools("alpha", listingClient(["keep", "muted"]));
    await bridge.refreshTools("beta", listingClient(["ping"]));

    // User/policy mutes `mcp_alpha_muted` while keeping `mcp_alpha_keep` and `mcp_beta_ping`
    activeTools = ["read", "mcp_alpha_keep", "mcp_beta_ping"];

    // Stopping `beta` calls registerTool(hidden) on `mcp_beta_ping`; `mcp_alpha_muted` must stay muted
    bridge.deactivateServer("beta");
    assert.deepEqual(activeTools, ["read", "mcp_alpha_keep"]);

    // Reconnect `beta`, mute `mcp_alpha_muted` again, and remove `beta` altogether
    await bridge.refreshTools("beta", listingClient(["ping"]));
    activeTools = ["read", "mcp_alpha_keep", "mcp_beta_ping"];
    bridge.removeServerTools("beta");
    assert.deepEqual(activeTools, ["read", "mcp_alpha_keep"]);
  });

  it("keeps externally deactivated tools inactive across a live tools/list_changed refresh", async () => {
    let activeTools: string[] = [];
    let setActiveToolCalls = 0;
    const mockPi = {
      registerTool: () => {},
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => {
        setActiveToolCalls += 1;
        activeTools = names;
      },
    };

    let serverTools = [
      { name: "read_data", inputSchema: { type: "object" } },
      { name: "drop_table", inputSchema: { type: "object" } },
    ];
    const mockClient = {
      request: async () => ({ tools: serverTools }),
    } as unknown as Client;

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);

    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(activeTools, ["mcp_db_drop_table", "mcp_db_read_data"]);
    assert.equal(setActiveToolCalls, 1, "The first connect activates the whole discovered set");

    // Another extension or a user policy narrows the active set while the server stays ready.
    activeTools = ["mcp_db_read_data"];

    // The server then adds a tool and announces it with notifications/tools/list_changed.
    serverTools = [...serverTools, { name: "list_tables", inputSchema: { type: "object" } }];
    await bridge.refreshTools("db", mockClient);

    assert.deepEqual(
      activeTools,
      ["mcp_db_list_tables", "mcp_db_read_data"],
      "A live refresh must not re-activate a tool another extension deactivated",
    );
    assert.equal(setActiveToolCalls, 2);

    // A refresh that discovers nothing new must leave a narrowed set untouched.
    activeTools = [];
    await bridge.refreshTools("db", mockClient);
    assert.equal(
      setActiveToolCalls,
      2,
      "A no-op refresh must not write the active set at all",
    );
  });

  it("keeps a re-advertised tool inactive when a policy had deactivated it before the drop", async () => {
    let activeTools: string[] = [];
    let setActiveToolCalls = 0;
    const mockPi = {
      registerTool: () => {},
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => {
        setActiveToolCalls += 1;
        activeTools = names;
      },
    };

    const readData = { name: "read_data", inputSchema: { type: "object" } };
    const dropTable = { name: "drop_table", inputSchema: { type: "object" } };
    let serverTools = [readData, dropTable];
    const mockClient = {
      request: async () => ({ tools: serverTools }),
    } as unknown as Client;

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);

    await bridge.refreshTools("db", mockClient);
    assert.equal(setActiveToolCalls, 1);
    activeTools = ["mcp_db_read_data"]; // policy deactivates the destructive tool

    serverTools = [readData]; // the server stops advertising it
    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(activeTools, ["mcp_db_read_data"]);
    assert.equal(
      setActiveToolCalls,
      1,
      "Dropping a tool that is already inactive must not rewrite the active set",
    );

    serverTools = [readData, dropTable]; // ...and later advertises it again
    await bridge.refreshTools("db", mockClient);

    assert.deepEqual(
      activeTools,
      ["mcp_db_read_data"],
      "A re-advertised tool must keep the inactive state a policy gave it",
    );
    assert.equal(
      setActiveToolCalls,
      1,
      "Re-advertising an inactive tool must not rewrite the active set",
    );
  });

  it("restores a re-advertised tool that the server had dropped while it was active", async () => {
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: () => {},
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };

    const readData = { name: "read_data", inputSchema: { type: "object" } };
    const dropTable = { name: "drop_table", inputSchema: { type: "object" } };
    let serverTools = [readData, dropTable];
    const mockClient = {
      request: async () => ({ tools: serverTools }),
    } as unknown as Client;

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);

    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(activeTools, ["mcp_db_drop_table", "mcp_db_read_data"]);

    serverTools = [readData];
    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(activeTools, ["mcp_db_read_data"], "A dropped tool is deactivated");

    serverTools = [readData, dropTable];
    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(
      activeTools,
      ["mcp_db_drop_table", "mcp_db_read_data"],
      "A tool the bridge deactivated with the server comes back active",
    );
  });

  it("forgets a dropped tool's state when the server is stopped, so a reconnect starts clean", async () => {
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: () => {},
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };

    const readData = { name: "read_data", inputSchema: { type: "object" } };
    const slowTool = { name: "slow_tool", inputSchema: { type: "object" } };
    let serverTools = [readData, slowTool];
    const mockClient = {
      request: async () => ({ tools: serverTools }),
    } as unknown as Client;

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);

    await bridge.refreshTools("db", mockClient);
    activeTools = ["mcp_db_read_data"]; // a policy deactivates slow_tool
    serverTools = [readData]; // the server drops it, so the drop is remembered as inactive
    await bridge.refreshTools("db", mockClient);

    bridge.deactivateServer("db"); // /mcp:stop
    await bridge.refreshTools("db", mockClient); // reconnect, server lists only read_data

    serverTools = [readData, slowTool]; // the new connection later exposes slow_tool
    await bridge.refreshTools("db", mockClient);

    assert.deepEqual(
      activeTools,
      ["mcp_db_read_data", "mcp_db_slow_tool"],
      "A tool first discovered on a new connection must be activated",
    );

    // Stopping while slow_tool is still registered, reconnecting when only read_data is
    // initially listed, and then exposing slow_tool later must also activate slow_tool —
    // the reconnect handshake must not record previous-connection tools as dropped-inactive.
    bridge.deactivateServer("db");
    serverTools = [readData];
    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(activeTools, ["mcp_db_read_data"]);

    serverTools = [readData, slowTool];
    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(
      activeTools,
      ["mcp_db_read_data", "mcp_db_slow_tool"],
      "A tool absent from a reconnect's initial list must still activate when advertised later",
    );
  });

  it("activates a new tool that recycles a dropped tool's Pi name without losing the dropped tool's state", async () => {
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: () => {},
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };

    const dashed = { name: "a-b", inputSchema: { type: "object" } };
    const underscored = { name: "a_b", inputSchema: { type: "object" } };
    let serverTools = [underscored];
    const mockClient = {
      request: async () => ({ tools: serverTools }),
    } as unknown as Client;

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);

    await bridge.refreshTools("db", mockClient);
    activeTools = []; // a policy deactivates mcp_db_a_b (`a_b`)
    serverTools = []; // ...and the server drops the tool that held that name
    await bridge.refreshTools("db", mockClient);

    // `a-b` sanitizes to the same Pi name; it was never deactivated by anyone.
    serverTools = [dashed];
    await bridge.refreshTools("db", mockClient);

    assert.deepEqual(
      activeTools,
      ["mcp_db_a_b"],
      "A recycled Pi name belongs to a new tool and must be activated",
    );

    // Dropping `a-b` (while active at mcp_db_a_b) and re-advertising `a_b` must still
    // remember that `a_b` was deactivated by policy rather than overwritten by `a-b`.
    serverTools = [];
    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(activeTools, []);

    serverTools = [underscored];
    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(
      activeTools,
      [],
      "A dropped tool's inactive state must survive another tool temporarily recycling its Pi name",
    );
  });

  it("preserves each tool's active state when a colliding sibling re-settles Pi names across live refreshes", async () => {
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: () => {},
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };

    const dashed = { name: "a-b", inputSchema: { type: "object" } };
    const underscored = { name: "a_b", inputSchema: { type: "object" } };
    const dashedHashed = buildToolName("mcp", "db", "a-b", true);
    let serverTools = [dashed];
    const mockClient = {
      request: async () => ({ tools: serverTools }),
    } as unknown as Client;

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);

    // 1. `a-b` alone owns the unhashed name `mcp_db_a_b`; a policy deactivates it.
    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(activeTools, ["mcp_db_a_b"]);
    activeTools = [];

    // 2. Adding `a_b` re-settles the group: `a_b` wins `mcp_db_a_b` (and must activate as
    //    new), while `a-b` moves to its hashed name and must stay inactive.
    serverTools = [dashed, underscored];
    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(
      activeTools,
      ["mcp_db_a_b"],
      "The new lossless tool activates at the unhashed name while the shifted lossy tool stays inactive",
    );

    // 3. Dropping `a_b` moves `a-b` back into `mcp_db_a_b`; `a-b` was inactive and must
    //    not inherit `a_b`'s active state at the unhashed name.
    serverTools = [dashed];
    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(
      activeTools,
      [],
      "A deactivated lossy tool moving back to the unhashed name must stay inactive",
    );

    // 4. Re-adding `a_b` restores `a_b` as active at `mcp_db_a_b`. Now flip the policy:
    //    deactivate `a_b` (`mcp_db_a_b`) and activate `a-b` (`dashedHashed`), then drop `a_b`.
    serverTools = [dashed, underscored];
    await bridge.refreshTools("db", mockClient);
    activeTools = [dashedHashed];

    serverTools = [dashed];
    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(
      activeTools,
      ["mcp_db_a_b"],
      "An active lossy tool moving back to the unhashed name must stay active there",
    );
  });

  it("re-activates every discovered tool after a stop and reconnect", async () => {
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: () => {},
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };

    const mockClient = {
      request: async () => ({
        tools: [
          { name: "read_data", inputSchema: { type: "object" } },
          { name: "drop_table", inputSchema: { type: "object" } },
        ],
      }),
    } as unknown as Client;

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);

    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(activeTools, ["mcp_db_drop_table", "mcp_db_read_data"]);

    // A reconnect is a fresh start: the previous restriction no longer holds.
    bridge.deactivateServer("db");
    assert.deepEqual(activeTools, []);
    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(
      activeTools,
      ["mcp_db_drop_table", "mcp_db_read_data"],
      "Reconnecting must activate every tool the server discovers",
    );
  });

  it("orders bridged tools deterministically regardless of sequential connect order", async () => {
    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const clientWith = (names: string[]) =>
      ({
        request: async () => ({
          tools: names.map((name) => ({ name, inputSchema: { type: "object" } })),
        }),
      }) as unknown as Client;
    const activeAfterConnects = async (
      order: Array<[string, Client]>,
    ): Promise<string[]> => {
      let activeTools: string[] = [];
      const bridge = new ToolBridge(settings, {
        registerTool: () => {},
        getActiveTools: () => activeTools,
        setActiveTools: (names: string[]) => { activeTools = names; },
      });
      for (const [server, mockClient] of order) await bridge.refreshTools(server, mockClient);
      return activeTools;
    };

    const alpha = (): Client => clientWith(["alpha_one", "alpha_two"]);
    const beta = (): Client => clientWith(["beta_one", "beta_two"]);

    const alphaFirst = await activeAfterConnects([["alpha", alpha()], ["beta", beta()]]);
    const betaFirst = await activeAfterConnects([["beta", beta()], ["alpha", alpha()]]);

    assert.deepEqual(
      alphaFirst,
      betaFirst,
      "Concurrent eager connects must not change the tool order (#278)",
    );
    assert.deepEqual(alphaFirst, [
      "mcp_alpha_alpha_one",
      "mcp_alpha_alpha_two",
      "mcp_beta_beta_one",
      "mcp_beta_beta_two",
    ]);
  });

  it("orders bridged tools deterministically when concurrent connects finish in either order", async () => {
    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const deferredClient = (names: string[]) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const client = {
        request: async () => {
          await gate;
          return {
            tools: names.map((name) => ({ name, inputSchema: { type: "object" } })),
          };
        },
      } as unknown as Client;
      return { client, release };
    };
    const connectBoth = async (first: "alpha" | "beta"): Promise<string[]> => {
      let activeTools: string[] = [];
      const bridge = new ToolBridge(settings, {
        registerTool: () => {},
        getActiveTools: () => activeTools,
        setActiveTools: (names: string[]) => { activeTools = names; },
      });
      const alpha = deferredClient(["one", "two"]);
      const beta = deferredClient(["one", "two"]);
      // Both refreshTools calls start together and wait on their in-flight tools/list requests.
      const pending = Promise.all([
        bridge.refreshTools("alpha", alpha.client),
        bridge.refreshTools("beta", beta.client),
      ]);
      if (first === "alpha") {
        alpha.release();
        await Promise.resolve();
        beta.release();
      } else {
        beta.release();
        await Promise.resolve();
        alpha.release();
      }
      await pending;
      return activeTools;
    };

    const alphaFirst = await connectBoth("alpha");
    const betaFirst = await connectBoth("beta");

    assert.deepEqual(
      alphaFirst,
      betaFirst,
      "Whichever eager connect finishes last, the active order is the same",
    );
    assert.deepEqual(alphaFirst, [
      "mcp_alpha_one",
      "mcp_alpha_two",
      "mcp_beta_one",
      "mcp_beta_two",
    ]);
  });

  it("orders a server's tools by name regardless of tools/list order", async () => {
    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const activeWithListOrder = async (names: string[]): Promise<string[]> => {
      let activeTools: string[] = [];
      const bridge = new ToolBridge(settings, {
        registerTool: () => {},
        getActiveTools: () => activeTools,
        setActiveTools: (next: string[]) => { activeTools = next; },
      });
      const mockClient = {
        request: async () => ({
          tools: names.map((name) => ({ name, inputSchema: { type: "object" } })),
        }),
      } as unknown as Client;
      await bridge.refreshTools("alpha", mockClient);
      return activeTools;
    };

    const ascending = await activeWithListOrder(["alpha_one", "alpha_two"]);
    const descending = await activeWithListOrder(["alpha_two", "alpha_one"]);

    assert.deepEqual(descending, ascending, "tools/list order is not part of the MCP contract");
    assert.deepEqual(ascending, ["mcp_alpha_alpha_one", "mcp_alpha_alpha_two"]);
  });

  it("rewrites a stable order when another extension reorders the same set", async () => {
    // The desired set is unchanged; only the order differs, and the bridge still normalises it.
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: () => {},
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };
    const mockClient = {
      request: async () => ({
        tools: [
          { name: "read_data", inputSchema: { type: "object" } },
          { name: "drop_table", inputSchema: { type: "object" } },
        ],
      }),
    } as unknown as Client;

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);
    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(activeTools, ["mcp_db_drop_table", "mcp_db_read_data"]);

    activeTools = ["mcp_db_read_data", "mcp_db_drop_table"];
    await bridge.refreshTools("db", mockClient);

    assert.deepEqual(activeTools, ["mcp_db_drop_table", "mcp_db_read_data"]);
  });

  it("orders this bridge's tools in an outgoing provider payload", async () => {
    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    let activeTools: string[] = [];
    const bridge = new ToolBridge(settings, {
      registerTool: () => {},
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    });
    await bridge.refreshTools("db", {
      request: async () => ({
        tools: [
          { name: "a_tool", inputSchema: { type: "object" } },
          { name: "z_tool", inputSchema: { type: "object" } },
        ],
      }),
    } as unknown as Client);

    const foreign = { type: "function", function: { name: "bash" } };
    const payload = {
      model: "test-model",
      tools: [
        { type: "function", function: { name: "mcp_db_z_tool" } },
        foreign,
        { type: "function", function: { name: "mcp_db_a_tool" } },
      ],
    };

    const ordered = bridge.orderPayloadTools(payload) as {
      model: string;
      tools: Array<{ type?: string; name?: string; function?: { name?: string } }>;
    };
    const names = ordered.tools.map((tool) => tool.function?.name ?? tool.name);

    assert.deepEqual(
      names,
      ["mcp_db_a_tool", "bash", "mcp_db_z_tool"],
      "Only this bridge's tools move, and only among the slots they already hold",
    );
    assert.equal(ordered.model, "test-model");
    assert.equal(ordered.tools[1], foreign, "another extension's definition keeps its slot");
    assert.equal(
      (payload.tools[0] as { function: { name: string } }).function.name,
      "mcp_db_z_tool",
      "The caller's payload is not mutated",
    );
  });

  it("keeps Pi's reserved trailing declaration and slot cache_control in place", async () => {
    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    let activeTools: string[] = [];
    const bridge = new ToolBridge(settings, {
      registerTool: () => {},
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    });
    await bridge.refreshTools("db", {
      request: async () => ({
        tools: [
          { name: "a_tool", inputSchema: { type: "object" } },
          { name: "z_tool", inputSchema: { type: "object" } },
        ],
      }),
    } as unknown as Client);

    // Pi attaches `cache_control` to the last non-placeholder tool slot and appends
    // `__pi_deferred_placeholder__` after it on Anthropic models with native tool changes.
    // Reordering must keep the placeholder last AND keep `cache_control` anchored on slot 1
    // so the reordered payload matches a session that started in sorted order.
    const cacheControl = { type: "ephemeral" };
    const placeholder = { name: "__pi_deferred_placeholder__", defer_loading: true };
    const aWithCache = { name: "mcp_db_a_tool", cache_control: cacheControl };
    const payload = {
      tools: [{ name: "mcp_db_z_tool" }, aWithCache, placeholder],
    };

    const ordered = bridge.orderPayloadTools(payload) as {
      tools: Array<{ name: string; cache_control?: unknown }>;
    };

    assert.deepEqual(ordered.tools, [
      { name: "mcp_db_a_tool" },
      { name: "mcp_db_z_tool", cache_control: cacheControl },
      placeholder,
    ]);
    assert.equal("cache_control" in (ordered.tools[0] ?? {}), false);
    assert.equal(ordered.tools[2], placeholder);
    assert.deepEqual(
      aWithCache,
      { name: "mcp_db_a_tool", cache_control: cacheControl },
      "The caller's tool definition is not mutated",
    );
  });

  it("leaves an already ordered payload, and a payload without tools, untouched", async () => {
    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, {
      registerTool: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
    });
    await bridge.refreshTools("db", {
      request: async () => ({
        tools: [
          { name: "a_tool", inputSchema: { type: "object" } },
          { name: "z_tool", inputSchema: { type: "object" } },
        ],
      }),
    } as unknown as Client);

    // Anthropic-style definitions carry `name` at the top level.
    const unordered = { tools: [{ name: "mcp_db_z_tool" }, { name: "bash" }, { name: "mcp_db_a_tool" }] };
    const ordered = bridge.orderPayloadTools(unordered) as { tools: Array<{ name: string }> };
    assert.deepEqual(ordered.tools.map((tool) => tool.name), ["mcp_db_a_tool", "bash", "mcp_db_z_tool"]);
    assert.equal(bridge.orderPayloadTools(ordered), ordered, "An ordered payload is returned as is");

    const withoutTools = { model: "test-model" };
    assert.equal(bridge.orderPayloadTools(withoutTools), withoutTools);
    assert.equal(bridge.orderPayloadTools(undefined), undefined);
  });

  it("orders Google/Vertex config.tools[].functionDeclarations and leaves non-function tool groups untouched", async () => {
    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, {
      registerTool: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
    });
    await bridge.refreshTools("db", {
      request: async () => ({
        tools: [
          { name: "a_tool", inputSchema: { type: "object" } },
          { name: "z_tool", inputSchema: { type: "object" } },
        ],
      }),
    } as unknown as Client);

    const googleSearchGroup = { googleSearch: {} };
    const foreignRead = { name: "read", description: "Read file" };
    const functionGroup = {
      functionDeclarations: [
        { name: "mcp_db_z_tool" },
        foreignRead,
        { name: "mcp_db_a_tool" },
      ],
    };
    const payload = {
      model: "gemini-2.5-pro",
      contents: [],
      config: {
        systemInstruction: "sys",
        tools: [googleSearchGroup, functionGroup],
      },
    };

    const ordered = bridge.orderPayloadTools(payload) as {
      model: string;
      config: {
        systemInstruction: string;
        tools: Array<{ googleSearch?: Record<string, never>; functionDeclarations?: Array<{ name: string }> }>;
      };
    };

    assert.equal(ordered.config.tools[0], googleSearchGroup, "non-function Gemini tool group keeps its reference");
    assert.deepEqual(
      ordered.config.tools[1]?.functionDeclarations?.map((decl) => decl.name),
      ["mcp_db_a_tool", "read", "mcp_db_z_tool"],
    );
    assert.equal(ordered.config.tools[1]?.functionDeclarations?.[1], foreignRead);
    assert.equal(
      functionGroup.functionDeclarations[0]?.name,
      "mcp_db_z_tool",
      "The caller's Google payload is not mutated",
    );
    assert.equal(bridge.orderPayloadTools(ordered), ordered, "An ordered Google payload is returned as is");
  });

  it("orders AWS Bedrock Converse toolConfig.tools and keeps trailing cachePoint and toolChoice intact", async () => {
    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, {
      registerTool: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
    });
    await bridge.refreshTools("db", {
      request: async () => ({
        tools: [
          { name: "a_tool", inputSchema: { type: "object" } },
          { name: "z_tool", inputSchema: { type: "object" } },
        ],
      }),
    } as unknown as Client);

    const foreignBash = { toolSpec: { name: "bash" } };
    const cachePoint = { cachePoint: { type: "default" } };
    const toolChoice = { auto: {} };
    const payload = {
      modelId: "anthropic.claude-sonnet-4-6",
      toolConfig: {
        tools: [
          { toolSpec: { name: "mcp_db_z_tool" } },
          foreignBash,
          { toolSpec: { name: "mcp_db_a_tool" } },
          cachePoint,
        ],
        toolChoice,
      },
    };

    const ordered = bridge.orderPayloadTools(payload) as {
      modelId: string;
      toolConfig: {
        tools: Array<{ toolSpec?: { name: string }; cachePoint?: { type: string } }>;
        toolChoice: unknown;
      };
    };

    assert.deepEqual(ordered.toolConfig.tools, [
      { toolSpec: { name: "mcp_db_a_tool" } },
      foreignBash,
      { toolSpec: { name: "mcp_db_z_tool" } },
      cachePoint,
    ]);
    assert.equal(ordered.toolConfig.tools[1], foreignBash);
    assert.equal(ordered.toolConfig.tools[3], cachePoint);
    assert.equal(ordered.toolConfig.toolChoice, toolChoice);
    assert.equal(
      (payload.toolConfig.tools[0] as { toolSpec: { name: string } }).toolSpec.name,
      "mcp_db_z_tool",
      "The caller's Bedrock payload is not mutated",
    );
    assert.equal(bridge.orderPayloadTools(ordered), ordered, "An ordered Bedrock payload is returned as is");
  });

  it("orders pi-messages context.messages[].toolsAdded per system message while leaving non-system messages untouched", async () => {
    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, {
      registerTool: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
    });
    await bridge.refreshTools("db", {
      request: async () => ({
        tools: [
          { name: "a_tool", inputSchema: { type: "object" } },
          { name: "z_tool", inputSchema: { type: "object" } },
        ],
      }),
    } as unknown as Client);

    type PiMessagesEntry = {
      role: string;
      content: unknown;
      toolsAdded?: Array<{ name: string; description: string; parameters: { type: string } }>;
      toolsRemoved?: Array<{ name: string }>;
      timestamp: number;
    };
    const foreignRead = { name: "read", description: "Read", parameters: { type: "object" } };
    const userMsg: PiMessagesEntry = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
    const alreadyOrderedSystemMsg: PiMessagesEntry = {
      role: "system",
      content: "",
      toolsAdded: [{ name: "mcp_db_a_tool", description: "A", parameters: { type: "object" } }],
      toolsRemoved: [{ name: "mcp_db_z_tool" }],
      timestamp: 2,
    };
    const options = { temperature: 0, cacheRetention: "long" };
    const payload: { model: string; context: { messages: PiMessagesEntry[] }; options: typeof options } = {
      model: "claude-sonnet-4-6",
      context: {
        messages: [
          {
            role: "system",
            content: "base prompt",
            toolsAdded: [
              { name: "mcp_db_z_tool", description: "Z", parameters: { type: "object" } },
              foreignRead,
              { name: "mcp_db_a_tool", description: "A", parameters: { type: "object" } },
            ],
            timestamp: 0,
          },
          userMsg,
          alreadyOrderedSystemMsg,
        ],
      },
      options,
    };

    const ordered = bridge.orderPayloadTools(payload) as typeof payload;
    assert.deepEqual(
      ordered.context.messages[0]?.toolsAdded?.map((tool) => tool.name),
      ["mcp_db_a_tool", "read", "mcp_db_z_tool"],
    );
    assert.equal(ordered.context.messages[0]?.toolsAdded?.[1], foreignRead);
    assert.equal(ordered.context.messages[1], userMsg, "Non-system messages keep their reference");
    assert.equal(
      ordered.context.messages[2],
      alreadyOrderedSystemMsg,
      "System messages whose toolsAdded needs no reorder keep their reference",
    );
    assert.equal(ordered.options, options);
    assert.equal(
      payload.context.messages[0]?.toolsAdded?.[0]?.name,
      "mcp_db_z_tool",
      "The caller's pi-messages payload is not mutated",
    );
    assert.equal(bridge.orderPayloadTools(ordered), ordered, "An ordered pi-messages payload is returned as is");
  });

  it("re-orders active owned tools on orderActiveTools without re-activating inactive tools or writing when ordered", async () => {
    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    let activeTools: string[] = ["bash"];
    let writes = 0;
    const bridge = new ToolBridge(settings, {
      registerTool: () => {},
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => {
        writes += 1;
        activeTools = names;
      },
    });
    const clientFor = (name: string): Client =>
      ({
        request: async () => ({
          tools: [{ name, inputSchema: { type: "object" } }],
        }),
      }) as unknown as Client;

    await bridge.refreshTools("alpha", clientFor("a_tool"));
    await bridge.refreshTools("beta", clientFor("b_tool"));
    await bridge.refreshTools("gamma", clientFor("g_tool"));
    assert.deepEqual(activeTools, ["bash", "mcp_alpha_a_tool", "mcp_beta_b_tool", "mcp_gamma_g_tool"]);

    const writesAfterConnect = writes;
    bridge.orderActiveTools();
    assert.equal(writes, writesAfterConnect, "Already-ordered active list must not trigger setActiveTools");

    // Simulate `/tree` restoring transcript first-appearance order after `beta` connected mid-session.
    activeTools = ["bash", "mcp_alpha_a_tool", "mcp_gamma_g_tool", "mcp_beta_b_tool"];
    bridge.orderActiveTools();
    assert.deepEqual(activeTools, ["bash", "mcp_alpha_a_tool", "mcp_beta_b_tool", "mcp_gamma_g_tool"]);
    assert.equal(writes, writesAfterConnect + 1);

    // Simulate `/tree` navigating back to an earlier branch where `beta` was not active yet.
    activeTools = ["mcp_gamma_g_tool", "bash", "mcp_alpha_a_tool"];
    bridge.orderActiveTools();
    assert.deepEqual(
      activeTools,
      ["mcp_alpha_a_tool", "bash", "mcp_gamma_g_tool"],
      "Inactive server tools must stay inactive while active owned slots are ordered",
    );
  });

  it("keeps other extensions' tools in their own positions", async () => {
    let activeTools: string[] = ["bash", "read", "other_ext_tool"];
    const mockPi = {
      registerTool: () => {},
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };
    const mockClient = {
      request: async () => ({
        tools: [
          { name: "z_tool", inputSchema: { type: "object" } },
          { name: "a_tool", inputSchema: { type: "object" } },
        ],
      }),
    } as unknown as Client;

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);
    await bridge.refreshTools("db", mockClient);

    assert.deepEqual(activeTools, [
      "bash",
      "read",
      "other_ext_tool",
      "mcp_db_a_tool",
      "mcp_db_z_tool",
    ]);
  });

  it("undoes registerTool auto-activation when a live refresh leaves the desired active set unchanged", async () => {
    const activeTools: string[] = [];
    const seenRegistrations = new Set<string>();
    let allowlistReassertsAll = false;
    // Mirrors Pi's AgentSession._refreshToolRegistry(): registering a tool name for the first
    // time activates it automatically, and an active --tools allowlist re-adds matching tools
    // on every registerTool() call. Also mutates activeTools in place to verify _reconcileTools
    // snapshots the pre-registration list rather than holding a live array reference.
    const mockPi = {
      registerTool: (tool: { name: string }) => {
        if ( (!seenRegistrations.has(tool.name) || allowlistReassertsAll) && !activeTools.includes(tool.name)) {
          activeTools.push(tool.name);
        }
        seenRegistrations.add(tool.name);
      },
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => {
        activeTools.splice(0, activeTools.length, ...names);
      },
    };

    const dashed = { name: "a-b", inputSchema: { type: "object" } };
    const underscored = { name: "a_b", inputSchema: { type: "object" } };
    let serverTools = [underscored];
    const mockClient = {
      request: async () => ({ tools: serverTools }),
    } as unknown as Client;

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);

    // 1. Connect with `a_b` (`mcp_db_a_b`), deactivate it by policy, then drop it so
    //    `droppedToolState` remembers `a_b` as inactive.
    await bridge.refreshTools("db", mockClient);
    activeTools.length = 0;
    serverTools = [];
    await bridge.refreshTools("db", mockClient);

    // 2. Advertise `a-b` alone (`mcp_db_a_b`, already in seenRegistrations), then deactivate it.
    serverTools = [dashed];
    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(activeTools, ["mcp_db_a_b"]);
    activeTools.length = 0;

    // 3. Re-advertise `a_b` alongside `a-b`. Both should stay inactive (`a_b` was dropped while
    //    inactive; `a-b` was just deactivated), even though `a-b` is registered under its hashed
    //    Pi name for the very first time and `registerTool` auto-activates that new Pi name.
    serverTools = [dashed, underscored];
    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(
      activeTools,
      [],
      "A shifted inactive tool whose new hashed Pi name is auto-activated by registerTool must be deactivated",
    );

    // 4. With `--tools` allowlist semantics (registerTool re-activating registered tools on every
    //    call), a no-op live refresh must still preserve a policy deactivation.
    allowlistReassertsAll = true;
    await bridge.refreshTools("db", mockClient);
    assert.deepEqual(
      activeTools,
      [],
      "A no-op live refresh must undo any tool re-activation performed by registerTool",
    );
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
    assert.deepEqual(bridge.getToolActivity("myserver"), { discovered: 2, active: 0, expected: 0 });
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
    callResponse = {
      content: [
        { type: "resource", resource: { uri: "image://preview", mimeType: "image/png", blob: "YWJj" } },
        { type: "text", text: "Embedded render failed" },
      ],
      isError: true,
    };
    await assert.rejects(
      () => tool.execute("call-4", {}, undefined, undefined, undefined),
      { message: "Embedded render failed", code: "tool" },
    );
    callResponse = {
      content: [
        { type: "resource", resource: { uri: "image://preview", mimeType: "image/png", blob: "YWJj" } },
      ],
      isError: true,
    };
    await assert.rejects(
      () => tool.execute("call-5", {}, undefined, undefined, undefined),
      { message: "Tool reported an error", code: "tool" },
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

  it("gives the unhashed name to the exact-match tool in an intra-server collision, whatever the tools/list order (#213)", async () => {
    const registeredTools = new Map<string, TestToolDefinition>();
    const registrationOrder: string[] = [];
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: (t: unknown) => {
        const tool = t as TestToolDefinition;
        registrationOrder.push(tool.name);
        registeredTools.set(tool.name, tool);
      },
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => {
        activeTools = names;
      },
    };

    let toolsList: string[] = [];
    let dispatched = "";
    const mockClient = {
      request: async () => ({
        tools: toolsList.map((name) => ({ name, inputSchema: { type: "object" } })),
      }),
      callTool: async (params: { name: string }) => {
        dispatched = params.name;
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as Client;

    const bridge = new ToolBridge(
      { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 },
      mockPi,
    );
    const hashedHyphen = buildToolName("mcp", "alpha", "my-tool", true);
    const dispatchThrough = async (piName: string): Promise<string> => {
      const tool = registeredTools.get(piName);
      assert.ok(tool, `${piName} must be registered`);
      await tool.execute("call", {}, undefined, undefined, undefined);
      return dispatched;
    };

    // A reconnect (or notifications/tools/list_changed) may reorder tools/list freely.
    const cases = [
      {
        list: ["read_file", "my-tool", "my_tool", "list_dir"],
        // Only the colliding pair moves (to its first member's slot, winner first);
        // read_file and list_dir keep the positions the server gave them.
        registered: ["mcp_alpha_read_file", "mcp_alpha_my_tool", hashedHyphen, "mcp_alpha_list_dir"],
      },
      {
        list: ["list_dir", "my_tool", "my-tool", "read_file"],
        registered: ["mcp_alpha_list_dir", "mcp_alpha_my_tool", hashedHyphen, "mcp_alpha_read_file"],
      },
    ];
    for (const { list, registered } of cases) {
      toolsList = list;
      registrationOrder.length = 0;
      await bridge.refreshTools("alpha", mockClient);

      assert.deepEqual(
        registrationOrder,
        registered,
        `only the colliding names may move for tools/list order ${list.join(",")}`,
      );
      assert.equal(
        await dispatchThrough("mcp_alpha_my_tool"),
        "my_tool",
        `the lossless name must own the unhashed identifier for order ${list.join(",")}`,
      );
      assert.equal(
        await dispatchThrough(hashedHyphen),
        "my-tool",
        `the sanitized name must keep the hashed identifier for order ${list.join(",")}`,
      );
      assert.deepEqual(
        [...activeTools].sort(),
        [hashedHyphen, "mcp_alpha_my_tool", "mcp_alpha_read_file", "mcp_alpha_list_dir"].sort(),
        "the tools must activate under the same names on every refresh",
      );
    }
  });

  it("breaks intra-server collision ties by raw-name code-point order, not tools/list order (#213)", async () => {
    const registeredTools = new Map<string, TestToolDefinition>();
    let activeTools: string[] = [];
    const mockPi = {
      registerTool: (t: unknown) => {
        const tool = t as TestToolDefinition;
        registeredTools.set(tool.name, tool);
      },
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => {
        activeTools = names;
      },
    };

    // "a-b" (U+002D) sorts before "a.b" (U+002E). The second pair sanitizes to the same
    // identifier (`mcp_alpha___`, one separator plus two substitutions) but orders differently
    // by code point than by UTF-16 code unit: U+E000 precedes U+1F600 by code point, while
    // U+1F600's lead surrogate (U+D83D) precedes U+E000 as a code unit.
    const collected = ["a.b", "a-b", "\u{1F600}", "\uE000\uE001"];
    let toolsList = collected;
    let dispatched = "";
    const mockClient = {
      request: async () => ({
        tools: toolsList.map((name) => ({ name, inputSchema: { type: "object" } })),
      }),
      callTool: async (params: { name: string }) => {
        dispatched = params.name;
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as Client;

    const bridge = new ToolBridge(
      { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 },
      mockPi,
    );
    const dispatchThrough = async (piName: string): Promise<string> => {
      const tool = registeredTools.get(piName);
      assert.ok(tool, `${piName} must be registered`);
      await tool.execute("call", {}, undefined, undefined, undefined);
      return dispatched;
    };

    for (const order of [collected, [...collected].reverse()]) {
      toolsList = order;
      await bridge.refreshTools("alpha", mockClient);

      assert.equal(await dispatchThrough("mcp_alpha_a_b"), "a-b");
      assert.equal(await dispatchThrough(buildToolName("mcp", "alpha", "a.b", true)), "a.b");
      assert.equal(await dispatchThrough("mcp_alpha___"), "\uE000\uE001");
      assert.equal(
        await dispatchThrough(buildToolName("mcp", "alpha", "\u{1F600}", true)),
        "\u{1F600}",
      );
    }
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

describe("ToolBridge annotations passthrough", () => {
  async function registerWithAnnotations(annotations?: unknown): Promise<TestToolDefinition> {
    const registeredTools: TestToolDefinition[] = [];
    let annotationActiveTools: string[] = [];

    const mockPi = {
      registerTool: (t: unknown) => registeredTools.push(t as TestToolDefinition),
      getActiveTools: () => annotationActiveTools,
      setActiveTools: (names: string[]) => { annotationActiveTools = names; },
    };

    const mockClient = {
      request: async () => ({
        tools: [{
          name: "delete_record",
          description: "Delete a record",
          inputSchema: { type: "object", properties: {}, required: [] },
          ...(annotations === undefined ? {} : { annotations }),
        }],
      }),
    } as unknown as Client;

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi);
    await bridge.refreshTools("myserver", mockClient);

    return registeredTools[0]!;
  }

  it("passes boolean hints through to registerTool", async () => {
    const tool = await registerWithAnnotations({ destructiveHint: true, readOnlyHint: false });
    assert.deepEqual(tool.annotations, { destructiveHint: true, readOnlyHint: false });
  });

  it("passes all four hints", async () => {
    const tool = await registerWithAnnotations({
      destructiveHint: true,
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.deepEqual(tool.annotations, {
      destructiveHint: true,
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("omits the annotations key when the tool has none", async () => {
    const tool = await registerWithAnnotations();
    assert.equal("annotations" in tool, false);
  });

  it("omits the annotations key when only a title is present, and still uses it as the label", async () => {
    const tool = await registerWithAnnotations({ title: "Just a title" });
    assert.equal("annotations" in tool, false);
    assert.equal(tool.label, "Just a title");
  });

  it("does not copy the title into the structured annotations", async () => {
    const tool = await registerWithAnnotations({ title: "Delete", destructiveHint: true });
    assert.deepEqual(tool.annotations, { destructiveHint: true });
  });

  it("ignores non-boolean values and keeps the valid hints", async () => {
    // WHY: the real SDK schema rejects these before the bridge sees them; this simulates a bad payload.
    const tool = await registerWithAnnotations({
      destructiveHint: "yes",
      readOnlyHint: 1,
      openWorldHint: {},
      idempotentHint: true,
    });
    assert.deepEqual(tool.annotations, { idempotentHint: true });
  });

  it("keeps the hints in the description text", async () => {
    const tool = await registerWithAnnotations({ destructiveHint: true });
    assert.ok(tool.description.includes("⚠️ destructive"));
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
      { type: "text", text: "[Binary resource: file:///b.bin (application/octet-stream, 2 bytes)]" },
    ]);
  });

  it("converts embedded image and binary resources like resources/read", () => {
    assert.deepEqual(convertMcpContent([
      { type: "resource", resource: { uri: "image://preview", mimeType: "image/png", blob: "YWJj" } },
      { type: "resource", resource: { uri: "file:///data", mimeType: "application/pdf", blob: "YWJj" } },
      { type: "resource", resource: { uri: "file:///empty", blob: "" } },
      { type: "resource", resource: { uri: "file:///empty-text", text: "", blob: "YWJj", mimeType: "image/png" } },
      { type: "resource", resource: "invalid-primitive" },
      { type: "resource", resource: null },
    ]), [
      { type: "image", mimeType: "image/png", data: "YWJj" },
      { type: "text", text: "[Binary resource: file:///data (application/pdf, 3 bytes)]" },
      { type: "text", text: "[Binary resource: file:///empty (application/octet-stream, 0 bytes)]" },
      { type: "text", text: "" },
      { type: "text", text: "[Resource: unknown]" },
      { type: "text", text: "[Resource: unknown]" },
    ]);
  });

  it("summarizes resource links with optional metadata and a read-resource hint", () => {
    assert.deepEqual(convertMcpContent([
      {
        type: "resource_link", uri: "file:///schema.sql", name: "schema.sql",
        title: "Database Schema", mimeType: "application/sql", size: 12, description: "Table definitions.",
      },
      { type: "resource_link", uri: "file:///empty", name: "empty", size: 0 },
      { type: "resource_link", uri: "file:///bare" },
      { type: "resource_link" },
      { type: "resource_link", uri: "file:///fallback", title: 42, name: "fallback", mimeType: " ", size: -1, description: null },
      { type: "resource_link", uri: "file:///blank-title", title: "   ", name: "blank-title", description: "   " },
      { type: "resource_link", uri: "   ", title: "", name: "" },
    ]), [
      { type: "text", text: '[Resource link: file:///schema.sql "Database Schema" (application/sql, 12 bytes) — Use mcp_read_resource to read]\nTable definitions.' },
      { type: "text", text: '[Resource link: file:///empty "empty" (0 bytes) — Use mcp_read_resource to read]' },
      { type: "text", text: "[Resource link: file:///bare — Use mcp_read_resource to read]" },
      { type: "text", text: "[Resource link: unknown — Use mcp_read_resource to read]" },
      { type: "text", text: '[Resource link: file:///fallback "fallback" — Use mcp_read_resource to read]' },
      { type: "text", text: '[Resource link: file:///blank-title "blank-title" — Use mcp_read_resource to read]' },
      { type: "text", text: "[Resource link: unknown — Use mcp_read_resource to read]" },
    ]);
  });

  it("handles non-object items, missing block fields, and unknown content types", () => {
    assert.deepEqual(
      convertMcpContent([
        null,
        42,
        { type: "text" },
        { type: "image" },
        { type: "audio" },
        { type: "custom", payload: true },
      ]),
      [
        { type: "text", text: "null" },
        { type: "text", text: "42" },
        { type: "text", text: "" },
        { type: "image", data: "", mimeType: "image/png" },
        { type: "text", text: "[Audio: unknown, base64 encoded]" },
        { type: "text", text: '{"type":"custom","payload":true}' },
      ],
    );
  });
});

describe("buildToolDescription, buildToolAnnotations, buildToolCallContent, and toolErrorText", () => {
  it("formats tool descriptions with default fallback and annotation hints", () => {
    assert.equal(
      buildToolDescription({ name: "ping", inputSchema: {} }),
      "MCP tool: ping",
    );
    assert.equal(
      buildToolDescription({
        name: "delete_all",
        description: "Delete rows",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      }),
      "Delete rows [read-only, ⚠️ destructive, idempotent, may have side effects]",
    );
    assert.equal(
      buildToolDescription({
        name: "noop",
        description: "No hints enabled",
        inputSchema: {},
        annotations: { readOnlyHint: false, destructiveHint: false },
      }),
      "No hints enabled",
    );
  });

  it("builds structured Pi tool annotations or undefined when no boolean hints apply", () => {
    assert.equal(buildToolAnnotations(undefined), undefined);
    assert.equal(buildToolAnnotations({ title: "Only Title" }), undefined);
    assert.deepEqual(
      buildToolAnnotations({
        title: "Ignored Title",
        readOnlyHint: true,
        destructiveHint: false,
      }),
      { readOnlyHint: true, destructiveHint: false },
    );
  });

  it("builds tool call content with structuredContent fallback and extracts text for errors", () => {
    assert.deepEqual(
      buildToolCallContent({
        content: [{ type: "text", text: "from content" }],
        structuredContent: { ignored: true },
      }),
      [{ type: "text", text: "from content" }],
    );
    assert.deepEqual(
      buildToolCallContent({
        content: [],
        structuredContent: "raw structured string",
      }),
      [{ type: "text", text: "raw structured string" }],
    );
    assert.deepEqual(
      buildToolCallContent({
        structuredContent: { count: 2 },
      }),
      [{ type: "text", text: '{\n  "count": 2\n}' }],
    );
    assert.equal(
      toolErrorText([
        { type: "text", text: "first line" },
        { type: "image", data: "YWJj", mimeType: "image/png" },
        { type: "text", text: "second line" },
      ]),
      "first line\nsecond line",
    );
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
        assert.equal(err.server, "srv", "the failure must name the server that produced it");
        return true;
      },
    );

    callError = new Error("Unexpected token < in JSON");
    await assert.rejects(
      () => tool.execute("call-protocol", {}, undefined, undefined, undefined),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.equal(err.code, "protocol");
        assert.equal(err.server, "srv", "the failure must name the server that produced it");
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

// ── MCP notifications/progress (#254) ─────────────────────────────────────────

describe("MCP progress notifications", () => {
  const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 0 };

  type ProgressUpdate = { content: Array<{ type: string; text?: string }> };
  interface CapturedCall {
    options?: Record<string, unknown> | undefined;
    onProgress?:
      | ((progress: { progress: number; total?: number; message?: string }) => void)
      | undefined;
  }

  /** Bridge + fake SDK client pair whose `tools/call` options the test can inspect. */
  function setupBridge() {
    const captured: CapturedCall = {};
    const registeredTools: TestToolDefinition[] = [];
    const bridge = new ToolBridge(settings, {
      registerTool: (t: unknown) => registeredTools.push(t as TestToolDefinition),
      getActiveTools: () => [],
      setActiveTools: () => undefined,
    });
    const client = {
      request: async (req: { method: string }) =>
        req.method === "tools/list"
          ? { tools: [{ name: "compile", inputSchema: { type: "object", properties: {} } }] }
          : { content: [{ type: "text", text: "built" }] },
      callTool: async (_params: unknown, _schema: unknown, options: Record<string, unknown>) => {
        captured.options = options;
        captured.onProgress = options["onprogress"] as CapturedCall["onProgress"];
        return { content: [{ type: "text", text: "built" }] };
      },
    } as unknown as Client;
    return { captured, registeredTools, bridge, client };
  }

  async function executeWithUpdates(
    tool: TestToolDefinition,
    callId: string,
    updates: ProgressUpdate[],
  ) {
    return tool.execute(
      callId,
      {},
      undefined,
      (update: unknown) => {
        updates.push(update as ProgressUpdate);
      },
      undefined,
    );
  }

  it("asks the server for progress and resets the request timeout on every notification", async () => {
    const { captured, registeredTools, bridge, client } = setupBridge();
    await bridge.refreshTools("srv", client);
    const updates: ProgressUpdate[] = [];

    const result = await executeWithUpdates(registeredTools[0]!, "call-1", updates);

    assert.equal((result.content[0] as { text?: string } | undefined)?.text, "built");
    // WHY: without both options the SDK never attaches `_meta.progressToken`, so it drops the
    // server's notifications and keeps the original inactivity deadline (#254).
    assert.equal(captured.options?.["resetTimeoutOnProgress"], true);
    assert.equal(typeof captured.onProgress, "function");

    captured.onProgress?.({ progress: 1, total: 3, message: "compiling" });
    captured.onProgress?.({ progress: 1, total: 3, message: "compiling" });
    captured.onProgress?.({ progress: 1, total: 3, message: "compiling\n" });
    captured.onProgress?.({ progress: 2, total: 3 });
    assert.deepEqual(
      updates.map((u) => u.content[0]?.text),
      ["compiling", "Progress 2/3"],
      "each distinct line reaches Pi once, and a repeated or trailing-newline line does not re-render the row",
    );
  });

  it("strips terminal escapes and redacts token-like text from a server message", async () => {
    const { captured, registeredTools, bridge, client } = setupBridge();
    await bridge.refreshTools("srv", client);
    const updates: ProgressUpdate[] = [];

    await executeWithUpdates(registeredTools[0]!, "call-2", updates);
    captured.onProgress?.({
      progress: 1,
      // WHY: the escape sits inside the credential (`token=` + ESC + `sk-…`), so redacting the raw
      // text would miss the `key=value` shape the sanitizer only makes visible.
      message: "\u001b[31mDeploying\u001b[0m \u001b[1mtoken\u001b[0m=sk-live-1234567890",
    });

    const text = updates[0]?.content[0]?.text ?? "";
    assert.ok(text.includes("Deploying"), `expected the message text, got ${JSON.stringify(text)}`);
    assert.ok(!text.includes("\u001b"), "ANSI escapes must not reach the Pi UI stream");
    assert.ok(!text.includes("sk-live-1234567890"), "token-like text must be redacted");
  });

  it("falls back to numeric progress for empty, blank, or unusable messages", () => {
    assert.equal(formatProgressText({ progress: 3 }), "Progress 3");
    assert.equal(formatProgressText({ progress: 3, total: 10 }), "Progress 3/10");
    assert.equal(formatProgressText({ progress: 3, total: 10, message: "   " }), "Progress 3/10");
    assert.equal(
      formatProgressText({ progress: 4, total: 10, message: "\u0000\u0007" }),
      "Progress 4/10",
    );
    assert.equal(formatProgressText({ progress: 5, total: Number.NaN }), "Progress 5");
    assert.equal(formatProgressText({ progress: Number.NaN, total: 10 }), "Progress ?/10");
    assert.equal(formatProgressText({ progress: Number.POSITIVE_INFINITY }), "Progress ?");
    // WHY: the sanitizer appends `…` when it truncates, so a long blank message must be judged
    // on its untruncated text — otherwise the fallback never fires and the row renders blank.
    // 300 and 600 spaces straddle the sanitizer's default 500-char budget, which is where its
    // truncation marker used to turn a blank message into a "usable" one.
    assert.equal(
      formatProgressText({ progress: 6, total: 10, message: " ".repeat(300) }),
      "Progress 6/10",
    );
    assert.equal(
      formatProgressText({ progress: 7, total: 10, message: " ".repeat(600) }),
      "Progress 7/10",
    );
  });

  it("trims surrounding whitespace before capping so padded messages keep their text", () => {
    assert.equal(
      formatProgressText({ progress: 3, total: 10, message: `${" ".repeat(250)}Deploying\n` }),
      "Deploying",
    );
    assert.equal(
      formatProgressText({ progress: 3, total: 10, message: "  Step 1/5\r\n" }),
      "Step 1/5",
    );
  });

  it("keeps the rendered line within the message budget after redaction", () => {
    const text = formatProgressText({ progress: 1, message: `${"x".repeat(192)} token=v` });
    assert.ok(text.length <= 200, `expected at most 200 characters, got ${text.length}`);
    assert.ok(!text.includes(" token=v"), `the credential must still be masked: ${text}`);
  });
});

// ── Codemode CallToolResult outputSchema & structuredContent (#257) ──────────

describe("codemode CallToolResult outputSchema & structuredContent (#257)", () => {
  it("relocates fragment $refs under #/properties/structuredContent while preserving data literals", () => {
    const defaultSchema = buildMcpResultSchema() as Record<string, unknown>;
    assert.equal(defaultSchema["type"], "object");
    assert.deepEqual(defaultSchema["required"], ["content"]);
    assert.deepEqual(
      (defaultSchema["properties"] as Record<string, unknown>)["structuredContent"],
      {},
    );

    const relocated = buildMcpResultSchema({
      type: "object",
      $defs: {
        Row: {
          type: "object",
          properties: {
            parent: { $ref: "#" },
            sibling: { $ref: "#/$defs/Row" },
            external: { $ref: "https://example.com/row.json" },
            nonStringRef: { $ref: 42 },
            literalConst: { const: { $ref: "#/$defs/Row" } },
            literalEnum: { enum: [{ $ref: "#" }] },
            literalDefault: { default: { $ref: "#/$defs/Row" } },
            literalExamples: { examples: [{ $ref: "#" }] },
          },
        },
      },
      properties: {
        rows: { type: "array", items: { $ref: "#/$defs/Row" } },
      },
    }) as { properties: { structuredContent: Record<string, unknown> } };

    const sc = relocated.properties.structuredContent;
    const rowDef = (
      (sc["$defs"] as Record<string, Record<string, unknown>>)["Row"]!["properties"] as Record<
        string,
        Record<string, unknown>
      >
    );
    assert.equal(rowDef["parent"]?.["$ref"], "#/properties/structuredContent");
    assert.equal(rowDef["sibling"]?.["$ref"], "#/properties/structuredContent/$defs/Row");
    assert.equal(rowDef["external"]?.["$ref"], "https://example.com/row.json");
    assert.equal(rowDef["nonStringRef"]?.["$ref"], 42);
    assert.deepEqual(rowDef["literalConst"]?.["const"], { $ref: "#/$defs/Row" });
    assert.deepEqual(rowDef["literalEnum"]?.["enum"], [{ $ref: "#" }]);
    assert.deepEqual(rowDef["literalDefault"]?.["default"], { $ref: "#/$defs/Row" });
    assert.deepEqual(rowDef["literalExamples"]?.["examples"], [{ $ref: "#" }]);
    assert.equal(
      ((sc["properties"] as Record<string, Record<string, Record<string, unknown>>>)["rows"]?.[
        "items"
      ] as Record<string, unknown>)?.["$ref"],
      "#/properties/structuredContent/$defs/Row",
    );

    // Cyclic and deeply nested outputSchema inputs terminate cleanly
    const cycle: Record<string, unknown> = { type: "object" };
    cycle["self"] = cycle;
    const cyclicResult = buildMcpResultSchema(cycle) as {
      properties: { structuredContent: Record<string, unknown> };
    };
    assert.deepEqual(cyclicResult.properties.structuredContent["self"], {});

    let deep: Record<string, unknown> = { $ref: "#/$defs/Leaf" };
    for (let i = 0; i < 40; i++) {
      deep = { items: deep };
    }
    assert.ok(buildMcpResultSchema(deep));
  });

  it("normalizes CallToolResult for codemode scripts without _meta or non-JSON values", () => {
    const cyclicExtra: Record<string, unknown> = { tag: "ok" };
    cyclicExtra["loop"] = cyclicExtra;

    const scriptResult = buildMcpScriptResult({
      _meta: { progressToken: "tok-1" },
      content: [
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        { type: "text", text: "Chart rendered" },
      ],
      structuredContent: {
        rows: 2,
        badNum: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        omitted: undefined,
        arr: [1, undefined, Number.NEGATIVE_INFINITY, "x"],
      },
      extra: cyclicExtra,
    }) as Record<string, unknown>;

    assert.equal("_meta" in scriptResult, false);
    assert.deepEqual(scriptResult["content"], [
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      { type: "text", text: "Chart rendered" },
    ]);
    assert.deepEqual(scriptResult["structuredContent"], {
      rows: 2,
      badNum: null,
      inf: null,
      arr: [1, null, null, "x"],
    });
    assert.deepEqual(scriptResult["extra"], { tag: "ok" });

    // Legacy response without an array `content` normalizes `content` to `[]`, and `isError` canonicalizes to boolean
    assert.deepEqual(buildMcpScriptResult({ structuredContent: { ok: true } }), {
      content: [],
      structuredContent: { ok: true },
    });
    assert.deepEqual(buildMcpScriptResult({ content: [], isError: false }), {
      content: [],
      isError: false,
    });
    assert.deepEqual(
      buildMcpScriptResult({ content: [], isError: 1 }),
      { content: [], isError: true },
    );

    assert.equal(supportsToolErrorResult(undefined), false);
    assert.equal(supportsToolErrorResult(null), false);
    assert.equal(supportsToolErrorResult("ctx"), false);
    assert.equal(supportsToolErrorResult({}), false);
    assert.equal(supportsToolErrorResult({ executeTool: "not-a-fn" }), false);
    assert.equal(supportsToolErrorResult({ executeTool: async () => ({}) }), true);

    // buildToolCallOutcome preserves image blocks and structuredContent on Pi 1.3.0+ while appending fallback error text
    const imageErrOutcome = buildToolCallOutcome(
      {
        content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
        structuredContent: { code: "E_SYNTAX", line: 4 },
        isError: true,
      },
      "analytics",
      true,
    );
    assert.equal(imageErrOutcome.isError, true);
    assert.deepEqual(imageErrOutcome.content, [
      { type: "image", data: "YWJj", mimeType: "image/png" },
      { type: "text", text: "Tool reported an error" },
    ]);
    assert.deepEqual(imageErrOutcome.structuredContent, {
      content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
      structuredContent: { code: "E_SYNTAX", line: 4 },
      isError: true,
    });
  });

  it("wires outputSchema, structuredContent, Pi 1.3.0 isError envelopes, and server exposure state on ToolBridge", async () => {
    const registered = new Map<string, TestToolDefinition>();
    let activeTools: string[] = [];
    const bridge = new ToolBridge(
      { toolPrefix: "custom", requestTimeoutMs: 30000, maxRetries: 0 },
      {
        registerTool: (t: unknown) => {
          const tool = t as TestToolDefinition;
          registered.set(tool.name, tool);
        },
        getActiveTools: () => [...activeTools],
        setActiveTools: (names: string[]) => {
          activeTools = [...names];
        },
      },
    );

    assert.equal(bridge.getToolPrefix(), "custom");
    assert.equal(bridge.isServerActive("analytics"), false);

    let shouldFail = false;
    const client = {
      request: async (req: { method: string }) => {
        if (req.method === "tools/list") {
          return {
            tools: [
              {
                name: "render_chart",
                description: "Render PNG chart",
                inputSchema: { type: "object", properties: { sql: { type: "string" } } },
                outputSchema: {
                  type: "object",
                  $defs: { Series: { type: "object", properties: { label: { type: "string" } } } },
                  properties: { series: { $ref: "#/$defs/Series" } },
                },
              },
            ],
          };
        }
        return { content: [] };
      },
      callTool: async () =>
        shouldFail
          ? {
              content: [{ type: "text", text: "Query syntax error" }],
              structuredContent: { code: "E_SQL" },
              isError: true,
            }
          : {
              _meta: { traceId: "t-1" },
              content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
              structuredContent: { series: { label: "Q1" } },
            },
    } as unknown as Client;

    await bridge.refreshTools("analytics", client, { exposure: "codemode" });
    assert.equal(bridge.isServerActive("analytics"), true);
    assert.deepEqual([...bridge.getServerExposures("analytics")], ["codemode"]);
    assert.deepEqual([...bridge.getConnectedExposures()], ["codemode"]);

    const tool = registered.get("custom_analytics_render_chart");
    assert.ok(tool);
    const outSchema = tool.outputSchema as {
      properties?: { structuredContent?: { properties?: { series?: { $ref?: string } } } };
    };
    assert.equal(
      outSchema.properties?.structuredContent?.properties?.series?.$ref,
      "#/properties/structuredContent/$defs/Series",
    );

    const outcome = await tool.execute("call-1", { sql: "SELECT 1" }, undefined, undefined, undefined);
    assert.deepEqual(outcome.content, [{ type: "image", data: "YWJj", mimeType: "image/png" }]);
    assert.deepEqual(outcome.structuredContent, {
      content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
      structuredContent: { series: { label: "Q1" } },
    });

    // Legacy Pi < 1.3.0 / direct callers without `ctx.executeTool` reject with McpError(..., "tool")
    shouldFail = true;
    await assert.rejects(
      () => tool.execute("call-2", { sql: "BAD" }, undefined, undefined, undefined),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.equal(err.code, "tool");
        assert.equal(err.message, "Query syntax error");
        return true;
      },
    );

    // Pi 1.3.0+ ExtensionToolContext (`ctx.executeTool` present) returns structured isError envelope
    const pi13Ctx = { executeTool: async () => ({ content: [], details: {} }) };
    const errOutcome = await tool.execute("call-3", { sql: "BAD" }, undefined, undefined, pi13Ctx);
    assert.equal(errOutcome.isError, true);
    assert.deepEqual(errOutcome.content, [{ type: "text", text: "Query syntax error" }]);
    assert.deepEqual(errOutcome.structuredContent, {
      content: [{ type: "text", text: "Query syntax error" }],
      structuredContent: { code: "E_SQL" },
      isError: true,
    });

    bridge.deactivateServer("analytics");
    assert.equal(bridge.isServerActive("analytics"), false);
    assert.deepEqual([...bridge.getServerExposures("analytics")], []);
    assert.deepEqual([...bridge.getConnectedExposures()], []);
  });
});


