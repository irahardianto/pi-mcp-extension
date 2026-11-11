/**
 * Unit tests for src/transport-factory.ts: pure stdio `cwd` resolution (Pi 1.3.0
 * `McpStdioServerConfig.cwd`: relative paths resolve against the session working directory,
 * a leading `~` expands to the home directory), and static-header handling for OAuth servers
 * (a configured `Authorization` header must never reach an OAuth transport).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createTransport, resolveStdioCwd } from "../src/transport-factory.js";
import { ServerConfigSchema } from "../src/config.js";
import { stripAuthorizationHeader } from "../src/auth-challenge.js";

describe("resolveStdioCwd", () => {
  it("keeps the session cwd when the server config has no cwd", () => {
    assert.equal(resolveStdioCwd(undefined, "/work/session"), "/work/session");
    assert.equal(resolveStdioCwd(undefined, undefined), undefined);
  });

  it("resolves a relative cwd against the session cwd", () => {
    assert.equal(resolveStdioCwd("./sub", "/work/session"), resolve("/work/session", "./sub"));
    assert.equal(resolveStdioCwd("../shared", "/work/session"), resolve("/work/session", "../shared"));
  });

  it("keeps an absolute cwd as given", () => {
    assert.equal(resolveStdioCwd("/opt/server", "/work/session"), resolve("/opt/server"));
  });

  it("expands a leading ~ to the home directory", () => {
    assert.equal(resolveStdioCwd("~", "/work/session"), homedir());
    assert.equal(resolveStdioCwd("~/mcp/state", "/work/session"), join(homedir(), "mcp/state"));
  });

  it("falls back to the process cwd when the session cwd is unknown", () => {
    assert.equal(resolveStdioCwd("./sub", undefined), resolve(process.cwd(), "./sub"));
  });
});

describe("stripAuthorizationHeader", () => {
  it("removes Authorization in any casing and keeps the other headers", () => {
    assert.deepEqual(
      stripAuthorizationHeader({ Authorization: "Bearer stale", "X-Tenant": "acme" }),
      { "X-Tenant": "acme" },
    );
    assert.deepEqual(stripAuthorizationHeader({ authorization: "Bearer stale" }), undefined);
    assert.deepEqual(stripAuthorizationHeader({ AuThOrIzAtIoN: "Bearer stale" }), undefined);
  });

  it("returns undefined for a missing or empty header set", () => {
    assert.equal(stripAuthorizationHeader(undefined), undefined);
    assert.equal(stripAuthorizationHeader({}), undefined);
  });
});

interface HeaderInspectingTransport {
  _commonHeaders: () => Promise<Headers>;
  _authProvider: { saveTokens: (tokens: { access_token: string; token_type: string }) => Promise<void> };
}

const OAUTH_ACCESS_TOKEN = "oauth-token-from-provider";
const OAUTH_BEARER = `Bearer ${OAUTH_ACCESS_TOKEN}`;
const STATIC_BEARER = "Bearer stale-static-header";

/**
 * Build a real SDK transport through `createTransport`, seed it with an OAuth access token, and
 * return the headers the SDK would actually send (`_commonHeaders()` is what every SDK HTTP
 * request path uses). `_commonHeaders()` is private API, so the cast is confined to this helper.
 */
async function sentHeaders(
  transport: "streamable-http" | "sse",
  headers: Record<string, string>,
  oauth: boolean,
): Promise<Headers> {
  const storageDir = await mkdtemp(join(tmpdir(), "pi-mcp-transport-headers-"));
  try {
    const config = ServerConfigSchema.parse({
      transport,
      url: "http://127.0.0.1:9999/mcp",
      headers,
      ...(oauth ? { auth: { type: "oauth" } } : {}),
    });
    const created = createTransport("srv", config, undefined, storageDir) as unknown as HeaderInspectingTransport;
    if (oauth) {
      await created._authProvider.saveTokens({ access_token: OAUTH_ACCESS_TOKEN, token_type: "Bearer" });
    }
    return await created._commonHeaders();
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
}

describe("createTransport stdio stderr wiring", () => {
  it("flushes a partial stderr line when the transport closes (#206)", async () => {
    const lines: string[] = [];
    const transport = createTransport(
      "srv",
      { transport: "stdio", command: process.execPath, args: [], lifecycle: "lazy" },
      (line) => lines.push(line),
    ) as unknown as { stderr: NodeJS.WritableStream | null; close(): Promise<void> };

    // A diagnostic with no trailing newline stays in the splitter until something flushes it;
    // the SDK never ends this PassThrough, so only the close-time flush can release it.
    transport.stderr?.write(Buffer.from("FATAL: Missing API_KEY", "utf8"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(lines, []);

    await transport.close();
    assert.deepEqual(lines, ["FATAL: Missing API_KEY"]);
  });
});

describe("createTransport with OAuth configured", () => {
  for (const transport of ["streamable-http", "sse"] as const) {
    it(`${transport}: a static Authorization header never replaces the OAuth bearer`, async () => {
      const sent = await sentHeaders(transport, { Authorization: STATIC_BEARER }, true);
      // The SDK spreads requestInit headers over the OAuth bearer, so an exact-case
      // Authorization key used to win outright and the access token was never sent.
      assert.equal(sent.get("authorization"), OAUTH_BEARER);
    });

    it(`${transport}: a static authorization header is not comma-joined with the OAuth bearer`, async () => {
      const sent = await sentHeaders(transport, { authorization: STATIC_BEARER }, true);
      // A lowercase key survived the spread as a second entry and `new Headers()` joined both
      // values into one malformed header.
      assert.equal(sent.get("authorization"), OAUTH_BEARER);
    });

    it(`${transport}: other static headers are still sent`, async () => {
      const sent = await sentHeaders(transport, { Authorization: STATIC_BEARER, "X-Tenant": "acme" }, true);
      assert.equal(sent.get("authorization"), OAUTH_BEARER);
      assert.equal(sent.get("x-tenant"), "acme");
    });

    it(`${transport}: a static Authorization header is untouched for header-auth servers`, async () => {
      const sent = await sentHeaders(transport, { Authorization: STATIC_BEARER }, false);
      assert.equal(sent.get("authorization"), STATIC_BEARER);
    });
  }
});

describe("createTransport batch message ordering (#300)", () => {
  it("delivers same-turn notifications/progress frames before resolving a coalesced tools/call response", async () => {
    const transport = createTransport("srv", {
      transport: "stdio",
      command: process.execPath,
      args: [],
      lifecycle: "lazy",
    });
    transport.start = async () => {};
    transport.close = async () => {};
    transport.send = async (message: JSONRPCMessage) => {
      if (!("method" in message) || !("id" in message)) return;
      if (message.method === "initialize") {
        transport.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "batch-srv", version: "1.0.0" },
          },
        });
        return;
      }
      if (message.method === "tools/call") {
        const progressToken = (
          message.params as { _meta?: { progressToken?: string | number } } | undefined
        )?._meta?.progressToken;
        // Simulate StdioClientTransport.processReadBuffer() or an SSE chunk delivering trailing
        // progress notifications and the JSON-RPC result synchronously in the same read loop.
        transport.onmessage?.({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: progressToken!, progress: 7, total: 8 },
        });
        transport.onmessage?.({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: progressToken!, progress: 8, total: 8 },
        });
        transport.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "Completed 8 steps" }] },
        });
      }
    };

    const clientErrors: Error[] = [];
    const client = new Client({ name: "test-client", version: "1.0.0" });
    client.onerror = (err) => clientErrors.push(err);
    await client.connect(transport);

    const seenProgress: number[] = [];
    const result = await client.callTool(
      { name: "report_progress", arguments: {} },
      undefined,
      {
        onprogress: ({ progress }) => {
          seenProgress.push(progress);
        },
        resetTimeoutOnProgress: true,
      },
    );

    assert.deepEqual(seenProgress, [7, 8]);
    assert.deepEqual(result.content, [{ type: "text", text: "Completed 8 steps" }]);
    assert.deepEqual(clientErrors, []);
    await client.close();
  });

  it("delivers a trailing notification before same-turn transport.onclose tears down handlers", async () => {
    const transport = createTransport("srv", {
      transport: "stdio",
      command: process.execPath,
      args: [],
      lifecycle: "lazy",
    });
    transport.start = async () => {};
    transport.close = async () => {};
    transport.send = async (message: JSONRPCMessage) => {
      if (!("method" in message) || !("id" in message)) return;
      if (message.method === "initialize") {
        transport.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "batch-srv", version: "1.0.0" },
          },
        });
        return;
      }
      if (message.method === "tools/call") {
        const progressToken = (
          message.params as { _meta?: { progressToken?: string | number } } | undefined
        )?._meta?.progressToken;
        transport.onmessage?.({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: progressToken!, progress: 1, total: 1 },
        });
        transport.onclose?.();
      }
    };

    const clientErrors: Error[] = [];
    const client = new Client({ name: "test-client", version: "1.0.0" });
    client.onerror = (err) => clientErrors.push(err);
    await client.connect(transport);

    const seenProgress: number[] = [];
    await assert.rejects(() =>
      client.callTool(
        { name: "report_progress", arguments: {} },
        undefined,
        {
          onprogress: ({ progress }) => {
            seenProgress.push(progress);
          },
        },
      ),
    );

    assert.deepEqual(seenProgress, [1]);
    assert.deepEqual(clientErrors, []);
  });

  it("keeps non-notification dispatch synchronous when no notification is in flight", () => {
    const transport = createTransport("srv", {
      transport: "stdio",
      command: process.execPath,
      args: [],
      lifecycle: "lazy",
    });
    const events: string[] = [];
    transport.onmessage = () => {
      events.push("message");
    };
    transport.onclose = () => {
      events.push("close");
    };

    transport.onmessage({ jsonrpc: "2.0", id: 1, result: {} });
    events.push("after-message");
    transport.onclose();
    events.push("after-close");

    assert.deepEqual(events, ["message", "after-message", "close", "after-close"]);
  });

  it("supports chained handlers, forwards deferred handler errors to onerror, and clears handlers", async () => {
    const transport = createTransport("srv", {
      transport: "stdio",
      command: process.execPath,
      args: [],
      lifecycle: "lazy",
    });
    const order: string[] = [];
    const errors: string[] = [];
    transport.onerror = (err) => errors.push(err.message);

    transport.onmessage = () => {
      order.push("inner-msg");
    };
    const prevMsg = transport.onmessage;
    transport.onmessage = (msg, extra) => {
      prevMsg?.(msg, extra);
      if ("id" in msg) {
        throw new Error("boom in deferred response");
      }
      order.push("outer-notif");
    };

    transport.onclose = () => {
      order.push("inner-close");
    };
    const prevClose = transport.onclose;
    transport.onclose = () => {
      prevClose?.();
      throw new Error("boom in deferred close");
    };

    transport.onmessage({ jsonrpc: "2.0", method: "notifications/progress", params: {} });
    transport.onmessage({ jsonrpc: "2.0", id: 2, result: {} });
    transport.onclose();

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["inner-msg", "outer-notif", "inner-msg", "inner-close"]);
    assert.deepEqual(errors, [
      "boom in deferred response",
      "boom in deferred close",
    ]);

    transport.onmessage = undefined;
    transport.onclose = undefined;
    assert.equal(transport.onmessage, undefined);
    assert.equal(transport.onclose, undefined);
  });

  it("preserves strict FIFO wire order across interleaved [notif1, resp1, notif2, resp2, close] batches at both raw and Protocol layers", async () => {
    const transport = createTransport("srv", {
      transport: "stdio",
      command: process.execPath,
      args: [],
      lifecycle: "lazy",
    });
    const rawEvents: string[] = [];
    transport.onmessage = (msg) => {
      if ("method" in msg && !("id" in msg)) {
        const step = (msg.params as { progress?: number } | undefined)?.progress;
        rawEvents.push(`raw:notif:${String(step)}`);
      } else if ("id" in msg && "result" in msg) {
        const res = msg.result as { content?: Array<{ text?: string }> };
        if (res.content) {
          rawEvents.push(`raw:resp:${res.content[0]?.text ?? ""}`);
        }
      }
    };
    transport.onclose = () => {
      rawEvents.push("raw:close");
    };

    const pendingCalls: Array<{ id: string | number; token: string | number }> = [];
    transport.start = async () => {};
    transport.close = async () => {};
    transport.send = async (message: JSONRPCMessage) => {
      if (!("method" in message) || !("id" in message)) return;
      if (message.method === "initialize") {
        transport.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "interleaved-srv", version: "1.0.0" },
          },
        });
        return;
      }
      if (message.method === "tools/call") {
        const token = (
          message.params as { _meta?: { progressToken?: string | number } } | undefined
        )?._meta?.progressToken;
        pendingCalls.push({ id: message.id, token: token! });
        if (pendingCalls.length === 2) {
          const [first, second] = pendingCalls;
          // Emit [notif1, resp1, notif2, resp2, close] synchronously in one read batch.
          transport.onmessage?.({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken: first!.token, progress: 1, total: 1 },
          });
          transport.onmessage?.({
            jsonrpc: "2.0",
            id: first!.id,
            result: { content: [{ type: "text", text: "done-1" }] },
          });
          transport.onmessage?.({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken: second!.token, progress: 2, total: 2 },
          });
          transport.onmessage?.({
            jsonrpc: "2.0",
            id: second!.id,
            result: { content: [{ type: "text", text: "done-2" }] },
          });
          transport.onclose?.();
        }
      }
    };

    const clientErrors: Error[] = [];
    const protocolEvents: string[] = [];
    let closed = false;
    const client = new Client({ name: "test-client", version: "1.0.0" });
    client.onerror = (err) => clientErrors.push(err);
    client.onclose = () => {
      closed = true;
    };
    await client.connect(transport);

    const [res1, res2] = await Promise.all([
      client
        .callTool({ name: "t1", arguments: {} }, undefined, {
          onprogress: ({ progress }) => protocolEvents.push(`proto:notif:${progress}`),
        })
        .then((r) => {
          const text = (r.content as Array<{ text: string }>)[0]!.text;
          protocolEvents.push(`proto:resp:${text}`);
          return text;
        }),
      client
        .callTool({ name: "t2", arguments: {} }, undefined, {
          onprogress: ({ progress }) => protocolEvents.push(`proto:notif:${progress}`),
        })
        .then((r) => {
          const text = (r.content as Array<{ text: string }>)[0]!.text;
          protocolEvents.push(`proto:resp:${text}`);
          return text;
        }),
    ]);

    // Both callTool promises resolved (rather than rejecting with ConnectionClosed), proving
    // Protocol._onresponse ran for both before Protocol._onclose cleared _responseHandlers.
    assert.equal(res1, "done-1");
    assert.equal(res2, "done-2");
    assert.equal(closed, true);
    assert.deepEqual(rawEvents, [
      "raw:notif:1",
      "raw:resp:done-1",
      "raw:notif:2",
      "raw:resp:done-2",
      "raw:close",
    ]);
    assert.deepEqual(protocolEvents, [
      "proto:notif:1",
      "proto:resp:done-1",
      "proto:notif:2",
      "proto:resp:done-2",
    ]);
    assert.deepEqual(clientErrors, []);
  });

  it("delivers coalesced SSE chunk notifications before the tools/call response over transport: sse", async () => {
    const { createServer } = await import("node:http");
    let sseStream: import("node:http").ServerResponse | undefined;
    const httpServer = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/sse") {
        sseStream = res;
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write("event: endpoint\ndata: /messages\n\n");
        return;
      }
      if (req.method === "POST" && req.url === "/messages") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            id?: number;
            method?: string;
            params?: { _meta?: { progressToken?: string | number } };
          };
          res.writeHead(202).end();
          if (msg.method === "initialize") {
            const initReply = JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "sse-batch", version: "1.0.0" },
              },
            });
            sseStream?.write(`data: ${initReply}\n\n`);
            return;
          }
          if (msg.method === "tools/call") {
            const progressToken = msg.params?._meta?.progressToken;
            const p1 = JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: { progressToken, progress: 1, total: 2 },
            });
            const p2 = JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: { progressToken, progress: 2, total: 2 },
            });
            const finalResult = JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { content: [{ type: "text", text: "ok:sse" }] },
            });
            // Single write -> single TCP read chunk decoded synchronously by EventSource._parser.feed().
            sseStream?.write(`data: ${p1}\n\ndata: ${p2}\n\ndata: ${finalResult}\n\n`);
          }
        });
      }
    });

    await new Promise<void>((resolveListen) => {
      httpServer.listen(0, "127.0.0.1", () => resolveListen());
    });
    const addr = httpServer.address();
    assert.ok(addr && typeof addr === "object");

    const transport = createTransport(
      "sse-srv",
      ServerConfigSchema.parse({
        transport: "sse",
        url: `http://127.0.0.1:${addr.port}/sse`,
        lifecycle: "lazy",
      }),
    );
    const clientErrors: Error[] = [];
    const client = new Client({ name: "sse-client", version: "1.0.0" });
    client.onerror = (err) => clientErrors.push(err);

    try {
      await client.connect(transport);
      const seenProgress: number[] = [];
      const result = await client.callTool(
        { name: "report_progress", arguments: {} },
        undefined,
        {
          onprogress: ({ progress }) => {
            seenProgress.push(progress);
          },
          resetTimeoutOnProgress: true,
        },
      );
      assert.deepEqual(seenProgress, [1, 2]);
      assert.deepEqual(result.content, [{ type: "text", text: "ok:sse" }]);
      assert.deepEqual(clientErrors, []);
    } finally {
      await client.close();
      sseStream?.end();
      await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
    }
  });

  it("drains queued notifications and deferred Protocol._onclose before resolving client.close()", async () => {
    const makeHttpTransport = () => {
      const t = createTransport(
        "http-srv",
        ServerConfigSchema.parse({
          transport: "streamable-http",
          url: "http://127.0.0.1:9999/mcp",
          lifecycle: "lazy",
        }),
      );
      t.start = async () => {};
      t.send = async (message: JSONRPCMessage) => {
        if ("method" in message && "id" in message && message.method === "initialize") {
          t.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "close-drain-srv", version: "1.0.0" },
            },
          });
        }
      };
      return t;
    };

    const transport = makeHttpTransport();
    const clientErrors: Error[] = [];
    let closedCount = 0;
    const client = new Client({ name: "close-drain-client", version: "1.0.0" });
    client.onerror = (err) => clientErrors.push(err);
    client.onclose = () => {
      closedCount += 1;
    };
    await client.connect(transport);

    const seenProgress: number[] = [];
    let callSettled = false;
    const inFlightCall = client
      .callTool({ name: "slow_tool", arguments: {} }, undefined, {
        onprogress: ({ progress }) => {
          seenProgress.push(progress);
        },
      })
      .catch((err: unknown) => {
        callSettled = true;
        return err;
      });

    // Request ID 1 is `tools/call` (0 was `initialize`). Emit two queued notifications and
    // immediately close the client in the same synchronous turn.
    transport.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: 1, progress: 1, total: 2 },
    });
    transport.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: 1, progress: 2, total: 2 },
    });

    await client.close();

    assert.deepEqual(seenProgress, [1, 2]);
    assert.equal(closedCount, 1);
    assert.equal(client.transport, undefined);
    assert.equal(callSettled, true);
    assert.deepEqual(clientErrors, []);
    await inFlightCall;

    // Because `Protocol._onclose()` completed before `client.close()` resolved, reconnecting
    // the same Client instance immediately succeeds instead of throwing "Already connected".
    const nextTransport = makeHttpTransport();
    await client.connect(nextTransport);
    await client.close();
  });

  it("isolates a throwing transport.onerror callback without wedging queued or subsequent messages", async () => {
    const transport = createTransport("srv", {
      transport: "stdio",
      command: process.execPath,
      args: [],
      lifecycle: "lazy",
    });

    const delivered: Array<number | string> = [];
    let onErrorCalls = 0;
    transport.onerror = () => {
      onErrorCalls += 1;
      throw new Error("onerror listener exploded");
    };
    transport.onmessage = (msg) => {
      if ("id" in msg && typeof msg.id === "number") {
        if (msg.id === 1) {
          throw new Error("deferred handler boom");
        }
        delivered.push(msg.id);
      }
    };
    transport.onclose = () => {
      delivered.push("closed");
    };

    // Self-reassigning the already-wrapped getter reference is a no-op (preserves wrapper identity).
    const activeOnMessage = transport.onmessage;
    const activeOnClose = transport.onclose;
    transport.onmessage = activeOnMessage;
    transport.onclose = activeOnClose;
    assert.equal(transport.onmessage, activeOnMessage);
    assert.equal(transport.onclose, activeOnClose);

    // Queue two deferred responses behind a notification; the first deferred response throws,
    // and `transport.onerror` throws as well.
    transport.onmessage({ jsonrpc: "2.0", method: "notifications/progress", params: {} });
    transport.onmessage({ jsonrpc: "2.0", id: 1, result: {} });
    transport.onmessage({ jsonrpc: "2.0", id: 2, result: {} });

    await new Promise((resolveSettle) => setImmediate(resolveSettle));
    assert.equal(onErrorCalls, 1);
    const expectedFirstBatch: Array<number | string> = [2];
    assert.deepEqual(delivered, expectedFirstBatch);

    // Subsequent turns must remain synchronous and unblocked (`tracker.tail === null`).
    transport.onmessage({ jsonrpc: "2.0", id: 3, result: {} });
    delivered.push("after-sync-3");
    transport.onclose();
    delivered.push("after-sync-close");
    assert.deepEqual(delivered, [2, 3, "after-sync-3", "closed", "after-sync-close"]);
  });

  it("orders re-entrant transport.onmessage batches and synchronous onclose triggered inside a message handler", async () => {
    // 1. Re-entrant `[notif, resp]` emitted synchronously from `transport.send()` while an outer
    // incoming server request is still on the `transport.onmessage` call stack.
    const reentrantTransport = createTransport("srv-reentrant", {
      transport: "stdio",
      command: process.execPath,
      args: [],
      lifecycle: "lazy",
    });
    let pendingToolCall: { id: string | number; token: string | number } | undefined;
    reentrantTransport.start = async () => {};
    reentrantTransport.close = async () => {};
    reentrantTransport.send = async (message: JSONRPCMessage) => {
      if ("method" in message && "id" in message) {
        if (message.method === "initialize") {
          reentrantTransport.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "reentrant-srv", version: "1.0.0" },
            },
          });
          return;
        }
        if (message.method === "tools/call") {
          const token = (
            message.params as { _meta?: { progressToken?: string | number } } | undefined
          )?._meta?.progressToken;
          pendingToolCall = { id: message.id, token: token! };
          // Trigger an unknown server-to-client request so `Protocol._onrequest` synchronously
          // calls `transport.send(MethodNotFound)` while `onmessage` is on the call stack.
          reentrantTransport.onmessage?.({
            jsonrpc: "2.0",
            id: 900,
            method: "custom/unhandled_request",
          });
        }
        return;
      }
      if ("error" in message && message.id === 900 && pendingToolCall) {
        const { id, token } = pendingToolCall;
        pendingToolCall = undefined;
        reentrantTransport.onmessage?.({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: token, progress: 1, total: 1 },
        });
        reentrantTransport.onmessage?.({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "ok:reentrant" }] },
        });
      }
    };

    const reentrantErrors: Error[] = [];
    const reentrantClient = new Client({ name: "reentrant-client", version: "1.0.0" });
    reentrantClient.onerror = (err) => reentrantErrors.push(err);
    await reentrantClient.connect(reentrantTransport);

    const reentrantProgress: number[] = [];
    const reentrantRes = await reentrantClient.callTool(
      { name: "t", arguments: {} },
      undefined,
      {
        onprogress: ({ progress }) => reentrantProgress.push(progress),
      },
    );
    assert.deepEqual(reentrantProgress, [1]);
    assert.deepEqual(reentrantRes.content, [{ type: "text", text: "ok:reentrant" }]);
    assert.deepEqual(reentrantErrors, []);
    await reentrantClient.close();

    // 2. Synchronous `transport.onclose()` invoked from a pre-hook while a notification is being
    // dispatched synchronously on the call stack.
    const hookTransport = createTransport("srv-hook", {
      transport: "stdio",
      command: process.execPath,
      args: [],
      lifecycle: "lazy",
    });
    hookTransport.onmessage = (msg) => {
      if ("method" in msg && msg.method === "notifications/progress") {
        hookTransport.onclose?.();
      }
    };
    hookTransport.start = async () => {};
    hookTransport.close = async () => {};
    hookTransport.send = async (message: JSONRPCMessage) => {
      if (!("method" in message) || !("id" in message)) return;
      if (message.method === "initialize") {
        hookTransport.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "hook-srv", version: "1.0.0" },
          },
        });
        return;
      }
      if (message.method === "tools/call") {
        const token = (
          message.params as { _meta?: { progressToken?: string | number } } | undefined
        )?._meta?.progressToken;
        hookTransport.onmessage?.({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: token!, progress: 1, total: 1 },
        });
      }
    };

    const hookErrors: Error[] = [];
    const hookClient = new Client({ name: "hook-client", version: "1.0.0" });
    hookClient.onerror = (err) => hookErrors.push(err);
    await hookClient.connect(hookTransport);

    const hookProgress: number[] = [];
    await assert.rejects(() =>
      hookClient.callTool(
        { name: "t", arguments: {} },
        undefined,
        {
          onprogress: ({ progress }) => hookProgress.push(progress),
        },
      ),
    );
    assert.deepEqual(hookProgress, [1]);
    assert.deepEqual(hookErrors, []);
  });

  it("coalesces duplicate close() and same-turn onclose + close() while a notification is in flight", async () => {
    const makeHttpTransport = () => {
      const t = createTransport(
        "http-srv",
        ServerConfigSchema.parse({
          transport: "streamable-http",
          url: "http://127.0.0.1:9999/mcp",
          lifecycle: "lazy",
        }),
      );
      t.start = async () => {};
      t.send = async (message: JSONRPCMessage) => {
        if ("method" in message && "id" in message && message.method === "initialize") {
          t.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "dedupe-close-srv", version: "1.0.0" },
            },
          });
        }
      };
      return t;
    };

    // 1. Concurrent `client.close()` calls (`Promise.all`) while a notification is in flight
    // (mirrors `Client.connect`'s `void this.close()` followed by `_cleanupFailedConnect`'s `await client.close()`).
    const t1 = makeHttpTransport();
    let closedCount1 = 0;
    const progress1: number[] = [];
    const client1 = new Client({ name: "c1", version: "1.0.0" });
    client1.onclose = () => {
      closedCount1 += 1;
    };
    await client1.connect(t1);
    const call1 = client1
      .callTool({ name: "slow", arguments: {} }, undefined, {
        onprogress: ({ progress }) => progress1.push(progress),
      })
      .catch((err: unknown) => err);

    t1.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: 1, progress: 1, total: 1 },
    });
    await Promise.all([client1.close(), client1.close()]);
    assert.deepEqual(progress1, [1]);
    assert.equal(closedCount1, 1);
    assert.equal(client1.transport, undefined);
    await call1;

    // 2. Underlying stream fires `transport.onclose()` right after a notification, and caller
    // calls `await client.close()` in the same turn before `Protocol._onclose()` clears `client.transport`.
    const t2 = makeHttpTransport();
    let closedCount2 = 0;
    const progress2: number[] = [];
    const client2 = new Client({ name: "c2", version: "1.0.0" });
    client2.onclose = () => {
      closedCount2 += 1;
    };
    await client2.connect(t2);
    const call2 = client2
      .callTool({ name: "slow", arguments: {} }, undefined, {
        onprogress: ({ progress }) => progress2.push(progress),
      })
      .catch((err: unknown) => err);

    t2.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: 1, progress: 1, total: 1 },
    });
    t2.onclose?.();
    await client2.close();
    assert.deepEqual(progress2, [1]);
    assert.equal(closedCount2, 1);
    assert.equal(client2.transport, undefined);
    await call2;
  });

  it("delivers single-write coalesced notifications and response from a real spawned stdio child process", async () => {
    const childScript = [
      'import { createInterface } from "node:readline";',
      'import { writeSync } from "node:fs";',
      "const rl = createInterface({ input: process.stdin });",
      'rl.on("line", (line) => {',
      "  const msg = JSON.parse(line);",
      '  if (msg.method === "initialize") {',
      '    writeSync(1, JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "stdio-coalesced", version: "1.0.0" } } }) + "\\n");',
      "    return;",
      "  }",
      '  if (msg.method === "tools/call") {',
      "    const progressToken = msg.params?._meta?.progressToken;",
      '    const p1 = JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: 1, total: 2 } });',
      '    const p2 = JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: 2, total: 2 } });',
      '    const res = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok:stdio-pipe" }] } });',
      '    writeSync(1, `${p1}\\n${p2}\\n${res}\\n`);',
      "  }",
      "});",
    ].join("\n");

    const transport = createTransport("stdio-coalesced", {
      transport: "stdio",
      command: process.execPath,
      args: ["--input-type=module", "-e", childScript],
      lifecycle: "lazy",
    });

    const clientErrors: Error[] = [];
    const client = new Client({ name: "stdio-client", version: "1.0.0" });
    client.onerror = (err) => clientErrors.push(err);
    await client.connect(transport);
    try {
      const seenProgress: number[] = [];
      const result = await client.callTool(
        { name: "burst", arguments: {} },
        undefined,
        {
          onprogress: ({ progress }) => seenProgress.push(progress),
          resetTimeoutOnProgress: true,
        },
      );
      assert.deepEqual(seenProgress, [1, 2]);
      assert.deepEqual(result.content, [{ type: "text", text: "ok:stdio-pipe" }]);
      assert.deepEqual(clientErrors, []);
    } finally {
      await client.close();
    }
  });
});
