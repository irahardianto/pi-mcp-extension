/**
 * Unit tests for the pure `client.onerror` classifier in src/connect-policy.ts.
 *
 * This is the routing decision that keeps a healthy SSE / Streamable HTTP session from being
 * torn down over protocol noise, so every branch of the policy gets one assertion.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyClientError } from "../src/connect-policy.js";

describe("classifyClientError — benign JSON-RPC noise", () => {
  const benignMessages = [
    "unknown message ID: 42",
    "Received a response for an unknown message ID: 7",
    "notifications/progress: unknown token",
    "Invalid message: unknown token abc",
  ];

  for (const message of benignMessages) {
    it(`ignores "${message}" on every transport`, () => {
      for (const transport of ["sse", "streamable-http", "stdio"] as const) {
        assert.deepEqual(classifyClientError(transport, new Error(message)), { kind: "ignore" });
      }
    });
  }

  it("keeps an info-level diagnostic for a throwing notification handler", () => {
    assert.deepEqual(
      classifyClientError("sse", new Error("Uncaught error in notification handler: total must be a number")),
      { kind: "ignore", diagnostic: "server.notification_error" },
    );
  });

  it("classifies a plain JSON-RPC race without the notification diagnostic", () => {
    const action = classifyClientError("streamable-http", new Error("unknown message ID: 12"));
    assert.equal(action.kind, "ignore");
    assert.equal("diagnostic" in action ? action.diagnostic : undefined, undefined);
  });
});

describe("classifyClientError — sse", () => {
  it("recovers from a dropped SSE stream", () => {
    assert.deepEqual(classifyClientError("sse", new Error("SSE stream disconnected")), {
      kind: "recover",
      event: "server.stream_error",
      transport: "sse",
      reason: "SSE stream error, reconnecting",
    });
  });
});

describe("classifyClientError — streamable-http", () => {
  it("recovers an OAuth 401 as an auth error", () => {
    const err = Object.assign(new Error("Streamable HTTP error"), { code: 401 });
    assert.deepEqual(classifyClientError("streamable-http", err), {
      kind: "recover",
      event: "server.auth_error",
      transport: "streamable-http",
      reason: "HTTP auth error, recovering",
    });
  });

  it("recovers a 403 insufficient_scope as an auth error", () => {
    const err = Object.assign(
      new Error("Streamable HTTP error: Server returned 403 after trying upscoping"),
      { code: 403 },
    );
    assert.deepEqual(classifyClientError("streamable-http", err), {
      kind: "recover",
      event: "server.auth_error",
      transport: "streamable-http",
      reason: "HTTP auth error, recovering",
    });
  });

  it("ignores the POST-only SSE probe answering with a non-405 status", () => {
    const action = classifyClientError(
      "streamable-http",
      new Error("Failed to open SSE stream: Not Found"),
    );
    assert.deepEqual(action, { kind: "ignore" });
  });

  it("recovers a genuine stream drop on an established stream", () => {
    assert.deepEqual(
      classifyClientError("streamable-http", new Error("Maximum reconnection attempts (0) exceeded.")),
      {
        kind: "recover",
        event: "server.stream_error",
        transport: "streamable-http",
        reason: "HTTP stream error, reconnecting",
      },
    );
  });

  it("still treats the SSE probe as ignorable when the probe text is wrapped", () => {
    const action = classifyClientError(
      "streamable-http",
      Object.assign(new Error("Failed to open SSE stream: 400 Bad Request"), { status: 400 }),
    );
    assert.deepEqual(action, { kind: "ignore" });
  });
});

describe("classifyClientError — stdio and odd payloads", () => {
  it("ignores stdio transport errors (a dead child is reported through onclose)", () => {
    assert.deepEqual(classifyClientError("stdio", new Error("write EPIPE")), { kind: "ignore" });
  });

  it("reads a plain-object rejection without losing its message", () => {
    assert.deepEqual(classifyClientError("sse", { code: -32000, message: "stream closed" }), {
      kind: "recover",
      event: "server.stream_error",
      transport: "sse",
      reason: "SSE stream error, reconnecting",
    });
  });

  it("handles a thrown non-Error value", () => {
    assert.deepEqual(classifyClientError("streamable-http", "stream closed"), {
      kind: "recover",
      event: "server.stream_error",
      transport: "streamable-http",
      reason: "HTTP stream error, reconnecting",
    });
  });
});
