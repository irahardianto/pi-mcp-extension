/**
 * Integration tests for src/server-manager.ts
 * Spawns the real mock-server.ts over stdio to verify end-to-end behavior.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ServerManager } from "../src/server-manager.js";
import { ToolBridge } from "../src/tool-bridge.js";
import type { McpConfig } from "../src/config.js";
import { McpError } from "../src/errors.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER_PATH = join(__dirname, "mock-server.ts");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockConfig(overrides?: Partial<McpConfig>): McpConfig {
  return {
    settings: {
      toolPrefix: "mcp",
      requestTimeoutMs: 5000,
      maxRetries: 0, // No retries in tests — fail fast
    },
    mcpServers: {
      test: {
        command: "node",
        args: ["--import", "tsx/esm", MOCK_SERVER_PATH],
        transport: "stdio",
        lifecycle: "lazy",
        requestTimeoutMs: 5000,
      },
    },
    ...overrides,
  };
}

function makeMockPi() {
  const tools: any[] = [];
  let active: string[] = [];
  return {
    registerTool: (t: any) => tools.push(t),
    getAllTools: () => tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, sourceInfo: { path: "test", line: 0, source: "extension", scope: "tool", origin: "test" } })),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
    tools,
    get active() { return active; },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ServerManager integration (stdio)", () => {
  let manager: ServerManager;
  let mockPi: ReturnType<typeof makeMockPi>;
  let bridge: ToolBridge;
  const cwd = process.cwd();

  before(async () => {
    const config = makeMockConfig();
    manager = new ServerManager(config);
    mockPi = makeMockPi();
    bridge = new ToolBridge(config.settings, mockPi as any);
    manager.setToolRefreshCallback(async (name, client) => {
      await bridge.refreshTools(name, client);
    });
  });

  after(async () => {
    await manager.shutdownAll();
  });

  it("starts in stopped state", () => {
    const server = manager.getServer("test");
    assert.ok(server);
    assert.equal(server.state, "stopped");
  });

  it("connects successfully and reaches ready state", async () => {
    await manager.startServer("test", cwd);
    const server = manager.getServer("test");
    assert.equal(server?.state, "ready");
  });

  it("discovers tools from mock server", () => {
    assert.ok(mockPi.tools.length >= 4, `Expected ≥4 tools, got ${mockPi.tools.length}`);
    const names = mockPi.tools.map((t) => t.name);
    assert.ok(names.some((n) => n.includes("echo")));
    assert.ok(names.some((n) => n.includes("add")));
    assert.ok(names.some((n) => n.includes("get_status")));
  });

  it("activates tools on connect", () => {
    assert.ok(mockPi.active.length > 0);
    assert.ok(mockPi.active.some((n) => n.includes("echo")));
  });

  it("executes echo tool successfully", async () => {
    const echoTool = mockPi.tools.find((t) => t.name.includes("echo"));
    assert.ok(echoTool, "echo tool should be registered");
    const result = await echoTool.execute(
      "test-call-id",
      { message: "hello from pi-mcp!" },
      undefined,
      () => {},
      {},
    );
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0]?.type, "text");
    assert.ok(result.content[0]?.text.includes("hello from pi-mcp!"));
  });

  it("executes add tool with numbers", async () => {
    const addTool = mockPi.tools.find((t) => t.name.includes("add"));
    assert.ok(addTool);
    const result = await addTool.execute(
      "test-call-id",
      { a: 21, b: 21 },
      undefined,
      () => {},
      {},
    );
    assert.equal(result.content[0]?.text, "42");
  });

  it("handles enum parameter (get_status with format)", async () => {
    const statusTool = mockPi.tools.find((t) => t.name.includes("get_status"));
    assert.ok(statusTool);
    const result = await statusTool.execute(
      "test-call-id",
      { format: "json" },
      undefined,
      () => {},
      {},
    );
    assert.ok(result.content[0]?.text.includes("uptime"));
  });

  it("propagates isError: true as McpError", async () => {
    const failTool = mockPi.tools.find((t) => t.name.includes("fail_tool"));
    assert.ok(failTool);
    await assert.rejects(
      () => failTool.execute("test-call-id", {}, undefined, () => {}, {}),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.equal(err.code, "tool");
        return true;
      },
    );
  });

  it("deactivates tools when server is stopped", async () => {
    bridge.deactivateServer("test");
    await manager.stopServer("test");
    const server = manager.getServer("test");
    assert.equal(server?.state, "stopped");
    // Active tools for this server should be cleared
    assert.ok(!mockPi.active.some((n) => n.includes("mcp_test_")));
  });

  it("status summary reflects server state", () => {
    const summary = manager.getStatusSummary();
    assert.ok(summary.includes("test"));
    assert.ok(summary.includes("stopped"));
  });
});

describe("ServerManager — unknown server", () => {
  it("throws McpError for unknown server name", async () => {
    const manager = new ServerManager({ settings: { toolPrefix: "mcp", requestTimeoutMs: 5000, maxRetries: 0 }, mcpServers: {} });
    await assert.rejects(
      () => manager.startServer("nonexistent", "/tmp"),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.equal(err.code, "config");
        return true;
      },
    );
  });
});
