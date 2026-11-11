/**
 * End-to-end tests for MCP `notifications/progress` bridging (#254).
 *
 * Spawns tests/mock-server.ts with MOCK_PROGRESS=1 and drives a real `tools/call` through the
 * SDK, so the progress token, the notification round-trip, and the timeout reset are all
 * exercised over the wire rather than through a fake client.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ServerManager } from "../src/server-manager.js";
import { ToolBridge, type PiExtensionAPI } from "../src/tool-bridge.js";
import type { McpConfig } from "../src/config.js";
import { McpError } from "../src/errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER_PATH = join(__dirname, "mock-server.ts");

// Connect and `tools/list` share the config timeout with `tools/call`, so the connection keeps the
// production default: a cold CI runner needs headroom to spawn node, compile the mock through tsx,
// and complete `initialize`. The call deadline the tests exercise is set explicitly afterwards.
const CONNECT_TIMEOUT_MS = 30000;
// WHY: the mock's steps are 4x shorter than this deadline and the whole call is twice as long, so
// a call can only finish if each progress notification restarts the SDK's inactivity timer
// (`resetTimeoutOnProgress`) — and a scheduling hiccup between two steps cannot trip it.
const REQUEST_TIMEOUT_MS = 400;
const STEP_MS = 100;
const STEPS = 8;

interface RegisteredTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: { content: Array<{ type: string; text?: string }> }) => void,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}

function makeMockPi(): { api: PiExtensionAPI; tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  let active: string[] = [];
  const api = {
    registerTool: (t: unknown) => {
      tools.push(t as RegisteredTool);
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
  } as unknown as PiExtensionAPI;
  return { api, tools };
}

function makeConfig(): McpConfig {
  return {
    settings: { toolPrefix: "mcp", requestTimeoutMs: CONNECT_TIMEOUT_MS, maxRetries: 0 },
    mcpServers: {
      test: {
        command: "node",
        args: ["--import", "tsx/esm", MOCK_SERVER_PATH],
        transport: "stdio",
        lifecycle: "lazy",
        requestTimeoutMs: CONNECT_TIMEOUT_MS,
        env: { MOCK_PROGRESS: "1" },
      },
    },
  };
}

describe("MCP notifications/progress over stdio (#254)", () => {
  let manager: ServerManager;
  let tools: RegisteredTool[];
  let progressTool: RegisteredTool;
  let silentTool: RegisteredTool;

  before(async () => {
    const mockPi = makeMockPi();
    tools = mockPi.tools;
    const bridge = new ToolBridge(makeConfig().settings, mockPi.api);
    manager = new ServerManager(makeConfig());
    manager.setToolRefreshCallback(async (name, client, options) => {
      await bridge.refreshTools(name, client, options);
    });
    await manager.startServer("test", process.cwd());
    const client = manager.getServer("test")?.client;
    assert.ok(client, "mock server did not connect");
    // Pin the per-server `tools/call` timeout (the connect above used CONNECT_TIMEOUT_MS).
    await bridge.refreshTools("test", client, { requestTimeoutMs: REQUEST_TIMEOUT_MS });
    const tool = tools.find((t) => t.name.includes("report_progress"));
    assert.ok(tool, `mock server must expose report_progress, registered: ${tools.map((t) => t.name).join(", ")}`);
    progressTool = tool;
    const silent = tools.find((t) => t.name.includes("silent_wait"));
    assert.ok(silent, "mock server must expose silent_wait");
    silentTool = silent;
  });

  after(async () => {
    await manager.shutdownAll();
  });

  it("keeps an actively reporting tool alive past the request timeout", async () => {
    const updates: string[] = [];
    // 8 × 100ms = 800ms of work against a 400ms request timeout.
    const result = await progressTool.execute(
      "call-live",
      { steps: STEPS, stepMs: STEP_MS },
      undefined,
      (update) => {
        updates.push(update.content[0]?.text ?? "");
      },
      {},
    );

    assert.equal(result.content[0]?.text, `Completed ${STEPS} steps`);
    assert.deepEqual(
      updates,
      Array.from({ length: STEPS }, (_, index) => `Progress ${index + 1}/${STEPS}`),
    );
  });

  it("asks for progress even when Pi passes no onUpdate callback", async () => {
    const startedAt = Date.now();
    const result = await progressTool.execute(
      "call-headless",
      { steps: STEPS, stepMs: STEP_MS },
      undefined,
      undefined,
      {},
    );

    assert.equal(result.content[0]?.text, `Completed ${STEPS} steps`);
    assert.ok(
      Date.now() - startedAt > REQUEST_TIMEOUT_MS,
      "the call must outlive the request timeout; a timeout error would mean no progress token",
    );
  });

  it("sanitizes the server's progress text and collapses a repeated line", async () => {
    const updates: string[] = [];
    await progressTool.execute(
      "call-message",
      { steps: 3, stepMs: 60, message: "\u001b[31mDeploying\u001b[0m" },
      undefined,
      (update) => {
        updates.push(update.content[0]?.text ?? "");
      },
      {},
    );

    assert.deepEqual(updates, ["Deploying"], "one identical message for every tick renders once");
  });

  it("still times out a tool that reports no progress", async () => {
    const startedAt = Date.now();
    await assert.rejects(
      // Longer than the request timeout, and this tool sends no notifications at all.
      () => silentTool.execute("call-silent", { ms: 900 }, undefined, undefined, {}),
      (err: unknown) => {
        assert.ok(err instanceof McpError, `expected an McpError, got ${String(err)}`);
        assert.equal(err.code, "timeout");
        return true;
      },
    );
    assert.ok(
      Date.now() - startedAt < 900,
      "the deadline must fire before the tool could have finished",
    );
  });
});

describe("MCP notifications/progress error isolation over streamable-http (#254)", () => {
  it("does not tear down the HTTP connection or fail tools/call on malformed progress or a throwing onUpdate", async () => {
    const { createServer } = await import("node:http");
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { DebugLog, setDebugLog } = await import("../src/debug-log.js");

    let initializeCount = 0;
    const httpServer = createServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id?: number;
          method?: string;
          params?: { name?: string; _meta?: { progressToken?: string | number } };
        };
        if (msg.method === "initialize") {
          initializeCount += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "http-progress", version: "1.0.0" },
              },
            }),
          );
          return;
        }
        if (msg.method === "notifications/initialized") {
          res.writeHead(202).end();
          return;
        }
        if (msg.method === "tools/list") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                tools: [
                  { name: "null_total_progress", inputSchema: { type: "object", properties: {} } },
                  { name: "valid_progress", inputSchema: { type: "object", properties: {} } },
                ],
              },
            }),
          );
          return;
        }
        if (msg.method === "tools/call") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const progressToken = msg.params?._meta?.progressToken;
          const progressPayload =
            msg.params?.name === "null_total_progress"
              ? { progressToken, progress: 1, total: null, message: "token=sk-secret-value" }
              : { progressToken, progress: 1, total: 2, message: "halfway" };
          res.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: progressPayload,
            })}\n\n`,
          );
          // Yield past setImmediate so any mistakenly scheduled _recover() would close the client
          // before the final result arrives.
          setImmediate(() => {
            setImmediate(() => {
              res.write(
                `event: message\ndata: ${JSON.stringify({
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: { content: [{ type: "text", text: `ok:${String(msg.params?.name)}` }] },
                })}\n\n`,
              );
              res.end();
            });
          });
          return;
        }
        res.writeHead(400).end();
      });
    });

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    assert.ok(address && typeof address === "object");
    const logDir = await mkdtemp(join(tmpdir(), "pi-mcp-http-progress-"));
    const debugLog = new DebugLog(logDir);
    setDebugLog(debugLog);

    const mockPi = makeMockPi();
    const settings = { toolPrefix: "mcp", requestTimeoutMs: 5000, maxRetries: 0 };
    const bridge = new ToolBridge(settings, mockPi.api);
    const manager = new ServerManager({
      settings,
      mcpServers: {
        httpSrv: {
          transport: "streamable-http",
          url: `http://127.0.0.1:${address.port}/mcp`,
          args: [],
          lifecycle: "lazy",
        },
      },
    });
    manager.setToolRefreshCallback(async (name, client, options) => {
      await bridge.refreshTools(name, client, options);
    });

    try {
      await manager.startServer("httpSrv", process.cwd());
      assert.equal(initializeCount, 1);

      const nullTotalTool = mockPi.tools.find((t) => t.name.includes("null_total_progress"));
      const validTool = mockPi.tools.find((t) => t.name.includes("valid_progress"));
      assert.ok(nullTotalTool && validTool);

      // 1. Server serializes `total: null` in notifications/progress once _meta.progressToken is present.
      const res1 = await nullTotalTool.execute("http-call-1", {}, undefined, () => {}, {});
      assert.equal(res1.content[0]?.text, "ok:null_total_progress");
      assert.equal(initializeCount, 1, "malformed progress notification must not reconnect the HTTP server");

      // 2. Caller's onUpdate throws synchronously on a valid progress notification.
      const res2 = await validTool.execute(
        "http-call-2",
        {},
        undefined,
        () => {
          throw new Error("UI listener exploded token=sk-ui-secret");
        },
        {},
      );
      assert.equal(res2.content[0]?.text, "ok:valid_progress");
      assert.equal(initializeCount, 1, "throwing onUpdate must not reconnect the HTTP server");

      await debugLog.flush();
      const logText = await readFile(join(logDir, "pi-mcp.log"), "utf8");
      assert.ok(
        logText.includes('"event":"server.notification_error"'),
        `expected server.notification_error in debug log, got: ${logText}`,
      );
      assert.ok(!logText.includes('"event":"server.stream_error"'));
      assert.ok(!logText.includes("sk-secret-value"));
      assert.ok(!logText.includes("sk-ui-secret"));
    } finally {
      setDebugLog(null);
      await manager.shutdownAll();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await rm(logDir, { recursive: true, force: true });
    }
  });
});
