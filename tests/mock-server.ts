/**
 * Mock MCP server for integration testing.
 *
 * Uses the official MCP TypeScript SDK Server class to create a real
 * MCP server over stdio. Tests spawn this process and verify the full
 * round-trip: connect → discover tools → call tools → disconnect.
 *
 * Usage: spawn this file with `node tests/mock-server.ts`
 *        and communicate via stdio.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "pi-mcp-test-server", version: "1.0.0" },
  {
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true },
    },
  },
);

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "echo",
    description: "Echo back the provided message [read-only]",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to echo" },
      },
      required: ["message"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add",
    description: "Add two numbers",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
    annotations: { idempotentHint: true },
  },
  {
    name: "get_status",
    description: "Get server status",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["json", "text"],
          description: "Output format",
        },
      },
      required: [],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_cwd",
    description: "Report the working directory the server process was started in",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fail_tool",
    description: "A tool that always returns isError: true",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "add_resource",
    description: "Add a generated resource and send notifications/resources/list_changed",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// ── Resource definitions ──────────────────────────────────────────────────────

/** 1×1 transparent PNG, base64-encoded. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const RESOURCES: Array<{ uri: string; name: string; description: string; mimeType: string }> = [
  { uri: "mock://docs/readme", name: "readme", description: "Mock readme document", mimeType: "text/markdown" },
  { uri: "mock://empty", name: "empty", description: "Empty text resource", mimeType: "text/plain" },
  { uri: "mock://image", name: "pixel", description: "Tiny PNG image", mimeType: "image/png" },
  { uri: "mock://binary", name: "archive", description: "Binary blob", mimeType: "application/octet-stream" },
];

const RESOURCE_TEMPLATES = [
  { uriTemplate: "mock://item/{id}", name: "item", description: "Item by id", mimeType: "application/json" },
];

let generatedResources = 0;

// ── Handlers ──────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: RESOURCES,
}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: RESOURCE_TEMPLATES,
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  if (uri === "mock://docs/readme") {
    return { contents: [{ uri, mimeType: "text/markdown", text: "# Mock readme\n\nHello from the mock resource." }] };
  }
  if (uri === "mock://empty") {
    return { contents: [{ uri, mimeType: "text/plain", text: "" }] };
  }
  if (uri === "mock://image") {
    return { contents: [{ uri, mimeType: "image/png", blob: TINY_PNG }] };
  }
  if (uri === "mock://binary") {
    return { contents: [{ uri, mimeType: "application/octet-stream", blob: "AAECAwQ=" }] };
  }
  const templateMatch = /^mock:\/\/item\/(.+)$/.exec(uri);
  if (templateMatch) {
    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ id: templateMatch[1] }) }],
    };
  }
  throw new Error(`Unknown resource: ${uri}`);
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "echo": {
      const message = typeof args?.["message"] === "string" ? args["message"] : String(args?.["message"] ?? "");
      return {
        content: [{ type: "text", text: `Echo: ${message}` }],
        isError: false,
      };
    }

    case "add": {
      const a = Number(args?.["a"] ?? 0);
      const b = Number(args?.["b"] ?? 0);
      const result = a + b;
      return {
        content: [{ type: "text", text: String(result) }],
        isError: false,
      };
    }

    case "get_cwd": {
      return {
        content: [{ type: "text", text: process.cwd() }],
        isError: false,
      };
    }

    case "get_status": {
      const format = args?.["format"] ?? "text";
      const status = { server: "pi-mcp-test", uptime: process.uptime() };
      return {
        content: [
          {
            type: "text",
            text:
              format === "json" ? JSON.stringify(status) : `uptime: ${status.uptime.toFixed(1)}s`,
          },
        ],
        isError: false,
      };
    }

    case "fail_tool":
      return {
        content: [{ type: "text", text: "Intentional failure for testing" }],
        isError: true,
      };

    case "add_resource": {
      generatedResources += 1;
      RESOURCES.push({
        uri: `mock://generated/${generatedResources}`,
        name: `generated-${generatedResources}`,
        description: "Added at runtime",
        mimeType: "text/plain",
      });
      await server.sendResourceListChanged();
      return {
        content: [{ type: "text", text: `Added mock://generated/${generatedResources}` }],
        isError: false,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
// Server runs until process is killed
