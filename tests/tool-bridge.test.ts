/**
 * Unit tests for src/tool-bridge.ts
 * Tests schema conversion, tool naming, content conversion, and bridge logic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  convertJsonSchemaToTypebox,
  buildToolName,
  ToolBridge,
  listAllTools,
} from "../src/tool-bridge.js";

// ── Schema Conversion ─────────────────────────────────────────────────────────

describe("convertJsonSchemaToTypebox", () => {
  it("converts string type", () => {
    const schema = convertJsonSchemaToTypebox({ type: "string" }) as any;
    assert.equal(schema.type, "string");
  });

  it("converts string with description", () => {
    const schema = convertJsonSchemaToTypebox({
      type: "string",
      description: "A name",
    }) as any;
    assert.equal(schema.description, "A name");
  });

  it("converts string enum to Union of Literals", () => {
    const schema = convertJsonSchemaToTypebox({
      type: "string",
      enum: ["json", "text", "yaml"],
    }) as any;
    assert.ok(schema.anyOf, "Should be a Union (anyOf)");
    assert.equal(schema.anyOf.length, 3);
    assert.equal(schema.anyOf[0].const, "json");
    assert.equal(schema.anyOf[1].const, "text");
    assert.equal(schema.anyOf[2].const, "yaml");
  });

  it("converts number type", () => {
    const schema = convertJsonSchemaToTypebox({ type: "number" }) as any;
    assert.equal(schema.type, "number");
  });

  it("converts integer as Number", () => {
    const schema = convertJsonSchemaToTypebox({ type: "integer" }) as any;
    assert.equal(schema.type, "number");
  });

  it("converts boolean type", () => {
    const schema = convertJsonSchemaToTypebox({ type: "boolean" }) as any;
    assert.equal(schema.type, "boolean");
  });

  it("converts array type", () => {
    const schema = convertJsonSchemaToTypebox({
      type: "array",
      items: { type: "string" },
    }) as any;
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
    }) as any;
    assert.ok(schema.properties, "Should have properties");
    const props = schema.properties;
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
    }) as any;
    assert.ok(schema.properties, "Should have properties");
    const inner = schema.properties.address;
    assert.ok(inner.properties, "Nested object should have properties");
  });

  it("falls back to Any for unknown type", () => {
    const schema = convertJsonSchemaToTypebox({ type: "unknown-type" }) as any;
    // Any schema has no specific type field — check it doesn't throw and returns object
    assert.ok(typeof schema === "object");
  });

  it("converts oneOf to Union", () => {
    const schema = convertJsonSchemaToTypebox({
      oneOf: [{ type: "string" }, { type: "number" }],
    }) as any;
    assert.ok(schema.anyOf, "oneOf should produce a Union (anyOf)");
    assert.equal(schema.anyOf.length, 2);
    assert.equal(schema.anyOf[0].type, "string");
    assert.equal(schema.anyOf[1].type, "number");
  });

  it("converts anyOf to Union", () => {
    const schema = convertJsonSchemaToTypebox({
      anyOf: [{ type: "boolean" }, { type: "null" }],
    }) as any;
    assert.ok(schema.anyOf, "anyOf should produce a Union");
    assert.equal(schema.anyOf.length, 2);
  });

  it("converts allOf to Intersect", () => {
    const schema = convertJsonSchemaToTypebox({
      allOf: [
        { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        { type: "object", properties: { age: { type: "number" } }, required: ["age"] },
      ],
    }) as any;
    assert.ok(schema.allOf, "allOf should produce an Intersect (allOf)");
    assert.equal(schema.allOf.length, 2);
  });

  it("resolves $ref to #/$defs/", () => {
    const schema = convertJsonSchemaToTypebox({
      $ref: "#/$defs/MyString",
      $defs: { MyString: { type: "string" } },
    }) as any;
    assert.equal(schema.type, "string", "$ref should resolve to the referenced type");
  });

  it("resolves $ref to #/definitions/", () => {
    const schema = convertJsonSchemaToTypebox({
      $ref: "#/definitions/Foo",
      definitions: { Foo: { type: "boolean" } },
    }) as any;
    assert.equal(schema.type, "boolean");
  });

  it("resolves $ref with description passthrough", () => {
    const schema = convertJsonSchemaToTypebox({
      $ref: "#/$defs/Inner",
      description: "A description from the ref",
      $defs: { Inner: { type: "string" } },
    }) as any;
    assert.equal(schema.type, "string");
    assert.equal(schema.description, "A description from the ref");
  });

  it("falls back to Any for unresolvable $ref", () => {
    const schema = convertJsonSchemaToTypebox({ $ref: "#/definitions/NonExistent" }) as any;
    assert.ok(typeof schema === "object");
  });

  it("falls back to Any for external $ref", () => {
    const schema = convertJsonSchemaToTypebox({ $ref: "external-schema.json#/Foo" }) as any;
    assert.ok(typeof schema === "object");
  });

  it("handles nullable types: {type: ['string', 'null']}", () => {
    const schema = convertJsonSchemaToTypebox({ type: ["string", "null"] }) as any;
    // Should be Union [String, Null] — has anyOf
    assert.ok(schema.anyOf, "Nullable should produce a Union");
  });

  it("handles null input gracefully", () => {
    const schema = convertJsonSchemaToTypebox(null) as any;
    assert.ok(typeof schema === "object");
  });

  it("handles empty object schema (no properties)", () => {
    const schema = convertJsonSchemaToTypebox({ type: "object" }) as any;
    assert.ok(typeof schema === "object");
  });

  it("prevents infinite recursion on deeply nested schemas", () => {
    let schema: any = { type: "string" };
    for (let i = 0; i < 15; i++) {
      schema = { type: "object", properties: { nested: schema }, required: [] };
    }
    assert.doesNotThrow(() => convertJsonSchemaToTypebox(schema));
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

  it("truncates names exceeding 64 chars and appends hash", () => {
    const longServer = "a".repeat(30);
    const longTool = "b".repeat(30);
    const name = buildToolName("mcp", longServer, longTool);
    assert.ok(name.length <= 64, `Expected ≤64 chars, got ${name.length}`);
    assert.match(name, /^[a-zA-Z0-9_]+$/);
  });

  it("short names are not truncated or hashed", () => {
    const name = buildToolName("mcp", "foo", "bar");
    assert.equal(name, "mcp_foo_bar");
    assert.ok(!name.includes("_" + name.split("_").pop()?.match(/[a-z0-9]{8}/)));
  });
});

// ── Tool Bridge ───────────────────────────────────────────────────────────────

describe("ToolBridge", () => {
  it("registers tools and activates them", async () => {
    const registeredTools: any[] = [];
    let activeTools: string[] = [];

    const mockPi = {
      registerTool: (t: any) => registeredTools.push(t),
      getAllTools: () => registeredTools.map((t: any) => ({ name: t.name, description: t.description, parameters: t.parameters, sourceInfo: { path: "test", line: 0 } })),
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
    } as any;

    const settings = {
      toolPrefix: "mcp",
      requestTimeoutMs: 30000,
      maxRetries: 5,
    };

    const bridge = new ToolBridge(settings, mockPi as any);
    await bridge.refreshTools("myserver", mockClient);

    // Tools should be registered
    assert.equal(registeredTools.length, 2);
    assert.equal(registeredTools[0]?.name, "mcp_myserver_echo");
    assert.equal(registeredTools[1]?.name, "mcp_myserver_count");

    // Tools should be activated
    assert.ok(activeTools.includes("mcp_myserver_echo"));
    assert.ok(activeTools.includes("mcp_myserver_count"));
  });

  it("deactivates server tools on disconnect", async () => {
    const registeredTools: any[] = [];
    let activeTools: string[] = ["mcp_myserver_echo", "mcp_myserver_count", "other_tool"];

    const mockPi = {
      registerTool: (t: any) => registeredTools.push(t),
      getAllTools: () => registeredTools.map((t: any) => ({ name: t.name, description: t.description, parameters: t.parameters, sourceInfo: { path: "test", line: 0 } })),
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi as any);

    // Simulate already-registered tools
    const serverTools = new Set(["mcp_myserver_echo", "mcp_myserver_count"]);
    (bridge as any).serverToolNames.set("myserver", serverTools);

    bridge.deactivateServer("myserver");

    // Server tools should be removed, other_tool preserved
    assert.ok(!activeTools.includes("mcp_myserver_echo"));
    assert.ok(!activeTools.includes("mcp_myserver_count"));
    assert.ok(activeTools.includes("other_tool"));
  });

  it("re-registers tools on repeated refresh to capture new client", async () => {
    const registeredTools: any[] = [];
    let activeTools: string[] = [];

    const mockPi = {
      registerTool: (t: any) => registeredTools.push(t),
      getAllTools: () => registeredTools.map((t: any) => ({ name: t.name, description: t.description, parameters: t.parameters, sourceInfo: { path: "test", line: 0 } })),
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
    } as any;

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi as any);

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
    const registeredTools: any[] = [];
    let annotationActiveTools: string[] = [];
    const mockPi = {
      registerTool: (t: any) => registeredTools.push(t),
      getAllTools: () => registeredTools.map((t: any) => ({ name: t.name, description: t.description, parameters: t.parameters, sourceInfo: { path: "test", line: 0 } })),
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
    } as any;

    const settings = { toolPrefix: "mcp", requestTimeoutMs: 30000, maxRetries: 5 };
    const bridge = new ToolBridge(settings, mockPi as any);
    await bridge.refreshTools("myserver", mockClient);

    const tool = registeredTools[0];
    assert.ok(tool.description.includes("⚠️ destructive"));
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
      request: async (_req: any) => {
        const page = pages[pageIndex++];
        return page;
      },
    } as any;

    const tools = await listAllTools(mockClient, 30000);
    assert.equal(tools.length, 3);
    assert.equal(tools[0]?.name, "tool_a");
    assert.equal(tools[1]?.name, "tool_b");
    assert.equal(tools[2]?.name, "tool_c");
    assert.equal(pageIndex, 3); // exactly 3 requests made
  });
});
