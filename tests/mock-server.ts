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
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "pi-mcp-test-server", version: "1.0.0" },
  {
    capabilities: {
      tools: { listChanged: true },
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
    name: "fail_tool",
    description: "A tool that always returns isError: true",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// ── Handlers ──────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "echo":
      return {
        content: [{ type: "text", text: `Echo: ${(args as any).message}` }],
        isError: false,
      };

    case "add": {
      const result = (args as any).a + (args as any).b;
      return {
        content: [{ type: "text", text: String(result) }],
        isError: false,
      };
    }

    case "get_status": {
      const format = (args as any).format ?? "text";
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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
// Server runs until process is killed
