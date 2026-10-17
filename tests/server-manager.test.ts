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

  it("should populate childPid when connected to the stdio mock server", () => {
    // Arrange & Act
    const server = manager.getServer("test");

    // Assert
    assert.ok(server);
    assert.equal(typeof server.childPid, "number");
    assert.ok((server.childPid ?? 0) > 0);
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

describe("Batch 2 — Issues #19, #20, #21", () => {
  it("should resolve per-server requestTimeoutMs for tool discovery and execution via both 2-arg and 3-arg callbacks (Issue 19.1)", async () => {
    const config = makeMockConfig({
      settings: {
        toolPrefix: "mcp",
        requestTimeoutMs: 30000,
        maxRetries: 0,
      },
      mcpServers: {
        test: {
          command: "node",
          args: ["--import", "tsx/esm", MOCK_SERVER_PATH],
          transport: "stdio",
          lifecycle: "lazy",
          requestTimeoutMs: 1234,
        },
      },
    });
    const manager = new ServerManager(config);
    const mockPi = makeMockPi();
    const bridge = new ToolBridge(config.settings, mockPi as any);

    let capturedCallbackOptions: { requestTimeoutMs?: number | undefined; signal?: AbortSignal | undefined } | undefined;
    // Test 2-arg forwarding via WeakMap default options even when options is not explicitly passed to bridge.refreshTools
    manager.setToolRefreshCallback(async (name, client, options) => {
      capturedCallbackOptions = options;
      await bridge.refreshTools(name, client);
    });

    try {
      await manager.startServer("test", process.cwd());
      assert.equal(capturedCallbackOptions?.requestTimeoutMs, 1234);
      assert.ok(capturedCallbackOptions?.signal instanceof AbortSignal);

      const client = manager.getServer("test")!.client! as any;
      let callToolTimeout: number | undefined;
      const origRequest = client.request.bind(client);
      client.request = async (req: any, schema: any, options?: any) => {
        if (req.method === "tools/call") {
          callToolTimeout = options?.timeout;
        }
        return origRequest(req, schema, options);
      };

      const echoTool = mockPi.tools.find((t) => t.name.includes("echo"));
      assert.ok(echoTool);
      await echoTool.execute("call-1", { message: "timeout-check" }, undefined, () => {}, {});
      assert.equal(callToolTimeout, 1234);
    } finally {
      await manager.shutdownAll();
    }
  });

  it("should bound SSE transport.start() with per-server requestTimeoutMs and unblock close() when endpoint event never arrives (Issues 19.2, 20.1)", async () => {
    const { createServer } = await import("node:http");
    const sockets = new Set<any>();
    const server = createServer((_req, res) => {
      // Accept SSE stream and send headers, but NEVER send `event: endpoint`
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": keepalive\n\n");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");

    const manager = new ServerManager({
      settings: { toolPrefix: "mcp", requestTimeoutMs: 5000, maxRetries: 0 },
      mcpServers: {
        sseHang: {
          transport: "sse",
          url: `http://127.0.0.1:${addr.port}/sse`,
          args: [],
          lifecycle: "lazy",
          requestTimeoutMs: 80,
        },
      },
    });

    try {
      const startedAt = Date.now();
      await assert.rejects(
        () => manager.startServer("sseHang", process.cwd()),
        (err: unknown) => {
          assert.ok(err instanceof McpError);
          assert.equal(err.code, "timeout");
          assert.match(err.message, /Connection timed out after 80ms/);
          return true;
        },
      );
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 1500, `Expected fast timeout, took ${elapsed}ms`);
    } finally {
      await manager.shutdownAll();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("should prevent overlapping health check pings and bound each ping with per-server timeout and signal (Issue 19.3)", async () => {
    const config = makeMockConfig({
      settings: { toolPrefix: "mcp", requestTimeoutMs: 5000, maxRetries: 0 },
      mcpServers: {
        test: {
          command: "node",
          args: ["--import", "tsx/esm", MOCK_SERVER_PATH],
          transport: "stdio",
          lifecycle: "lazy",
          requestTimeoutMs: 1234,
          healthCheckIntervalMs: 20,
        },
      },
    });
    const manager = new ServerManager(config);
    try {
      await manager.startServer("test", process.cwd());
      const client = manager.getServer("test")!.client! as any;
      let pingCalls = 0;
      let inFlight = 0;
      let maxInFlight = 0;
      let capturedOptions: any;
      let resolvePing!: () => void;

      client.ping = (opts?: any) => {
        pingCalls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        capturedOptions = opts;
        return new Promise<Record<string, never>>((resolve) => {
          resolvePing = () => {
            inFlight--;
            resolve({});
          };
        });
      };

      // Wait ~75ms (~3-4 health check intervals of 20ms) while first ping is still in-flight
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(pingCalls, 1, "Must not stack overlapping ping() calls while one is in flight");
      assert.equal(maxInFlight, 1);
      assert.equal(capturedOptions?.timeout, 1234);
      assert.ok(capturedOptions?.signal instanceof AbortSignal);
      resolvePing?.();
    } finally {
      await manager.shutdownAll();
    }
  });

  it("should pass cwd to StdioClientTransport and encode roots/list URI with pathToFileURL and basename (Issues 21.1, 21.2)", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { pathToFileURL } = await import("node:url");
    const baseTmp = await mkdtemp(join(tmpdir(), "pi-mcp-cwd-"));
    const specialCwd = join(baseTmp, "work dir #1");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(specialCwd, { recursive: true });

    const sdkServerUrl = import.meta.resolve("@modelcontextprotocol/sdk/server/index.js");
    const sdkStdioUrl = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
    const sdkTypesUrl = import.meta.resolve("@modelcontextprotocol/sdk/types.js");

    const probeScript = join(baseTmp, "probe-server.mjs");
    await writeFile(
      probeScript,
      `
import { Server } from ${JSON.stringify(sdkServerUrl)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdioUrl)};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(sdkTypesUrl)};

const server = new Server(
  { name: "probe", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "inspect_env", inputSchema: { type: "object", properties: {} } }],
}));

server.setRequestHandler(CallToolRequestSchema, async () => {
  const rootsResult = await server.listRoots();
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ cwd: process.cwd(), roots: rootsResult.roots }),
    }],
  };
});

await server.connect(new StdioServerTransport());
`,
    );

    const config: McpConfig = {
      settings: { toolPrefix: "mcp", requestTimeoutMs: 5000, maxRetries: 0 },
      mcpServers: {
        probe: {
          command: "node",
          args: [probeScript],
          transport: "stdio",
          lifecycle: "lazy",
        },
      },
    };
    const manager = new ServerManager(config);
    const mockPi = makeMockPi();
    const bridge = new ToolBridge(config.settings, mockPi as any);
    manager.setToolRefreshCallback(async (name, client, opts) => {
      await bridge.refreshTools(name, client, opts);
    });

    try {
      await manager.startServer("probe", specialCwd);
      const inspectTool = mockPi.tools.find((t) => t.name.includes("inspect_env"));
      assert.ok(inspectTool);
      const res = await inspectTool.execute("c1", {}, undefined, () => {}, {});
      const data = JSON.parse(res.content[0].text);
      assert.equal(data.cwd, specialCwd);
      assert.deepEqual(data.roots, [
        {
          uri: pathToFileURL(specialCwd).href,
          name: "work dir #1",
        },
      ]);
    } finally {
      await manager.shutdownAll();
      await rm(baseTmp, { recursive: true, force: true });
    }
  });

  it("should deterministically terminate child processes that hang during initialize and ignore SIGTERM (Issue 21.3)", async () => {
    const { mkdtemp, rm, writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-pid-leak-"));
    const pidFile = join(dir, "child.pid");
    const hangScript = join(dir, "hang-server.mjs");

    await writeFile(
      hangScript,
      `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {
  // Intentionally ignore SIGTERM to test SIGKILL escalation
});
process.stdin.resume();
setInterval(() => {}, 1000);
`,
    );

    const manager = new ServerManager({
      settings: { toolPrefix: "mcp", requestTimeoutMs: 100, maxRetries: 0 },
      mcpServers: {
        hanger: {
          command: "node",
          args: [hangScript],
          transport: "stdio",
          lifecycle: "lazy",
          requestTimeoutMs: 100,
        },
      },
    });

    try {
      await assert.rejects(() => manager.startServer("hanger", dir));
      const pidText = await readFile(pidFile, "utf8");
      const childPid = Number(pidText.trim());
      assert.ok(childPid > 0);

      // Process must already be dead by the time startServer rejects
      assert.throws(
        () => process.kill(childPid, 0),
        (err: any) => err.code === "ESRCH",
        `Expected child PID ${childPid} to be terminated before startServer finished`,
      );
    } finally {
      await manager.shutdownAll();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("should buffer split multi-byte UTF-8 stderr chunks with StringDecoder and strip terminal control sequences (Issue 21.4)", async () => {
    const serverManagerMod = await import("../src/server-manager.js") as any;
    assert.equal(typeof serverManagerMod.sanitizeStderrLine, "function");

    const dirty = "hello\x1b[31m red\x1b[0m\x1b]0;evil-title\x07\x1b]52;c;YWJj\x1b\\\x1bP1$r\x1b\\\x1bM\x07\x08 world 🚀\r";
    assert.equal(serverManagerMod.sanitizeStderrLine(dirty), "hello red world 🚀");

    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-stderr-"));
    const stderrScript = join(dir, "stderr-server.mjs");
    const sdkServerUrl = import.meta.resolve("@modelcontextprotocol/sdk/server/index.js");
    const sdkStdioUrl = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
    const sdkTypesUrl = import.meta.resolve("@modelcontextprotocol/sdk/types.js");

    // Rocket emoji 🚀 is 4 bytes in UTF-8: 0xF0 0x9F 0x9A 0x80.
    // Write first 2 bytes, flush, then remaining 2 bytes + ANSI sequence + newline, then trailing text without newline.
    await writeFile(
      stderrScript,
      `
import { Server } from ${JSON.stringify(sdkServerUrl)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdioUrl)};
import { ListToolsRequestSchema } from ${JSON.stringify(sdkTypesUrl)};

const server = new Server({ name: "stderr-test", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  process.stderr.write(Buffer.from([0x42, 0x6f, 0x6f, 0x74, 0x20, 0xf0, 0x9f]));
  await new Promise((r) => setTimeout(r, 15));
  process.stderr.write(Buffer.from([0x9a, 0x80, 0x20, 0x1b, 0x5b, 0x33, 0x32, 0x6d, 0x6f, 0x6b, 0x1b, 0x5b, 0x30, 0x6d, 0x0d, 0x0a]));
  process.stderr.write("trailing-without-newline\\x1b]0;title\\x07");
  return { tools: [] };
});
await server.connect(new StdioServerTransport());
`,
    );

    const manager = new ServerManager({
      settings: { toolPrefix: "mcp", requestTimeoutMs: 5000, maxRetries: 0 },
      mcpServers: {
        stderrSrv: {
          command: "node",
          args: [stderrScript],
          transport: "stdio",
          lifecycle: "lazy",
        },
      },
    });
    const mockPi = makeMockPi();
    const bridge = new ToolBridge({ toolPrefix: "mcp", requestTimeoutMs: 5000, maxRetries: 0 }, mockPi as any);
    manager.setToolRefreshCallback(async (name, client, opts) => {
      await bridge.refreshTools(name, client, opts);
    });

    try {
      await manager.startServer("stderrSrv", dir);
      const logsWhileRunning = manager.getServerLogs("stderrSrv");
      assert.ok(logsWhileRunning.includes("Boot 🚀 ok"), `Expected 'Boot 🚀 ok', got: ${logsWhileRunning}`);
      assert.ok(!logsWhileRunning.includes("\ufffd"), "Must not contain replacement character");
      assert.ok(!logsWhileRunning.includes("\x1b"), "Must not contain ESC control characters");

      await manager.stopServer("stderrSrv");
      const logsAfterStop = manager.getServerLogs("stderrSrv");
      assert.ok(logsAfterStop.includes("trailing-without-newline"), `Expected flushed trailing stderr line, got: ${logsAfterStop}`);
    } finally {
      await manager.shutdownAll();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

