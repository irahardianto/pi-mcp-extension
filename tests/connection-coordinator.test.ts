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
  servers?: Record<
    string,
    {
      config: Partial<ServerConfig> & Pick<ServerConfig, "transport">;
      state?: "stopped" | "starting" | "ready";
      lastError?: unknown;
    }
  >;
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
      lastError: entry.lastError ?? null,
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
      const s = servers.get(name);
      try {
        if (options.onStartServer) {
          await options.onStartServer(name, cwd);
        }
      } catch (err) {
        // WHY: Mirror the real manager, which records the connect failure on lastError
        // before rejecting — hint-retention decisions read that field.
        if (s) (s as { lastError: unknown }).lastError = err;
        throw err;
      }
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

describe("ConnectionCoordinator auth hint synchronization (Issue 207)", () => {
  const oauthConfig: Partial<ServerConfig> & Pick<ServerConfig, "transport"> = {
    transport: "sse",
    url: "https://example.com",
    auth: { type: "oauth", clientId: "test" },
  };

  function setup(options: Omit<FakeManagerOptions, "servers"> = {}) {
    const fake = makeFakeManager({
      ...options,
      // WHY: A declined server is always a server whose last connect failed with
      // AuthRequiredError, so the fixture starts in exactly that recorded state.
      servers: { oauthSrv: { config: oauthConfig, state: "stopped", lastError: new AuthRequiredError("oauthSrv") } },
    });
    const fakeBridge = makeFakeBridge();
    const notifications: Array<{ msg: string; level: string | undefined }> = [];
    const statuses: Array<string | undefined> = [];
    const coordinator = new ConnectionCoordinator({
      manager: fake.manager,
      bridge: fakeBridge.bridge,
      getConfig: () => ({ settings: { toolPrefix: "mcp", requestTimeoutMs: 1000, maxRetries: 0 }, mcpServers: {} }),
      authorize: async () => {},
      stopCallbackServer: async () => {},
    });
    const ctx = createMockContext({
      hasUI: true,
      ui: {
        notify: (msg: string, level?: string) => notifications.push({ msg, level }),
        setStatus: (_key: string, text?: string) => statuses.push(text),
      },
    });
    coordinator.setActiveContext(ctx);
    const server = fake.manager.getServer("oauthSrv")!;
    return { coordinator, ctx, notifications, statuses, server };
  }

  it("reports a mid-session 401 by warning and painting the /mcp:auth footer hint", () => {
    const { coordinator, notifications, statuses } = setup();

    coordinator.handleRecoveryFailed("oauthSrv", new AuthRequiredError("oauthSrv"));

    assert.equal(coordinator.isStartupAuthDeclined("oauthSrv"), true);
    assert.equal(statuses.at(-1), "run /mcp:auth oauthSrv");
    assert.deepEqual(notifications, [
      {
        msg: "pi-mcp: oauthSrv requires re-authorization — run /mcp:auth oauthSrv",
        level: "warning",
      },
    ]);
  });

  it("keeps the hint while authorization is still required and clears it once the server is ready", () => {
    const { coordinator, ctx, statuses, server } = setup();

    coordinator.markAuthRequired("oauthSrv");
    assert.equal(statuses.at(-1), "run /mcp:auth oauthSrv");

    // A reconnect attempt is in flight: the outcome is unknown, so the hint stays.
    server.state = "starting";
    coordinator.syncStatus(ctx);
    assert.equal(statuses.at(-1), "run /mcp:auth oauthSrv");

    // A retry failed for a non-auth reason while the state machine is mid-attempt; the
    // decisive stopped/ready outcome has not been recorded yet.
    (server as { lastError: unknown }).lastError = new McpError("connect ECONNREFUSED", "oauthSrv", "connection");
    coordinator.syncStatus(ctx);
    assert.equal(statuses.at(-1), "run /mcp:auth oauthSrv");

    // Recovered by an eager start or background _recover(): nothing left to authorize.
    server.state = "ready";
    coordinator.syncStatus(ctx);
    assert.equal(statuses.at(-1), undefined);
    assert.equal(coordinator.isStartupAuthDeclined("oauthSrv"), false);
  });

  it("clears a stale hint once the same server fails with a non-auth error", () => {
    const { coordinator, notifications, statuses, server } = setup();

    coordinator.markAuthRequired("oauthSrv");
    assert.equal(statuses.at(-1), "run /mcp:auth oauthSrv");

    server.state = "stopped";
    (server as { lastError: unknown }).lastError = new McpError(
      "connect ECONNREFUSED 127.0.0.1:9",
      "oauthSrv",
      "connection",
    );
    coordinator.handleRecoveryFailed("oauthSrv", (server as { lastError: unknown }).lastError);

    assert.equal(statuses.at(-1), undefined, "authorization is no longer the problem");
    assert.equal(coordinator.isStartupAuthDeclined("oauthSrv"), false);
    assert.ok(
      notifications.some(
        (n) => n.msg === "pi-mcp: Lost connection to oauthSrv — [oauthSrv] connect ECONNREFUSED 127.0.0.1:9" && n.level === "error",
      ),
    );
    assert.equal(
      notifications.some((n) => n.msg.includes("requires re-authorization")),
      false,
    );
  });

  it("clears a stale hint when an eager start fails with a non-auth error and still reports the failure", async () => {
    const { coordinator, ctx, notifications, statuses } = setup({
      onStartServer: async () => {
        throw new McpError("connect ECONNREFUSED", "oauthSrv", "connection");
      },
    });

    coordinator.markAuthRequired("oauthSrv");
    assert.equal(statuses.at(-1), "run /mcp:auth oauthSrv");

    await coordinator.startEagerServers([["oauthSrv", oauthConfig as ServerConfig]], ctx);

    assert.equal(statuses.at(-1), undefined);
    assert.equal(coordinator.isStartupAuthDeclined("oauthSrv"), false);
    assert.ok(notifications.some((n) => n.msg === "pi-mcp: Failed to start oauthSrv — [oauthSrv] connect ECONNREFUSED"));
  });

  it("clears the hint when an eager start reconnects a previously declined server", async () => {
    const { coordinator, ctx, statuses } = setup();

    coordinator.markAuthRequired("oauthSrv");
    assert.equal(statuses.at(-1), "run /mcp:auth oauthSrv");

    await coordinator.startEagerServers([["oauthSrv", oauthConfig as ServerConfig]], ctx);

    assert.equal(statuses.at(-1), undefined);
    assert.equal(coordinator.isStartupAuthDeclined("oauthSrv"), false);
  });

  it("does not report a start failure when an eager start is cancelled by /mcp:stop", async () => {
    const { coordinator, ctx, notifications } = setup({
      onStartServer: async () => {
        throw new AuthCancelledError("oauthSrv");
      },
    });

    await coordinator.startEagerServers([["oauthSrv", oauthConfig as ServerConfig]], ctx);

    assert.deepEqual(notifications, [], "a cancelled start is not a failure");
  });

  it("clears a stale hint when an explicit reconnect fails with a non-auth error", async () => {
    const { coordinator, ctx, statuses } = setup({
      onStartServer: async () => {
        throw new McpError("connect ECONNREFUSED", "oauthSrv", "connection");
      },
    });

    coordinator.markAuthRequired("oauthSrv");
    await assert.rejects(
      coordinator.connect("oauthSrv", ctx),
      (err: unknown) => err instanceof McpError && err.code === "connection",
    );

    assert.equal(statuses.at(-1), undefined);
    assert.equal(coordinator.isStartupAuthDeclined("oauthSrv"), false);
  });

  it("clears a stale hint when the reconnect after a successful authorization fails for a non-auth reason", async () => {
    // First attempt: no credentials -> AuthRequiredError -> interactive authorization runs,
    // and the reconnect that follows it fails with ECONNREFUSED.
    let startAttempts = 0;
    const { coordinator, ctx, statuses } = setup({
      onStartServer: async () => {
        startAttempts++;
        throw startAttempts === 1
          ? new AuthRequiredError("oauthSrv")
          : new McpError("connect ECONNREFUSED", "oauthSrv", "connection");
      },
    });

    coordinator.markAuthRequired("oauthSrv");
    assert.equal(statuses.at(-1), "run /mcp:auth oauthSrv");

    await assert.rejects(
      coordinator.connect("oauthSrv", ctx),
      (err: unknown) => err instanceof McpError && err.code === "connection",
    );
    assert.equal(startAttempts, 2, "the reconnect after authorize() must have been attempted");

    assert.equal(statuses.at(-1), undefined, "a successful authorization must not leave the hint behind");
    assert.equal(coordinator.isStartupAuthDeclined("oauthSrv"), false);
  });
});
