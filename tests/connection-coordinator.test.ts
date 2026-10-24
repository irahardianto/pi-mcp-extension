import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConnectionCoordinator } from "../src/connection-coordinator.js";
import {
  formatErrorMessage,
  startupAuthNowOption,
  startupAuthLaterOption,
} from "../src/startup-auth.js";
import { McpError, AuthCancelledError } from "../src/errors.js";
import { AuthRequiredError } from "../src/oauth-provider.js";
import { createMockContext } from "./helpers/mock-extension.js";
import type { ServerManager, ManagedServer } from "../src/server-manager.js";
import type { ToolBridge } from "../src/tool-bridge.js";
import type { ServerConfig } from "../src/config.js";

function gate(): { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void } {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeManagerOptions {
  servers?: Record<string, { config: Partial<ServerConfig> & Pick<ServerConfig, "transport">; state?: "stopped" | "starting" | "ready" }>;
  onStartServer?: (name: string, cwd: string) => Promise<void>;
  onStopServer?: (name: string) => Promise<void>;
}

function makeFakeManager(options: FakeManagerOptions = {}): {
  manager: ServerManager;
  startCalls: Array<{ name: string; cwd: string }>;
  stopCalls: string[];
  shutdownAllCalled: boolean;
} {
  const servers = new Map<string, ManagedServer>();
  const initialServers = options.servers ?? {
    oauthSrv: { config: { transport: "sse", url: "https://example.com", auth: { type: "oauth", clientId: "test" } }, state: "stopped" },
    stdioSrv: { config: { transport: "stdio", command: "echo" }, state: "stopped" },
  };

  for (const [name, entry] of Object.entries(initialServers)) {
    servers.set(name, {
      name,
      config: {
        args: [],
        lifecycle: "lazy",
        ...entry.config,
      },
      state: entry.state ?? "stopped",
      retryCount: 0,
      retryTimer: null,
      client: null,
      transport: null,
      stderrLog: [],
      lastError: null,
    } as unknown as ManagedServer);
  }

  const startCalls: Array<{ name: string; cwd: string }> = [];
  const stopCalls: string[] = [];
  let shutdownAllCalled = false;

  const manager = {
    getServer: (name: string) => servers.get(name),
    getAllServers: () => Array.from(servers.values()),
    startServer: async (name: string, cwd: string) => {
      startCalls.push({ name, cwd });
      if (options.onStartServer) {
        await options.onStartServer(name, cwd);
      }
      const s = servers.get(name);
      if (s) (s as { state: string }).state = "ready";
    },
    stopServer: async (name: string) => {
      stopCalls.push(name);
      if (options.onStopServer) {
        await options.onStopServer(name);
      }
      const s = servers.get(name);
      if (s) (s as { state: string }).state = "stopped";
    },
    shutdownAll: async () => {
      shutdownAllCalled = true;
      if (options.onStopServer) {
        for (const name of servers.keys()) {
          await options.onStopServer(name);
        }
      }
      for (const s of servers.values()) {
        (s as { state: string }).state = "stopped";
      }
    },
    updateCwd: () => {},
  } as unknown as ServerManager;

  return { manager, startCalls, stopCalls, get shutdownAllCalled() { return shutdownAllCalled; } };
}

function makeFakeBridge(): {
  bridge: ToolBridge;
  deactivated: string[];
  removed: string[];
} {
  const deactivated: string[] = [];
  const removed: string[] = [];
  const bridge = {
    deactivateServer: (name: string) => { deactivated.push(name); },
    removeServer: (name: string) => { removed.push(name); },
  } as unknown as ToolBridge;
  return { bridge, deactivated, removed };
}

describe("ConnectionCoordinator direct unit tests", () => {
  it("an aborted attempt removes its connectAttempts entry and allows subsequent connects to succeed", async () => {
    let startPending = true;
    const startGate = gate();
    const fake = makeFakeManager({
      onStartServer: async () => {
        if (startPending) {
          await startGate.promise;
        }
      },
      onStopServer: async () => {
        startPending = false;
        startGate.resolve();
      },
    });
    const fakeBridge = makeFakeBridge();
    const coordinator = new ConnectionCoordinator({
      manager: fake.manager,
      bridge: fakeBridge.bridge,
      getConfig: () => ({ settings: { toolPrefix: "mcp", requestTimeoutMs: 1000, maxRetries: 0 }, mcpServers: {} }),
      authorize: async () => {},
      stopCallbackServer: async () => {},
    });

    const ctx = createMockContext();
    const abortController = new AbortController();

    const connectPromise = coordinator.connect("stdioSrv", ctx, { signal: abortController.signal });
    assert.equal(coordinator.hasConnectAttempt("stdioSrv"), true);
    assert.equal(coordinator.inFlightAttemptCount, 1);

    abortController.abort();
    await assert.rejects(connectPromise, AuthCancelledError);

    assert.equal(coordinator.hasConnectAttempt("stdioSrv"), false);
    assert.equal(coordinator.inFlightAttemptCount, 0);

    // Subsequent connect attempt can now proceed independently without being blocked
    await coordinator.connect("stdioSrv", ctx);
    assert.equal(coordinator.hasConnectAttempt("stdioSrv"), false);
    assert.equal(fake.manager.getServer("stdioSrv")?.state, "ready");
  });

  it("concurrent connect calls join the same in-flight attempt and all resolve", async () => {
    const startGate = gate();
    const fake = makeFakeManager({
      onStartServer: async () => {
        await startGate.promise;
      },
    });
    const fakeBridge = makeFakeBridge();
    const coordinator = new ConnectionCoordinator({
      manager: fake.manager,
      bridge: fakeBridge.bridge,
      getConfig: () => ({ settings: { toolPrefix: "mcp", requestTimeoutMs: 1000, maxRetries: 0 }, mcpServers: {} }),
      authorize: async () => {},
      stopCallbackServer: async () => {},
    });

    const ctx = createMockContext();
    const first = coordinator.connect("stdioSrv", ctx);
    const second = coordinator.connect("stdioSrv", ctx);

    assert.equal(coordinator.hasConnectAttempt("stdioSrv"), true);
    assert.equal(fake.startCalls.length, 1);

    startGate.resolve();
    await Promise.all([first, second]);

    assert.equal(coordinator.hasConnectAttempt("stdioSrv"), false);
    assert.equal(fake.startCalls.length, 1);
  });

  it("a reset connect supersedes an in-flight normal connect", async () => {
    const normalGate = gate();
    let authCalled = false;
    const fake = makeFakeManager({
      onStartServer: async (_name) => {
        if (!authCalled) {
          await normalGate.promise;
        }
      },
    });
    const fakeBridge = makeFakeBridge();
    const coordinator = new ConnectionCoordinator({
      manager: fake.manager,
      bridge: fakeBridge.bridge,
      getConfig: () => ({ settings: { toolPrefix: "mcp", requestTimeoutMs: 1000, maxRetries: 0 }, mcpServers: {} }),
      authorize: async () => {
        authCalled = true;
      },
      stopCallbackServer: async () => {},
    });

    const ctx = createMockContext({ hasUI: true });
    const normal = coordinator.connect("oauthSrv", ctx);
    assert.equal(coordinator.hasConnectAttempt("oauthSrv"), true);

    const reset = coordinator.connect("oauthSrv", ctx, { reset: true });
    const normalRejected = assert.rejects(normal, AuthCancelledError);

    normalGate.resolve();
    await reset;
    await normalRejected;

    assert.equal(authCalled, true);
    assert.equal(coordinator.hasConnectAttempt("oauthSrv"), false);
  });

  it("serializes interactive auth on authQueue and wakes up aborted waiter immediately", async () => {
    const auth1Entered = gate();
    const auth1Gate = gate();
    const authOrder: string[] = [];

    const fake = makeFakeManager({
      servers: {
        oauth1: { config: { transport: "sse", url: "https://1.example.com", auth: { type: "oauth", clientId: "c1" } }, state: "stopped" },
        oauth2: { config: { transport: "sse", url: "https://2.example.com", auth: { type: "oauth", clientId: "c2" } }, state: "stopped" },
        oauth3: { config: { transport: "sse", url: "https://3.example.com", auth: { type: "oauth", clientId: "c3" } }, state: "stopped" },
      },
      onStartServer: async (name) => {
        if (!authOrder.includes(name)) {
          throw new AuthRequiredError(name);
        }
      },
    });
    const fakeBridge = makeFakeBridge();

    const coordinator = new ConnectionCoordinator({
      manager: fake.manager,
      bridge: fakeBridge.bridge,
      getConfig: () => ({ settings: { toolPrefix: "mcp", requestTimeoutMs: 1000, maxRetries: 0 }, mcpServers: {} }),
      authorize: async (name) => {
        authOrder.push(name);
        if (name === "oauth1") {
          auth1Entered.resolve();
          await auth1Gate.promise;
        }
      },
      stopCallbackServer: async () => {},
    });

    const ctx = createMockContext({ hasUI: true });

    // oauth1 enters authorize and holds authQueue
    const conn1 = coordinator.connect("oauth1", ctx);
    await auth1Entered.promise;
    assert.deepEqual(authOrder, ["oauth1"]);

    // oauth2 waits in line on authQueue
    const abort2 = new AbortController();
    const conn2 = coordinator.connect("oauth2", ctx, { signal: abort2.signal });

    // oauth3 also waits behind oauth2
    let conn3Done = false;
    const conn3 = coordinator.connect("oauth3", ctx).then(() => {
      conn3Done = true;
    });

    // Aborting oauth2 must immediately reject conn2 with AuthCancelledError without waiting for oauth1
    abort2.abort();
    await assert.rejects(conn2, AuthCancelledError);
    assert.equal(conn3Done, false, "oauth3 should not have run while oauth1 is still holding the queue");
    assert.deepEqual(authOrder, ["oauth1"]);

    // Release oauth1
    auth1Gate.resolve();
    await Promise.all([conn1, conn3]);

    assert.equal(conn3Done, true);
    assert.deepEqual(authOrder, ["oauth1", "oauth3"], "oauth3 must execute after oauth1 released the queue while aborted oauth2 is skipped");
  });

  it("teardown aborts in-flight attempts, clears declined status, stops callback server, and shuts down servers", async () => {
    const startGate = gate();
    const fake = makeFakeManager({
      onStartServer: async () => {
        await startGate.promise;
      },
      onStopServer: async () => {
        startGate.resolve();
      },
    });
    const fakeBridge = makeFakeBridge();
    let callbackServerStopped = false;

    const coordinator = new ConnectionCoordinator({
      manager: fake.manager,
      bridge: fakeBridge.bridge,
      getConfig: () => ({ settings: { toolPrefix: "mcp", requestTimeoutMs: 1000, maxRetries: 0 }, mcpServers: {} }),
      authorize: async () => {},
      stopCallbackServer: async () => {
        callbackServerStopped = true;
      },
    });

    let statusText: string | undefined;
    const ctx = createMockContext({
      ui: {
        setStatus: (_id, text) => {
          statusText = text;
        },
      },
    });
    coordinator.setActiveContext(ctx);

    // Set a declined server status
    coordinator.markAuthRequired("oauthSrv", ctx);
    assert.equal(coordinator.isStartupAuthDeclined("oauthSrv"), true);
    assert.equal(statusText, "run /mcp:auth oauthSrv");

    // Start an in-flight connect
    const inFlight = coordinator.connect("stdioSrv", ctx);
    assert.equal(coordinator.hasConnectAttempt("stdioSrv"), true);

    // Teardown
    const teardownPromise = coordinator.teardown(ctx);
    startGate.resolve();
    await teardownPromise;

    await assert.rejects(inFlight, AuthCancelledError);
    assert.equal(coordinator.hasConnectAttempt("stdioSrv"), false);
    assert.equal(coordinator.isStartupAuthDeclined("oauthSrv"), false);
    assert.equal(statusText, undefined);
    assert.equal(callbackServerStopped, true);
    assert.equal(fake.shutdownAllCalled, true);
    assert.ok(fakeBridge.removed.includes("stdioSrv"));
    assert.ok(fakeBridge.removed.includes("oauthSrv"));
  });

  it("formats error messages and strips AuthRequiredError prefix in formatErrorMessage", () => {
    assert.equal(formatErrorMessage(new Error("simple error")), "simple error");
    assert.equal(formatErrorMessage(new McpError("custom message", "srv", "connection")), "[srv] custom message");
    assert.equal(formatErrorMessage(new Error("AuthRequiredError: please log in")), "please log in");
    assert.equal(startupAuthNowOption, "Authorize now");
    assert.equal(startupAuthLaterOption, "Not now");
  });
});
