/**
 * Integration tests for src/server-manager.ts
 * Spawns the real mock-server.ts over stdio to verify end-to-end behavior.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ServerManager } from "../src/server-manager.js";
import {
  classifyConnectFailure,
  RETRY_DELAYS_MS,
  type ConnectFailureAction,
} from "../src/connect-policy.js";
import { ToolBridge, type PiExtensionAPI } from "../src/tool-bridge.js";
import type { McpConfig } from "../src/config.js";
import { McpError, AuthCancelledError } from "../src/errors.js";
import { AuthRequiredError } from "../src/oauth-provider.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Socket } from "node:net";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMockExtension, createMockContext } from "./helpers/mock-extension.js";

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

interface MockToolResult {
  content: [
    { type: string; text: string; [key: string]: unknown },
    ...Array<{ type: string; text: string; [key: string]: unknown }>,
  ];
  isError?: boolean;
  [key: string]: unknown;
}

interface MockRegisteredTool {
  name: string;
  description?: string;
  parameters?: unknown;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    update?: unknown,
    ctx?: unknown,
  ) => Promise<MockToolResult>;
  [key: string]: unknown;
}

function makeMockPi(): PiExtensionAPI & {
  tools: MockRegisteredTool[];
  getAllTools: () => Array<{
    name: string;
    description: string | undefined;
    parameters: unknown;
    sourceInfo: { path: string; line: number; source: string; scope: string; origin: string };
  }>;
  active: string[];
} {
  const tools: MockRegisteredTool[] = [];
  let active: string[] = [];
  return {
    registerTool: (t) => {
      tools.push(t as unknown as MockRegisteredTool);
    },
    getAllTools: () =>
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        sourceInfo: { path: "test", line: 0, source: "extension", scope: "tool", origin: "test" },
      })),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    tools,
    get active() {
      return active;
    },
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
    bridge = new ToolBridge(config.settings, mockPi);
    manager.setToolRefreshCallback(async (name, client, options) => {
      await bridge.refreshTools(name, client, options);
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
  it("should resolve per-server requestTimeoutMs for tool discovery and execution across initial and list_changed refreshes (Issue 19.1, #65)", async () => {
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
    const bridge = new ToolBridge(config.settings, mockPi);

    const capturedCallbackOptions: Array<{ requestTimeoutMs?: number | undefined; signal?: AbortSignal | undefined } | undefined> = [];
    manager.setToolRefreshCallback(async (name, client, options) => {
      capturedCallbackOptions.push(options);
      await bridge.refreshTools(name, client, options);
    });

    try {
      await manager.startServer("test", process.cwd());
      assert.equal(capturedCallbackOptions.length, 1);
      assert.equal(capturedCallbackOptions[0]?.requestTimeoutMs, 1234);
      assert.ok(capturedCallbackOptions[0]?.signal instanceof AbortSignal);

      const client = manager.getServer("test")!.client!;
      let listToolsTimeout: number | undefined;
      let callToolTimeout: number | undefined;
      const origRequest = client.request.bind(client);
      client.request = async (
        req: Parameters<typeof origRequest>[0],
        schema: Parameters<typeof origRequest>[1],
        options?: Parameters<typeof origRequest>[2],
      ) => {
        if (req.method === "tools/list") {
          listToolsTimeout = options?.timeout;
        }
        if (req.method === "tools/call") {
          callToolTimeout = options?.timeout;
        }
        return origRequest(req, schema, options);
      };

      const echoTool = mockPi.tools.find((t) => t.name.includes("echo"));
      assert.ok(echoTool);
      await echoTool.execute("call-1", { message: "timeout-check" }, undefined, () => {}, {});
      assert.equal(callToolTimeout, 1234);

      // Trigger notifications/tools/list_changed and verify explicit options are passed on re-discovery too
      await (client as unknown as { _onnotification: (msg: unknown) => Promise<void> })._onnotification({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(capturedCallbackOptions.length, 2);
      assert.equal(capturedCallbackOptions[1]?.requestTimeoutMs, 1234);
      assert.ok(capturedCallbackOptions[1]?.signal instanceof AbortSignal);
      assert.equal(listToolsTimeout, 1234);
    } finally {
      await manager.shutdownAll();
    }
  });

  it("should bound SSE transport.start() with per-server requestTimeoutMs and unblock close() when endpoint event never arrives (Issues 19.2, 20.1)", async () => {
    const { createServer } = await import("node:http");
    const sockets = new Set<Socket>();
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
      const client = manager.getServer("test")!.client!;
      let pingCalls = 0;
      let inFlight = 0;
      let maxInFlight = 0;
      let capturedOptions: Parameters<Client["ping"]>[0];
      let resolvePing!: () => void;

      client.ping = (opts?: Parameters<Client["ping"]>[0]) => {
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
    const { mkdtemp, rm, writeFile, mkdir, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { pathToFileURL } = await import("node:url");
    // WHY: On macOS, tmpdir() is under /var which is a symlink to /private/var.
    // Child process.cwd() resolves symlinks, so canonicalize baseTmp to match on darwin and Windows 8.3 paths.
    const baseTmp = await realpath(await mkdtemp(join(tmpdir(), "pi-mcp-cwd-")));
    const specialCwd = join(baseTmp, "work dir #1");
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
    const bridge = new ToolBridge(config.settings, mockPi);
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
      // WHY: 500ms timeout provides enough startup margin on slower macOS/Windows CI runners
      // before initialize times out and triggers process termination.
      settings: { toolPrefix: "mcp", requestTimeoutMs: 500, maxRetries: 0 },
      mcpServers: {
        hanger: {
          command: "node",
          args: [hangScript],
          transport: "stdio",
          lifecycle: "lazy",
          requestTimeoutMs: 500,
        },
      },
    });

    try {
      await assert.rejects(() => manager.startServer("hanger", dir));
      let pidText = "";
      for (let i = 0; i < 50; i++) {
        try {
          pidText = await readFile(pidFile, "utf8");
          if (pidText.trim()) break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
          }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      const childPid = Number(pidText.trim());
      assert.ok(childPid > 0, `Expected child PID written to ${pidFile}`);

      // Process must already be dead by the time startServer rejects
      assert.throws(
        () => process.kill(childPid, 0),
        (err: unknown) => (err as NodeJS.ErrnoException).code === "ESRCH",
        `Expected child PID ${childPid} to be terminated before startServer finished`,
      );
    } finally {
      await manager.shutdownAll();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("should buffer split multi-byte UTF-8 stderr chunks with StringDecoder and strip terminal control sequences (Issue 21.4)", async () => {
    const serverManagerMod = await import("../src/server-manager.js");
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
    const bridge = new ToolBridge({ toolPrefix: "mcp", requestTimeoutMs: 5000, maxRetries: 0 }, mockPi);
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

  it("should dynamically update roots/list cwd and emit notifications/roots/list_changed when updateCwd, startServer, or session_start switches directories with identical config (Issue 18.5)", async () => {
    const { mkdtemp, rm, writeFile, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { pathToFileURL } = await import("node:url");
    const { default: extension } = await import("../src/index.js");

    const baseTmp = await mkdtemp(join(tmpdir(), "pi-mcp-roots-cwd-"));
    const cwd1 = join(baseTmp, "workspace-alpha");
    const cwd2 = join(baseTmp, "workspace-beta");
    const cwd3 = join(baseTmp, "workspace-gamma");
    await mkdir(cwd1, { recursive: true });
    await mkdir(cwd2, { recursive: true });
    await mkdir(cwd3, { recursive: true });

    const sdkServerUrl = import.meta.resolve("@modelcontextprotocol/sdk/server/index.js");
    const sdkStdioUrl = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
    const sdkTypesUrl = import.meta.resolve("@modelcontextprotocol/sdk/types.js");

    const probeScript = join(baseTmp, "roots-probe-server.mjs");
    await writeFile(
      probeScript,
      `
import { Server } from ${JSON.stringify(sdkServerUrl)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdioUrl)};
import { CallToolRequestSchema, ListToolsRequestSchema, RootsListChangedNotificationSchema } from ${JSON.stringify(sdkTypesUrl)};

let rootsChangedNotifications = 0;
const server = new Server(
  { name: "roots-probe", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
  rootsChangedNotifications++;
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "get_roots", inputSchema: { type: "object", properties: {} } }],
}));

server.setRequestHandler(CallToolRequestSchema, async () => {
  const rootsResult = await server.listRoots();
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ roots: rootsResult.roots, notifications: rootsChangedNotifications }),
    }],
  };
});

await server.connect(new StdioServerTransport());
`,
    );

    const globalConfigPath = join(baseTmp, "global-mcp.json");
    await writeFile(
      globalConfigPath,
      JSON.stringify({
        settings: { toolPrefix: "mcp", requestTimeoutMs: 5000, maxRetries: 0 },
        mcpServers: {
          rootsSrv: {
            command: "node",
            args: [probeScript],
            transport: "stdio",
            lifecycle: "lazy",
          },
        },
      }),
    );

    const mockExt = createMockExtension();
    const tools = mockExt.tools;
    const events = mockExt.events;
    const makeCtx = (cwd: string) =>
      createMockContext({
        cwd,
        hasUI: false,
      });

    try {
      await extension(mockExt.api, { bootstrapCwd: cwd1, globalConfigPath });
      const ctx1 = makeCtx(cwd1);
      await events.get("session_start")({}, ctx1);

      // Connect lazy server in cwd1
      await tools.get("mcp_connect").execute("", { name: "rootsSrv" }, undefined, undefined, ctx1);
      const getRootsTool = tools.get("mcp_rootsSrv_get_roots");
      assert.ok(getRootsTool);

      const res1 = JSON.parse((await getRootsTool.execute("1", {}, undefined, () => {}, ctx1)).content[0].text);
      assert.deepEqual(res1.roots, [{ uri: pathToFileURL(cwd1).href, name: "workspace-alpha" }]);
      assert.equal(res1.notifications, 0);

      // Switch session to cwd2 (identical global McpConfig, server already ready!)
      const ctx2 = makeCtx(cwd2);
      await events.get("session_start")({}, ctx2);
      // Allow notification frame to be processed by child server
      await new Promise((r) => setTimeout(r, 25));

      const res2 = JSON.parse((await getRootsTool.execute("2", {}, undefined, () => {}, ctx2)).content[0].text);
      assert.deepEqual(res2.roots, [{ uri: pathToFileURL(cwd2).href, name: "workspace-beta" }]);
      assert.equal(res2.notifications, 1, "Expected 1 notifications/roots/list_changed when session_start switches to cwd2");

      // Also verify ServerManager.startServer(name, cwd3) on an already-ready server updates cwd and emits roots/list_changed
      const config: McpConfig = {
        settings: { toolPrefix: "mcp", requestTimeoutMs: 5000, maxRetries: 0 },
        mcpServers: {
          directProbe: {
            command: "node",
            args: [probeScript],
            transport: "stdio",
            lifecycle: "lazy",
          },
        },
      };
      const manager = new ServerManager(config);
      const mockPi = makeMockPi();
      const bridge = new ToolBridge(config.settings, mockPi);
      manager.setToolRefreshCallback(async (name, client, opts) => {
        await bridge.refreshTools(name, client, opts);
      });
      try {
        await manager.startServer("directProbe", cwd1);
        await manager.startServer("directProbe", cwd3);
        await new Promise((r) => setTimeout(r, 25));
        const directTool = mockPi.tools.find((t) => t.name.includes("get_roots"))!;
        const res3 = JSON.parse((await directTool.execute("3", {}, undefined, () => {}, {})).content[0].text);
        assert.deepEqual(res3.roots, [{ uri: pathToFileURL(cwd3).href, name: "workspace-gamma" }]);
        assert.equal(res3.notifications, 1);
      } finally {
        await manager.shutdownAll();
      }
    } finally {
      await events.get("session_shutdown")?.({}, makeCtx(baseTmp));
      await rm(baseTmp, { recursive: true, force: true });
    }
  });

  it("detaches the retry-backoff abort listener when the timer fires so listeners do not accumulate across retries (#67)", async (t) => {
    const { EventEmitter } = await import("node:events");
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const maxRetries = 12;
    const config = makeMockConfig({
      settings: {
        toolPrefix: "mcp",
        requestTimeoutMs: 5000,
        maxRetries,
      },
      mcpServers: {
        failing: {
          url: "http://127.0.0.1:1/mcp",
          args: [],
          transport: "streamable-http",
          lifecycle: "lazy",
        },
      },
    });

    const manager = new ServerManager(config);
    let capturedSignal: AbortSignal | undefined;

    t.mock.method(
      manager as unknown as {
        _connectWithTimeoutAndSignal: (
          _client: unknown,
          _transport: unknown,
          _timeoutMs: number,
          signal: AbortSignal,
        ) => Promise<never>;
      },
      "_connectWithTimeoutAndSignal",
      async (_client: unknown, _transport: unknown, _timeoutMs: number, signal: AbortSignal) => {
        capturedSignal = signal;
        throw new Error("simulated transport connection failure");
      },
    );

    const startPromise = manager.startServer("failing", process.cwd());
    const assertionPromise = assert.rejects(startPromise, (err: unknown) => {
      assert.ok(err instanceof McpError);
      assert.match(err.message, /Connection failed after 12 retries/);
      return true;
    });

    for (let i = 0; i < maxRetries; i++) {
      for (let tick = 0; tick < 10; tick++) {
        await Promise.resolve();
      }
      assert.ok(capturedSignal, "Expected connection AbortSignal to be captured");
      assert.equal(
        EventEmitter.getEventListeners(capturedSignal, "abort").length,
        1,
        `Expected 1 abort listener while retry #${i + 1} timer is pending`,
      );
      t.mock.timers.tick(60000);
    }

    await assertionPromise;
    const failedServer = manager.getServer("failing");
    assert.ok(failedServer?.lastError instanceof Error);
    assert.equal(failedServer.lastError instanceof McpError, false);
    assert.equal(failedServer.lastError.message, "simulated transport connection failure");
    assert.ok(capturedSignal);
    assert.equal(
      EventEmitter.getEventListeners(capturedSignal, "abort").length,
      0,
      "Expected 0 lingering abort listeners after all retry timers fired",
    );
  });

  it("sanitizes ANSI/OSC/DCS/C1 sequences, control chars, line breaks, and oversized surrogate-pair strings in sanitizeTerminalText (#66)", async () => {
    const { sanitizeTerminalText, DEFAULT_TERMINAL_TEXT_MAX_LENGTH } = await import("../src/terminal-text.js");

    // 1. CSI color/cursor codes & 8-bit CSI
    assert.equal(
      sanitizeTerminalText("\x1b[31mred\x1b[0m \x1b[2J\x1b[10;20Hmoved \u009b32mgreen\u009b0m"),
      "red moved green",
    );

    // 2. OSC 0 title, OSC 52 clipboard, OSC 8 hyperlink (BEL, ESC \, and C1 ST terminators)
    const oscInput = [
      "\x1b]0;spoofed-title\x07",
      "\x1b]52;c;ZXYpbA==\x1b\\",
      "\u009d52;c;ZXYpbA==\u009c",
      "\x1b]8;;https://evil.example/phish\x1b\\ClickHere\x1b]8;;\x1b\\",
    ].join("");
    assert.equal(sanitizeTerminalText(oscInput), "ClickHere");

    // 3. DCS, SOS, PM, APC (7-bit and C1 8-bit variants)
    const dcsInput =
      "before\x1bP1$r\x1b\\mid1\x1bXhf\x1b\\mid2\x1b^pm\x1b\\mid3\x1b_apc\x1b\\mid4\u0090dcs\u009c\u0098sos\u009c\u009epm\u009c\u009fapc\u009cafter";
    assert.equal(sanitizeTerminalText(dcsInput), "beforemid1mid2mid3mid4after");

    // 4. Embedded \r and \n, NUL, BEL, BS, DEL, C1 controls, and multi-byte UTF-8 / emoji preservation
    const multilineControl =
      "line1\r\n[pi-mcp] fake-log\nline3\roverwrite\x00\x07\x08\x7f\u0085\tBoot 🚀 café 日本語";
    const cleaned = sanitizeTerminalText(multilineControl);
    assert.equal(cleaned, "line1 [pi-mcp] fake-log line3 overwrite Boot 🚀 café 日本語");
    assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(cleaned), "Must not contain any C0 or C1 control characters");

    // 5. Default length bound (500) and custom maxLength
    const longInput = "x".repeat(DEFAULT_TERMINAL_TEXT_MAX_LENGTH + 200);
    const defaultTruncated = sanitizeTerminalText(longInput);
    assert.equal(defaultTruncated.length, DEFAULT_TERMINAL_TEXT_MAX_LENGTH);
    assert.ok(defaultTruncated.endsWith("…"));
    assert.equal(sanitizeTerminalText("abcdef", { maxLength: 4 }), "abc…");
    assert.equal(sanitizeTerminalText("abcdef", { maxLength: 1 }), "…");
    assert.equal(sanitizeTerminalText("abcdef", { maxLength: 0 }), "");

    // 6. Surrogate-pair boundary safety (🚀 is 2 UTF-16 code units: \uD83D\uDE80)
    // "a".repeat(9) + "🚀" + "b" has 12 UTF-16 code units. With maxLength: 11, targetLen is 10,
    // which lands right between the high surrogate (\uD83D at index 9) and low surrogate (\uDE80 at index 10).
    const emojiBoundary = `${"a".repeat(9)}🚀b`;
    const truncatedAtPair = sanitizeTerminalText(emojiBoundary, { maxLength: 11 });
    assert.equal(truncatedAtPair, `${"a".repeat(9)}…`);
    assert.ok(
      !/[\uD800-\uDFFF]/u.test(truncatedAtPair),
      `Truncated string must not contain lone surrogates: ${JSON.stringify(truncatedAtPair)}`,
    );
  });

  it("sanitizes notifications/message fields and server error messages across stderrLog, the debug log, /mcp, and ctx.ui.notify (#66)", async (t) => {
    const { mkdtemp, rm, writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { default: extension } = await import("../src/index.js");
    const { DebugLog, setDebugLog } = await import("../src/debug-log.js");

    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-sanitize-66-"));
    const scriptPath = join(dir, "malicious-server.mjs");
    const sdkServerUrl = import.meta.resolve("@modelcontextprotocol/sdk/server/index.js");
    const sdkStdioUrl = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
    const sdkTypesUrl = import.meta.resolve("@modelcontextprotocol/sdk/types.js");

    await writeFile(
      scriptPath,
      `
import { Server } from ${JSON.stringify(sdkServerUrl)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdioUrl)};
import { ListToolsRequestSchema } from ${JSON.stringify(sdkTypesUrl)};

const mode = process.argv[2] ?? "log";
const server = new Server(
  { name: "malicious-srv", version: "1.0.0" },
  { capabilities: { tools: {}, logging: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (mode === "fail") {
    throw new Error(
      "boom\\x1b]52;c;ZXYpbA==\\x07\\x1b[31m\\r\\n[pi-mcp] spoofed-error-line " + "E".repeat(700),
    );
  }
  await server.sendLoggingMessage({
    level: "warning",
    logger: "db\\x1b]0;pwned\\x07\\r\\n[pi-mcp] spoofed",
    data: {
      msg: "payload\\x1b]8;;https://evil.example\\x1b\\\\link\\x1b]8;;\\x1b\\\\\\nsecond-line",
      pad: "D".repeat(700),
    },
  });
  return {
    tools: [{ name: "noop", description: "noop", inputSchema: { type: "object", properties: {} } }],
  };
});

await server.connect(new StdioServerTransport());
`,
    );

    const globalConfigPath = join(dir, "global-mcp.json");
    await writeFile(
      globalConfigPath,
      JSON.stringify({
        settings: { toolPrefix: "mcp", requestTimeoutMs: 5000, maxRetries: 0 },
        mcpServers: {
          logSrv: {
            command: "node",
            args: [scriptPath, "log"],
            transport: "stdio",
            lifecycle: "lazy",
          },
          failSrv: {
            command: "node",
            args: [scriptPath, "fail"],
            transport: "stdio",
            lifecycle: "lazy",
          },
        },
      }),
    );

    const stderrCalls: string[] = [];
    t.mock.method(console, "error", (...args: unknown[]) => {
      stderrCalls.push(args.map((a) => String(a)).join(" "));
    });

    const mockExt = createMockExtension();
    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = createMockContext({
      cwd: dir,
      hasUI: true,
      ui: {
        notify: (message: string, level = "info") => {
          notifications.push({ message, level });
        },
      },
    });

    const assertNoEscapeOrControl = (text: string, allowNewlines = false) => {
      assert.ok(!text.includes("\x1b"), `Must not contain ESC sequence: ${JSON.stringify(text)}`);
      const pattern = allowNewlines ? /[\x00-\x09\x0b-\x1f\x7f-\x9f]/ : /[\x00-\x1f\x7f-\x9f]/;
      assert.ok(!pattern.test(text), `Must not contain control characters: ${JSON.stringify(text)}`);
    };

    // The debug log is enabled so the sanitized server output can be inspected
    // where it now goes: the log file instead of Pi's stderr.
    const logDir = join(dir, "logs");
    const debugLog = new DebugLog(logDir);
    setDebugLog(debugLog);

    try {
      await extension(mockExt.api, { bootstrapCwd: dir, globalConfigPath });
      await mockExt.events.get("session_start")({}, ctx);

      // 1. Start logSrv — sends malicious notifications/message during tools/list
      await mockExt.commands.get("mcp:start").handler("logSrv", ctx);
      await new Promise((r) => setTimeout(r, 30));

      // While a UI is active the extension must not write to Pi's stderr (#71).
      assert.deepEqual(
        stderrCalls,
        [],
        `Expected no stderr output while a UI is active, got: ${JSON.stringify(stderrCalls)}`,
      );

      await debugLog.flush();
      const logText = await readFile(join(logDir, "pi-mcp.log"), "utf-8");
      assertNoEscapeOrControl(logText, true);
      const logLine = logText
        .split("\n")
        .find((line) => line.includes('"event":"server.log"'));
      assert.ok(logLine, `Expected a server.log entry in the debug log, got: ${JSON.stringify(logText)}`);
      assert.ok(logLine.includes("[warning] db [pi-mcp] spoofed:"));
      assert.ok(logLine.includes("…"), "Expected oversized notifications/message data to be truncated");
      const logEntry = JSON.parse(logLine) as { message: string; server: string };
      assert.equal(logEntry.server, "logSrv");
      assert.ok(logEntry.message.endsWith("…"));

      // Inspect /mcp logSrv detail output
      notifications.length = 0;
      await mockExt.commands.get("mcp").handler("logSrv", ctx);
      const logDetail = notifications.at(-1)?.message ?? "";
      assertNoEscapeOrControl(logDetail, true);
      assert.ok(logDetail.includes("[warning] db [pi-mcp] spoofed:"));

      // 2. Start failSrv — throws malicious error during tools/list
      notifications.length = 0;
      await mockExt.commands.get("mcp:start").handler("failSrv", ctx);
      const startFailNotify = notifications.at(-1);
      assert.ok(startFailNotify);
      assert.equal(startFailNotify.level, "error");
      assertNoEscapeOrControl(startFailNotify.message, false);
      assert.ok(startFailNotify.message.includes("boom [pi-mcp] spoofed-error-line"));
      assert.ok(startFailNotify.message.endsWith("…"), "Expected oversized start error notification to be truncated");

      // 3. Check /mcp summary and /mcp failSrv detail view
      notifications.length = 0;
      await mockExt.commands.get("mcp").handler("", ctx);
      const summaryNotify = notifications.at(-1)?.message ?? "";
      assertNoEscapeOrControl(summaryNotify, true);
      const failSummaryLine = summaryNotify.split("\n").find((l) => l.includes("failSrv"));
      assert.ok(failSummaryLine, `Expected failSrv line in summary: ${summaryNotify}`);
      assertNoEscapeOrControl(failSummaryLine, false);
      assert.ok(failSummaryLine.endsWith("…"));

      notifications.length = 0;
      await mockExt.commands.get("mcp").handler("failSrv", ctx);
      const failDetailNotify = notifications.at(-1)?.message ?? "";
      assertNoEscapeOrControl(failDetailNotify, true);
      const lastErrorLine = failDetailNotify.split("\n").find((l) => l.startsWith("Last error: "));
      assert.ok(lastErrorLine, `Expected Last error line in detail view: ${failDetailNotify}`);
      assertNoEscapeOrControl(lastErrorLine, false);
      assert.ok(lastErrorLine.endsWith("…"));
    } finally {
      setDebugLog(null);
      await mockExt.events.get("session_shutdown")?.({}, ctx);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("classifyConnectFailure", () => {
  interface TestCase {
    name: string;
    input: Parameters<typeof classifyConnectFailure>[0];
    expectedKind: ConnectFailureAction["kind"];
    assertDetails?: (action: ConnectFailureAction) => void;
  }

  const defaultInput = {
    error: new Error("connection reset"),
    aborted: false,
    corruptStateRecovered: false,
    hasAuth: false,
    transport: "streamable-http" as const,
    retryCount: 0,
    maxRetries: 3,
    serverName: "test-srv",
  };

  const testCases: TestCase[] = [
    // 1. Cancellation
    {
      name: "returns 'cancelled' when aborted is true",
      input: { ...defaultInput, aborted: true },
      expectedKind: "cancelled",
    },
    {
      name: "returns 'cancelled' when error is AuthCancelledError (even if aborted is false)",
      input: { ...defaultInput, aborted: false, error: new AuthCancelledError("test-srv") },
      expectedKind: "cancelled",
    },
    {
      name: "returns 'cancelled' when both aborted is true and error is AuthCancelledError",
      input: { ...defaultInput, aborted: true, error: new AuthCancelledError("test-srv") },
      expectedKind: "cancelled",
    },

    // 2. Corrupt OAuth state
    {
      name: "returns 'retry-corrupt-state' on corrupt state McpError when corruptStateRecovered is false",
      input: {
        ...defaultInput,
        error: new McpError("Corrupt OAuth state file /path/to/tokens.json: SyntaxError", "test-srv", "config"),
        corruptStateRecovered: false,
      },
      expectedKind: "retry-corrupt-state",
    },
    {
      name: "fast-fails as 'fail' on corrupt state McpError when corruptStateRecovered is true",
      input: {
        ...defaultInput,
        error: new McpError("Corrupt OAuth state file /path/to/tokens.json: SyntaxError", "test-srv", "config"),
        corruptStateRecovered: true,
      },
      expectedKind: "fail",
      assertDetails: (action) => {
        assert.equal(action.kind, "fail");
        assert.ok(action.error instanceof McpError);
        assert.equal(action.error.code, "config");
      },
    },

    // 3. AuthRequiredError (already thrown by OAuthProvider)
    {
      name: "returns 'auth-required' with invalidateTokens=false on direct AuthRequiredError",
      input: {
        ...defaultInput,
        error: new AuthRequiredError("test-srv"),
        hasAuth: true,
      },
      expectedKind: "auth-required",
      assertDetails: (action) => {
        assert.equal(action.kind, "auth-required");
        assert.equal(action.invalidateTokens, false);
      },
    },
    {
      name: "returns 'auth-required' with invalidateTokens=false on direct AuthRequiredError even if hasAuth is false",
      input: {
        ...defaultInput,
        error: new AuthRequiredError("test-srv"),
        hasAuth: false,
      },
      expectedKind: "auth-required",
      assertDetails: (action) => {
        assert.equal(action.kind, "auth-required");
        assert.equal(action.invalidateTokens, false);
      },
    },

    // 4. OAuth unauthorized errors (isOAuthUnauthorizedError)
    {
      name: "returns 'auth-required' with invalidateTokens=true for streamable-http with auth on 401",
      input: {
        ...defaultInput,
        error: new UnauthorizedError("401 Unauthorized"),
        hasAuth: true,
        transport: "streamable-http",
      },
      expectedKind: "auth-required",
      assertDetails: (action) => {
        assert.equal(action.kind, "auth-required");
        assert.equal(action.invalidateTokens, true);
      },
    },
    {
      name: "returns 'auth-required' with invalidateTokens=true for sse with auth on 401",
      input: {
        ...defaultInput,
        error: new UnauthorizedError("401 Unauthorized"),
        hasAuth: true,
        transport: "sse",
      },
      expectedKind: "auth-required",
      assertDetails: (action) => {
        assert.equal(action.kind, "auth-required");
        assert.equal(action.invalidateTokens, true);
      },
    },
    {
      name: "WHY: prioritizes OAuth-401 over protocol fast-fail when protocol McpError contains 401 and hasAuth=true",
      input: {
        ...defaultInput,
        error: new McpError("POSTing to https://example.com/mcp: 401 Unauthorized", "test-srv", "protocol"),
        hasAuth: true,
        transport: "streamable-http",
      },
      expectedKind: "auth-required",
      assertDetails: (action) => {
        assert.equal(action.kind, "auth-required");
        assert.equal(action.invalidateTokens, true);
      },
    },
    {
      name: "does not return 'auth-required' on 401 when hasAuth is false (fails or retries)",
      input: {
        ...defaultInput,
        error: new McpError("POSTing to https://example.com/mcp: 401 Unauthorized", "test-srv", "protocol"),
        hasAuth: false,
        transport: "streamable-http",
      },
      expectedKind: "fail", // Protocol McpError fast-fails when not handled as auth
    },
    {
      name: "does not return 'auth-required' on 401 when transport is stdio",
      input: {
        ...defaultInput,
        error: new UnauthorizedError("401 Unauthorized"),
        hasAuth: true,
        transport: "stdio",
      },
      expectedKind: "retry", // UnauthorizedError is not an McpError, so stdio retries
    },

    // 5. Fast-fail (protocol or config error)
    {
      name: "fast-fails as 'fail' on protocol McpError (non-401)",
      input: {
        ...defaultInput,
        error: new McpError("JSON-RPC parse error", "test-srv", "protocol"),
      },
      expectedKind: "fail",
      assertDetails: (action) => {
        assert.equal(action.kind, "fail");
        assert.ok(action.error instanceof McpError);
        assert.equal(action.error.code, "protocol");
      },
    },
    {
      name: "fast-fails as 'fail' on config McpError (non-corrupt-state)",
      input: {
        ...defaultInput,
        error: new McpError("Invalid server configuration", "test-srv", "config"),
      },
      expectedKind: "fail",
      assertDetails: (action) => {
        assert.equal(action.kind, "fail");
        assert.ok(action.error instanceof McpError);
        assert.equal(action.error.code, "config");
      },
    },

    // 6. Retries exhausted (give-up)
    {
      name: "returns 'give-up' when retryCount equals maxRetries",
      input: {
        ...defaultInput,
        retryCount: 3,
        maxRetries: 3,
        error: new Error("ECONNREFUSED"),
      },
      expectedKind: "give-up",
      assertDetails: (action) => {
        assert.equal(action.kind, "give-up");
        assert.ok(action.error instanceof McpError);
        assert.equal(action.error.code, "connection");
        assert.equal(action.error.server, "test-srv");
        assert.ok(action.error.message.includes("Connection failed after 3 retries: ECONNREFUSED"));
      },
    },
    {
      name: "returns 'give-up' when retryCount exceeds maxRetries",
      input: {
        ...defaultInput,
        retryCount: 5,
        maxRetries: 3,
        error: new Error("ECONNREFUSED"),
      },
      expectedKind: "give-up",
      assertDetails: (action) => {
        assert.equal(action.kind, "give-up");
        assert.ok(action.error instanceof McpError);
        assert.equal(action.error.code, "connection");
      },
    },
    {
      name: "returns 'give-up' with code 'timeout' when exhausted error is a timeout McpError",
      input: {
        ...defaultInput,
        retryCount: 2,
        maxRetries: 2,
        error: new McpError("Connection timed out after 5000ms", "test-srv", "timeout"),
      },
      expectedKind: "give-up",
      assertDetails: (action) => {
        assert.equal(action.kind, "give-up");
        assert.ok(action.error instanceof McpError);
        assert.equal(action.error.code, "timeout");
        assert.equal(action.error.server, "test-srv");
      },
    },
    {
      name: "falls back to error.server on give-up when input.serverName is omitted",
      input: {
        error: new McpError("Server down", "inferred-srv", "connection"),
        aborted: false,
        corruptStateRecovered: false,
        hasAuth: false,
        transport: "streamable-http",
        retryCount: 1,
        maxRetries: 1,
      },
      expectedKind: "give-up",
      assertDetails: (action) => {
        assert.equal(action.kind, "give-up");
        assert.equal(action.error.server, "inferred-srv");
      },
    },
    {
      name: "falls back to empty server name on give-up when both serverName and error.server are missing",
      input: {
        error: new Error("Bare failure"),
        aborted: false,
        corruptStateRecovered: false,
        hasAuth: false,
        transport: "streamable-http",
        retryCount: 1,
        maxRetries: 1,
      },
      expectedKind: "give-up",
      assertDetails: (action) => {
        assert.equal(action.kind, "give-up");
        assert.equal(action.error.server, "");
      },
    },

    // 7. Retries scheduled with delays
    {
      name: "returns 'retry' with delay schedule for retryCount 0",
      input: { ...defaultInput, retryCount: 0, maxRetries: 5 },
      expectedKind: "retry",
      assertDetails: (action) => {
        assert.equal(action.kind, "retry");
        assert.equal(action.delayMs, RETRY_DELAYS_MS[0]);
      },
    },
    {
      name: "returns 'retry' with delay schedule for retryCount 1",
      input: { ...defaultInput, retryCount: 1, maxRetries: 5 },
      expectedKind: "retry",
      assertDetails: (action) => {
        assert.equal(action.kind, "retry");
        assert.equal(action.delayMs, RETRY_DELAYS_MS[1]);
      },
    },
    {
      name: "returns 'retry' with delay schedule for retryCount 2",
      input: { ...defaultInput, retryCount: 2, maxRetries: 5 },
      expectedKind: "retry",
      assertDetails: (action) => {
        assert.equal(action.kind, "retry");
        assert.equal(action.delayMs, RETRY_DELAYS_MS[2]);
      },
    },
    {
      name: "returns 'retry' with delay schedule for retryCount 3",
      input: { ...defaultInput, retryCount: 3, maxRetries: 5 },
      expectedKind: "retry",
      assertDetails: (action) => {
        assert.equal(action.kind, "retry");
        assert.equal(action.delayMs, RETRY_DELAYS_MS[3]);
      },
    },
    {
      name: "returns 'retry' with capped delay schedule for high retryCount",
      input: { ...defaultInput, retryCount: 10, maxRetries: 20 },
      expectedKind: "retry",
      assertDetails: (action) => {
        assert.equal(action.kind, "retry");
        assert.equal(action.delayMs, RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
      },
    },
    {
      name: "returns 'retry' with 30000ms fallback delay when retryCount is out-of-bounds negative",
      input: { ...defaultInput, retryCount: -1, maxRetries: 3 },
      expectedKind: "retry",
      assertDetails: (action) => {
        assert.equal(action.kind, "retry");
        assert.equal(action.delayMs, 30000);
      },
    },

    // 8. Non-Error inputs
    {
      name: "handles non-Error thrown string values cleanly",
      input: { ...defaultInput, error: "string error message", retryCount: 0, maxRetries: 2 },
      expectedKind: "retry",
      assertDetails: (action) => {
        assert.equal(action.kind, "retry");
        assert.equal(action.delayMs, 1000);
      },
    },
    {
      name: "handles non-Error thrown string values on retries exhausted",
      input: { ...defaultInput, error: "string error message", retryCount: 2, maxRetries: 2 },
      expectedKind: "give-up",
      assertDetails: (action) => {
        assert.equal(action.kind, "give-up");
        assert.ok(action.error.message.includes("string error message"));
      },
    },
    {
      name: "preserves structured status property on non-Error object for OAuth 401 detection",
      input: {
        ...defaultInput,
        error: { status: 401, message: "Unauthorized" },
        hasAuth: true,
        transport: "streamable-http",
      },
      expectedKind: "auth-required",
      assertDetails: (action) => {
        assert.equal(action.kind, "auth-required");
        assert.equal(action.invalidateTokens, true);
      },
    },
  ];

  for (const tc of testCases) {
    it(tc.name, () => {
      const result = classifyConnectFailure(tc.input);
      assert.equal(result.kind, tc.expectedKind);
      tc.assertDetails?.(result);
    });
  }
});



