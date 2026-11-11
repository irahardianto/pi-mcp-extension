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
});

