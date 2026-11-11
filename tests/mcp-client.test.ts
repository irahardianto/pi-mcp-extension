/**
 * Unit tests for src/mcp-client.ts — the stateless MCP client/connect/ping adapter.
 *
 * Everything here runs on a fake clock and fake clients: no transport, no child process,
 * no HTTP server.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError as SdkMcpError } from "@modelcontextprotocol/sdk/types.js";
import {
  buildWorkspaceRoot,
  connectClientWithTimeout,
  createConnectRaceGuard,
  createMcpClient,
  formatServerLogNotification,
  pingClientWithTimeout,
  rethrowNormalizedConnectError,
  startHealthCheck,
} from "../src/mcp-client.js";
import { McpError, AuthCancelledError } from "../src/errors.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeClient(overrides: {
  connect?: (transport: Transport, options?: unknown) => Promise<void>;
  ping?: (...args: unknown[]) => Promise<unknown>;
}): Client {
  return {
    connect: overrides.connect ?? (async () => {}),
    ping: overrides.ping ?? (async () => ({})),
  } as unknown as Client;
}

function hangingConnect(): Promise<never> {
  return new Promise<never>(() => {
    // WHY: never settles — the point is that the race guard, not the transport, ends it.
  });
}

/** Let the promise continuations of a just-fired mocked timer run. */
async function flushMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) {
    await Promise.resolve();
  }
}

// ── Pure formatting ───────────────────────────────────────────────────────────

describe("buildWorkspaceRoot", () => {
  it("exposes the cwd as a file:// root named after its basename", () => {
    assert.deepEqual(buildWorkspaceRoot("/home/me/project"), {
      uri: pathToFileURL("/home/me/project").href,
      name: "project",
    });
  });

  it("keeps a filesystem root useful when basename is empty", () => {
    const root = buildWorkspaceRoot("/");
    assert.equal(root.uri, "file:///");
    assert.equal(root.name, basename("/") || "/");
  });
});

describe("formatServerLogNotification", () => {
  it("formats a string payload with the server name as default logger", () => {
    assert.deepEqual(formatServerLogNotification("srv", { level: "warning", data: "disk 90%" }), {
      safeLevel: "warning",
      safeLogger: "srv",
      formatted: "[warning] srv: disk 90%",
    });
  });

  it("defaults level to info and JSON-encodes non-string data", () => {
    const entry = formatServerLogNotification("srv", { data: { cache: "miss" } });
    assert.equal(entry.safeLevel, "info");
    assert.equal(entry.formatted, '[info] srv: {"cache":"miss"}');
  });

  it("treats a missing params object as an empty notification", () => {
    assert.deepEqual(formatServerLogNotification("srv", undefined), {
      safeLevel: "info",
      safeLogger: "srv",
      formatted: "[info] srv: ",
    });
  });

  it("strips ANSI/OSC escapes and control characters from every field (server-controlled text)", () => {
    const entry = formatServerLogNotification("srv", {
      level: "\u001b[31merror\u001b[0m",
      logger: "\u001b]0;spoof\u0007logger",
      data: "before\u001b[2J\u001b]8;;https://evil.example\u001b\\after\nnext",
    });
    assert.equal(entry.safeLevel, "error");
    assert.equal(entry.safeLogger, "logger");
    assert.equal(entry.formatted, "[error] logger: beforeafter next");
  });

  it("bounds the level and logger lengths", () => {
    const entry = formatServerLogNotification("srv", {
      level: "l".repeat(100),
      logger: "g".repeat(500),
      data: "x",
    });
    assert.equal(entry.safeLevel.length, 32);
    assert.equal(entry.safeLogger.length, 100);
  });
});

// ── Connect race guard ────────────────────────────────────────────────────────

describe("createConnectRaceGuard", () => {
  it("rejects with AuthCancelledError when the signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const guard = createConnectRaceGuard(1000, controller.signal, "srv");
    await assert.rejects(guard.outcome, AuthCancelledError);
    guard.dispose();
  });

  it("rejects with a timeout McpError when the deadline elapses", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const controller = new AbortController();
    const guard = createConnectRaceGuard(2500, controller.signal, "srv");
    const assertion = assert.rejects(guard.outcome, (err: unknown) => {
      assert.ok(err instanceof McpError);
      assert.equal(err.code, "timeout");
      assert.equal(err.message, "Connection timed out after 2500ms");
      return true;
    });
    t.mock.timers.tick(2499);
    t.mock.timers.tick(1);
    await assertion;
    guard.dispose();
  });

  it("rejects with AuthCancelledError when the signal aborts mid-wait", async () => {
    const controller = new AbortController();
    const guard = createConnectRaceGuard(60_000, controller.signal, "srv");
    controller.abort();
    await assert.rejects(guard.outcome, AuthCancelledError);
    guard.dispose();
  });

  it("dispose releases both the timer and the abort listener", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const controller = new AbortController();
    const guard = createConnectRaceGuard(1000, controller.signal, "srv");
    assert.equal(EventEmitter.getEventListeners(controller.signal, "abort").length, 1);

    guard.dispose();
    assert.equal(EventEmitter.getEventListeners(controller.signal, "abort").length, 0);

    // A disposed guard must never reject later (no unhandled rejection from the timer).
    t.mock.timers.tick(5000);
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});

// ── Connect with timeout ──────────────────────────────────────────────────────

describe("connectClientWithTimeout", () => {
  const transport = {} as Transport;

  it("refuses to start when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const client = fakeClient({
      connect: async () => {
        called = true;
      },
    });
    await assert.rejects(
      connectClientWithTimeout({
        client,
        transport,
        timeoutMs: 1000,
        signal: controller.signal,
        serverName: "srv",
      }),
      AuthCancelledError,
    );
    assert.equal(called, false);
  });

  it("bounds a connect that never settles with a timeout McpError", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const client = fakeClient({ connect: () => hangingConnect() });
    const promise = connectClientWithTimeout({
      client,
      transport,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      serverName: "srv",
    });
    const assertion = assert.rejects(promise, (err: unknown) => {
      assert.ok(err instanceof McpError);
      assert.equal(err.code, "timeout");
      assert.equal(err.message, "Connection timed out after 5000ms");
      return true;
    });
    t.mock.timers.tick(5000);
    await assertion;
  });

  it("normalizes the SDK's own request timeout into a timeout-coded McpError", async () => {
    const sdkTimeout = new SdkMcpError(ErrorCode.RequestTimeout, "Request timed out");
    const client = fakeClient({ connect: async () => Promise.reject(sdkTimeout) });
    await assert.rejects(
      connectClientWithTimeout({
        client,
        transport,
        timeoutMs: 4000,
        signal: new AbortController().signal,
        serverName: "srv",
      }),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.equal(err.code, "timeout");
        assert.equal(err.message, "Connection timed out after 4000ms");
        assert.equal(err.cause, sdkTimeout);
        return true;
      },
    );
  });

  it("passes an unrelated connect failure through untouched", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    const client = fakeClient({ connect: async () => Promise.reject(refused) });
    await assert.rejects(
      connectClientWithTimeout({
        client,
        transport,
        timeoutMs: 4000,
        signal: new AbortController().signal,
        serverName: "srv",
      }),
      (err: unknown) => {
        assert.equal(err, refused);
        return true;
      },
    );
  });

  it("reports a mid-flight abort as a cancellation and leaves no abort listener behind", async () => {
    const controller = new AbortController();
    const client = fakeClient({ connect: () => hangingConnect() });
    const promise = connectClientWithTimeout({
      client,
      transport,
      timeoutMs: 60_000,
      signal: controller.signal,
      serverName: "srv",
    });
    controller.abort();
    await assert.rejects(promise, AuthCancelledError);
    assert.equal(EventEmitter.getEventListeners(controller.signal, "abort").length, 0);
  });
});

describe("rethrowNormalizedConnectError", () => {
  it("keeps an existing AuthCancelledError instance", () => {
    const original = new AuthCancelledError("srv");
    assert.throws(
      () => rethrowNormalizedConnectError(original, new AbortController().signal, "srv", 10),
      (err: unknown) => err === original,
    );
  });

  it("converts any error on an aborted signal into AuthCancelledError", () => {
    const controller = new AbortController();
    controller.abort();
    assert.throws(
      () => rethrowNormalizedConnectError(new Error("Request timed out"), controller.signal, "srv", 10),
      AuthCancelledError,
    );
  });

  it("rethrows an unrelated error unchanged", () => {
    const original = new Error("boom");
    assert.throws(
      () => rethrowNormalizedConnectError(original, new AbortController().signal, "srv", 10),
      (err: unknown) => err === original,
    );
  });
});

// ── Ping ──────────────────────────────────────────────────────────────────────

describe("pingClientWithTimeout", () => {
  it("resolves when the server answers", async () => {
    const client = fakeClient({ ping: async () => ({}) });
    await pingClientWithTimeout({
      client,
      serverName: "srv",
      timeoutMs: 1000,
      signal: new AbortController().signal,
    });
  });

  it("rejects with a timeout McpError when the ping never answers", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const client = fakeClient({ ping: () => hangingConnect() });
    const promise = pingClientWithTimeout({
      client,
      serverName: "srv",
      timeoutMs: 750,
      signal: new AbortController().signal,
    });
    const assertion = assert.rejects(promise, (err: unknown) => {
      assert.ok(err instanceof McpError);
      assert.equal(err.code, "timeout");
      assert.equal(err.message, "Health check ping timed out after 750ms");
      return true;
    });
    t.mock.timers.tick(750);
    await assertion;
  });

  it("propagates a ping rejection untouched", async () => {
    const boom = new Error("ping exploded");
    const client = fakeClient({ ping: async () => Promise.reject(boom) });
    await assert.rejects(
      pingClientWithTimeout({
        client,
        serverName: "srv",
        timeoutMs: 1000,
        signal: new AbortController().signal,
      }),
      (err: unknown) => err === boom,
    );
  });
});

// ── Health-check scheduler ───────────────────────────────────────────────────

describe("startHealthCheck", () => {
  it("returns null when the server configures no interval", () => {
    const timer = startHealthCheck({
      serverName: "srv",
      getClient: () => fakeClient({}),
      isReady: () => true,
      intervalMs: 0,
      timeoutMs: 100,
      signal: new AbortController().signal,
      onPingFailure: () => {},
    });
    assert.equal(timer, null);
  });

  it("pings once per tick, never overlaps, and reports one bounded failure per ping", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    let pings = 0;
    const client = fakeClient({
      ping: () => {
        pings += 1;
        return hangingConnect();
      },
    });
    let failures = 0;
    const timer = startHealthCheck({
      serverName: "srv",
      getClient: () => client,
      isReady: () => true,
      intervalMs: 1000,
      timeoutMs: 500,
      signal: new AbortController().signal,
      onPingFailure: () => {
        failures += 1;
      },
    });
    assert.ok(timer);

    t.mock.timers.tick(1000);
    assert.equal(pings, 1);

    // The first ping is still in flight (its own deadline is 500ms away): no overlap.
    t.mock.timers.tick(400);
    assert.equal(pings, 1);
    assert.equal(failures, 0);

    // Deadline fires → exactly one failure report for the one in-flight ping.
    t.mock.timers.tick(200);
    await flushMicrotasks();
    assert.equal(failures, 1);

    // The next interval tick starts a fresh ping.
    t.mock.timers.tick(400);
    await flushMicrotasks();
    assert.equal(pings, 2);
    clearInterval(timer);
  });

  it("does not ping while the server is not ready", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    let pings = 0;
    const client = fakeClient({
      ping: async () => {
        pings += 1;
        return {};
      },
    });
    let ready = false;
    const timer = startHealthCheck({
      serverName: "srv",
      getClient: () => client,
      isReady: () => ready,
      intervalMs: 1000,
      timeoutMs: 500,
      signal: new AbortController().signal,
      onPingFailure: () => {},
    });
    assert.ok(timer);
    t.mock.timers.tick(3000);
    assert.equal(pings, 0);

    ready = true;
    t.mock.timers.tick(1000);
    assert.equal(pings, 1);
    clearInterval(timer);
  });

  it("suppresses the recovery callback when the ping failed on an aborted or non-ready server", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const controller = new AbortController();
    let failures = 0;
    const client = fakeClient({ ping: () => hangingConnect() });
    let ready = true;
    const timer = startHealthCheck({
      serverName: "srv",
      getClient: () => client,
      isReady: () => ready,
      intervalMs: 1000,
      timeoutMs: 500,
      signal: controller.signal,
      onPingFailure: () => {
        failures += 1;
      },
    });
    assert.ok(timer);

    t.mock.timers.tick(1000);
    // The server stopped while its ping was in flight: the failure is not a recovery trigger.
    ready = false;
    t.mock.timers.tick(500);
    await flushMicrotasks();
    assert.equal(failures, 0);

    ready = true;
    controller.abort();
    t.mock.timers.tick(5000);
    assert.equal(failures, 0);
    clearInterval(timer);
  });

  it("unrefs the interval so an idle server never keeps the process alive", () => {
    let unrefed = false;
    const handle = {
      unref: () => {
        unrefed = true;
        return handle;
      },
    } as unknown as ReturnType<typeof setInterval>;
    const timer = startHealthCheck(
      {
        serverName: "srv",
        getClient: () => fakeClient({}),
        isReady: () => true,
        intervalMs: 1000,
        timeoutMs: 100,
        signal: new AbortController().signal,
        onPingFailure: () => {},
      },
      { setInterval: (() => handle) as unknown as typeof setInterval },
    );
    assert.equal(timer, handle);
    assert.equal(unrefed, true);
  });
});

// ── Client construction ──────────────────────────────────────────────────────

interface HandlerMaps {
  _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
  _notificationHandlers: Map<string, (notification: unknown) => Promise<void>>;
}

describe("createMcpClient", () => {
  it("answers roots/list from the current cwd and advertises roots.listChanged", async () => {
    let cwd = "/tmp/workspace-alpha";
    const client = createMcpClient({
      serverName: "srv",
      getCwd: () => cwd,
      onToolsChanged: async () => {},
      onResourcesChanged: () => {},
      onLogLine: () => {},
    });
    const internals = client as unknown as HandlerMaps;
    const roots = internals._requestHandlers.get("roots/list");
    assert.ok(roots);

    assert.deepEqual(await roots({ method: "roots/list", jsonrpc: "2.0", id: 1 }, {}), {
      roots: [{ uri: pathToFileURL("/tmp/workspace-alpha").href, name: "workspace-alpha" }],
    });

    // The handler reads the cwd lazily, so a moved workspace root is answered with the new one.
    cwd = "/tmp/workspace-beta";
    assert.deepEqual(await roots({ method: "roots/list", jsonrpc: "2.0", id: 2 }, {}), {
      roots: [{ uri: pathToFileURL("/tmp/workspace-beta").href, name: "workspace-beta" }],
    });
  });

  it("forwards tools and resources list_changed notifications with its own client", async () => {
    const seen: Client[] = [];
    let resources = 0;
    const client = createMcpClient({
      serverName: "srv",
      getCwd: () => "/tmp",
      onToolsChanged: async (current) => {
        seen.push(current);
      },
      onResourcesChanged: (current) => {
        resources += 1;
        seen.push(current);
      },
      onLogLine: () => {},
    });
    const handlers = (client as unknown as HandlerMaps)._notificationHandlers;

    await handlers.get("notifications/tools/list_changed")?.({
      method: "notifications/tools/list_changed",
      jsonrpc: "2.0",
    });
    await handlers.get("notifications/resources/list_changed")?.({
      method: "notifications/resources/list_changed",
      jsonrpc: "2.0",
    });

    assert.equal(seen.length, 2);
    assert.equal(seen[0], client);
    assert.equal(seen[1], client);
    assert.equal(resources, 1);
  });

  it("formats notifications/message before handing it to the log sink", async () => {
    const lines: string[] = [];
    const client = createMcpClient({
      serverName: "srv",
      getCwd: () => "/tmp",
      onToolsChanged: async () => {},
      onResourcesChanged: () => {},
      onLogLine: (entry) => {
        lines.push(entry.formatted);
      },
    });
    const handlers = (client as unknown as HandlerMaps)._notificationHandlers;

    await handlers.get("notifications/message")?.({
      method: "notifications/message",
      jsonrpc: "2.0",
      params: { level: "error", logger: "db", data: "\u001b[31mconnection lost\u001b[0m" },
    });

    assert.deepEqual(lines, ["[error] db: connection lost"]);
  });
});
