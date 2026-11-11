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

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER_PATH = join(__dirname, "mock-server.ts");

// WHY: every step of the mock tool is slower than this on its own, so a call can only finish if
// each progress notification restarts the SDK's inactivity timer (`resetTimeoutOnProgress`).
const REQUEST_TIMEOUT_MS = 400;

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
    settings: { toolPrefix: "mcp", requestTimeoutMs: REQUEST_TIMEOUT_MS, maxRetries: 0 },
    mcpServers: {
      test: {
        command: "node",
        args: ["--import", "tsx/esm", MOCK_SERVER_PATH],
        transport: "stdio",
        lifecycle: "lazy",
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        env: { MOCK_PROGRESS: "1" },
      },
    },
  };
}

describe("MCP notifications/progress over stdio (#254)", () => {
  let manager: ServerManager;
  let tools: RegisteredTool[];
  let progressTool: RegisteredTool;

  before(async () => {
    const mockPi = makeMockPi();
    tools = mockPi.tools;
    const bridge = new ToolBridge(makeConfig().settings, mockPi.api);
    manager = new ServerManager(makeConfig());
    manager.setToolRefreshCallback(async (name, client, options) => {
      await bridge.refreshTools(name, client, options);
    });
    await manager.startServer("test", process.cwd());
    const tool = tools.find((t) => t.name.includes("report_progress"));
    assert.ok(tool, `mock server must expose report_progress, registered: ${tools.map((t) => t.name).join(", ")}`);
    progressTool = tool;
  });

  after(async () => {
    await manager.shutdownAll();
  });

  it("keeps an actively reporting tool alive past the request timeout", async () => {
    const updates: string[] = [];
    // 4 × 200ms = 800ms of work against a 400ms request timeout.
    const result = await progressTool.execute(
      "call-live",
      { steps: 4, stepMs: 200 },
      undefined,
      (update) => {
        updates.push(update.content[0]?.text ?? "");
      },
      {},
    );

    assert.equal(result.content[0]?.text, "Completed 4 steps");
    assert.deepEqual(updates, ["Progress 1/4", "Progress 2/4", "Progress 3/4", "Progress 4/4"]);
  });

  it("asks for progress even when Pi passes no onUpdate callback", async () => {
    const startedAt = Date.now();
    const result = await progressTool.execute(
      "call-headless",
      { steps: 4, stepMs: 200 },
      undefined,
      undefined,
      {},
    );

    assert.equal(result.content[0]?.text, "Completed 4 steps");
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
});
