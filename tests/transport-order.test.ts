/**
 * Direct unit tests for src/transport-order.ts (#307):
 * - `isJsonRpcNotificationMessage` classification across notifications, requests, responses, and malformed inputs
 * - `instrumentTransportMessageOrder` on lightweight fake `Transport` instances (reference identity, synchronous
 *   fast path, multi-wave FIFO ordering, re-entrant dispatch ordering, `onclose` & concurrent `close()` deduplication,
 *   handler replacement/clearing, and deferred handler / `onerror` error isolation)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { DebugLog, getDebugLog, isUiActive, setDebugLog, setDiagnosticUi } from "../src/debug-log.js";
import {
  instrumentTransportMessageOrder,
  isJsonRpcNotificationMessage,
} from "../src/transport-order.js";

class FakeTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  closeCalls = 0;
  private readonly closeDelayMicrotasks: number;

  constructor(closeDelayMicrotasks = 0) {
    this.closeDelayMicrotasks = closeDelayMicrotasks;
  }

  async start(): Promise<void> {}

  async send(_message: JSONRPCMessage): Promise<void> {}

  async close(): Promise<void> {
    this.closeCalls += 1;
    for (let i = 0; i < this.closeDelayMicrotasks; i += 1) {
      await Promise.resolve();
    }
    this.onclose?.();
  }
}

function notif(tag: string): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    method: `notifications/${tag}`,
  };
}

function resp(id: number): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    result: { ok: true },
  };
}

describe("transport-order", () => {
  describe("isJsonRpcNotificationMessage", () => {
    it("identifies JSON-RPC notifications (string method without an id property)", () => {
      assert.equal(isJsonRpcNotificationMessage(notif("progress")), true);
      assert.equal(isJsonRpcNotificationMessage({ method: "notifications/initialized" }), true);

      assert.equal(
        isJsonRpcNotificationMessage({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
        false,
      );
      assert.equal(
        isJsonRpcNotificationMessage({ jsonrpc: "2.0", id: null, method: "tools/call" }),
        false,
      );
      assert.equal(
        isJsonRpcNotificationMessage({ jsonrpc: "2.0", id: undefined, method: "tools/call" }),
        false,
      );
      assert.equal(isJsonRpcNotificationMessage(resp(1)), false);
      assert.equal(isJsonRpcNotificationMessage({ method: 123 }), false);
      assert.equal(isJsonRpcNotificationMessage({}), false);
      assert.equal(isJsonRpcNotificationMessage(null), false);
      assert.equal(isJsonRpcNotificationMessage(undefined), false);
      assert.equal(isJsonRpcNotificationMessage("notifications/progress"), false);
      assert.equal(isJsonRpcNotificationMessage([]), false);
    });
  });

  describe("instrumentTransportMessageOrder", () => {
    it("mutates in place, preserves reference identity, and keeps notification-free turns synchronous", () => {
      const raw = new FakeTransport();
      const instrumented = instrumentTransportMessageOrder("fake-srv", raw);
      assert.equal(instrumented, raw);

      const events: string[] = [];
      instrumented.onmessage = (msg) => {
        events.push(`msg:${"id" in msg ? String(msg.id) : "unknown"}`);
      };
      instrumented.onclose = () => {
        events.push("close");
      };

      // Self-assigning the already-wrapped getter must be a no-op.
      const wrappedMsg = instrumented.onmessage;
      instrumented.onmessage = wrappedMsg;
      assert.equal(instrumented.onmessage, wrappedMsg);

      instrumented.onmessage?.(resp(1));
      assert.deepEqual(events, ["msg:1"], "response must run synchronously when queue is idle");

      instrumented.onclose?.();
      instrumented.onclose?.();
      assert.deepEqual(
        events,
        ["msg:1", "close"],
        "idle onclose must run synchronously and deduplicate repeat calls",
      );
    });

    it("preserves FIFO wire order across [notif1, resp1, notif2, resp2, close] in one synchronous batch", async () => {
      const transport = instrumentTransportMessageOrder("fake-srv", new FakeTransport());
      const trace: string[] = [];

      transport.onmessage = (msg) => {
        if ("method" in msg && !("id" in msg)) {
          // Simulate Protocol._onnotification's internal Promise.resolve().then(...)
          void Promise.resolve().then(() => {
            trace.push(`notif:${msg.method}`);
          });
          return;
        }
        if ("id" in msg) {
          trace.push(`resp:${String(msg.id)}`);
        }
      };
      transport.onclose = () => {
        trace.push("close");
      };

      transport.onmessage?.(notif("n1"));
      transport.onmessage?.(resp(1));
      transport.onmessage?.(notif("n2"));
      transport.onmessage?.(resp(2));
      transport.onclose?.();

      await transport.close();

      assert.deepEqual(trace, [
        "notif:notifications/n1",
        "resp:1",
        "notif:notifications/n2",
        "resp:2",
        "close",
      ]);
      assert.equal(transport.closeCalls, 1);
    });

    it("queues re-entrant onmessage and onclose fired synchronously inside a notification handler", async () => {
      const transport = instrumentTransportMessageOrder("fake-srv", new FakeTransport());
      const trace: string[] = [];

      transport.onmessage = (msg) => {
        if ("method" in msg && msg.method === "notifications/outer") {
          void Promise.resolve().then(() => {
            trace.push("outer:settled");
          });
          transport.onmessage?.(resp(99));
          transport.onclose?.();
          return;
        }
        if ("id" in msg) {
          trace.push(`resp:${String(msg.id)}`);
        }
      };
      transport.onclose = () => {
        trace.push("close");
      };

      transport.onmessage?.(notif("outer"));
      await transport.close();

      assert.deepEqual(trace, ["outer:settled", "resp:99", "close"]);
    });

    it("memoizes concurrent close() calls, drains queued steps, and supports handler replacement/clearing", async () => {
      const transport = instrumentTransportMessageOrder("fake-srv", new FakeTransport(1));
      const trace: string[] = [];

      const rawMsg = (msg: JSONRPCMessage) => {
        if ("method" in msg && !("id" in msg)) {
          void Promise.resolve().then(() => {
            trace.push(`notif:${msg.method}`);
          });
          return;
        }
        if ("id" in msg) {
          trace.push(`resp:${String(msg.id)}`);
        }
      };
      transport.onmessage = rawMsg;
      const supersededMsg = transport.onmessage;

      transport.onclose = () => {
        trace.push("close-v1");
      };
      const supersededClose = transport.onclose;

      // Replace handlers: superseded references fall through directly without queueing/latching.
      transport.onmessage = undefined;
      assert.equal(transport.onmessage, undefined);
      transport.onmessage = rawMsg;

      transport.onclose = undefined;
      assert.equal(transport.onclose, undefined);
      transport.onclose = () => {
        trace.push("close-v2");
      };

      supersededMsg(resp(7));
      supersededClose();
      assert.deepEqual(trace, ["resp:7", "close-v1"]);

      transport.onmessage?.(notif("n1"));
      transport.onmessage?.(resp(8));

      const [c1, c2] = await Promise.all([transport.close(), transport.close()]);
      assert.equal(c1, undefined);
      assert.equal(c2, undefined);
      assert.equal(transport.closeCalls, 1);
      assert.deepEqual(trace, ["resp:7", "close-v1", "notif:notifications/n1", "resp:8", "close-v2"]);
    });

    it("isolates deferred handler throws (including null-prototype values) and throwing transport.onerror", async () => {
      const transport = instrumentTransportMessageOrder("fake-srv", new FakeTransport());
      const reportedErrors: string[] = [];
      const trace: string[] = [];

      const lines: string[] = [];
      const prevLogger = getDebugLog();
      const prevUiActive = isUiActive();
      const logger = new DebugLog("/virtual/logs/pi-mcp.log", {
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        fs: {
          mkdir: async () => undefined,
          appendFile: async (_filePath, data) => {
            lines.push(data);
          },
          stat: async () => ({ size: 0 }),
          rename: async () => undefined,
          chmod: async () => undefined,
        },
      });
      setDebugLog(logger);
      setDiagnosticUi({ notify: () => {} }, true);

      try {
        let throwFromOnError = false;
        transport.onerror = (err) => {
          reportedErrors.push(err.message);
          if (throwFromOnError) {
            throw new TypeError("onerror listener exploded");
          }
        };

        transport.onmessage = (msg) => {
          if ("method" in msg && !("id" in msg)) {
            void Promise.resolve().then(() => {
              trace.push(`notif:${msg.method}`);
            });
            return;
          }
          if ("id" in msg) {
            if (msg.id === 1) {
              throw new RangeError("deferred response boom");
            }
            if (msg.id === 2) {
              const unstringifiable: unknown = Object.create(null);
              throw unstringifiable;
            }
            trace.push(`resp:${String(msg.id)}`);
          }
        };

        throwFromOnError = true;
        transport.onmessage?.(notif("n1"));
        transport.onmessage?.(resp(1));
        transport.onmessage?.(resp(2));
        transport.onmessage?.(resp(3));

        await transport.close();
        await logger.flush();

        // Next turn after a throwing deferred step must still work cleanly on the fast path!
        throwFromOnError = false;
        transport.onmessage?.(resp(4));

        assert.deepEqual(trace, ["notif:notifications/n1", "resp:3", "resp:4"]);
        assert.deepEqual(reportedErrors, [
          "deferred response boom",
          "[unstringifiable value thrown]",
        ]);
        assert.equal(lines.length, 2);
        const entry = JSON.parse(lines[0]!.trim()) as Record<string, unknown>;
        assert.equal(entry.event, "transport.onerror_error");
        assert.equal(entry.server, "fake-srv");
      } finally {
        setDebugLog(prevLogger);
        setDiagnosticUi(null, prevUiActive);
      }
    });
  });
});
