/**
 * Unit tests for the pure `client.onerror` classifier in src/connect-policy.ts.
 *
 * This is the routing decision that keeps a healthy SSE / Streamable HTTP session from being
 * torn down over protocol noise, so every branch of the policy gets one assertion.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyClientError,
  classifyConnectFailure,
  isNonRetryableStdioSpawnError,
} from "../src/connect-policy.js";

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

  it("classifies an SSE OAuth 403 insufficient_scope as an auth error", async () => {
    const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");
    assert.deepEqual(
      classifyClientError("sse", new UnauthorizedError("HTTP 403 insufficient_scope")),
      {
        kind: "recover",
        event: "server.auth_error",
        transport: "sse",
        reason: "SSE auth error, recovering",
      },
    );
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

  it("reads a plain-object rejection as String(...), like the pre-extraction branch", () => {
    assert.deepEqual(classifyClientError("sse", { code: -32000, message: "stream closed" }), {
      kind: "recover",
      event: "server.stream_error",
      transport: "sse",
      reason: "SSE stream error, reconnecting",
    });
    // A benign-looking message on a non-Error payload is NOT ignored: only an Error's own
    // `message` is inspected, so a real dropped stream can never be swallowed by object text.
    assert.deepEqual(classifyClientError("sse", { message: "unknown message ID: 1" }), {
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

describe("isNonRetryableStdioSpawnError and classifyConnectFailure (#335)", () => {
  const nonRetryableCodes = ["ENOENT", "EACCES", "ENOEXEC", "ENOTDIR", "EISDIR"] as const;

  for (const code of nonRetryableCodes) {
    it(`fast-fails stdio ${code} with the unwrapped ErrnoException`, () => {
      const err = Object.assign(new Error(`spawn missing ${code}`), { code });
      assert.equal(isNonRetryableStdioSpawnError("stdio", err), true);

      const action = classifyConnectFailure({
        error: err,
        aborted: false,
        corruptStateRecovered: false,
        hasAuth: false,
        transport: "stdio",
        retryCount: 0,
        maxRetries: 5,
        serverName: "broken",
      });
      assert.deepEqual(action, { kind: "fail", error: err });
      assert.equal(action.kind === "fail" && action.error, err);
    });

    it(`does not fast-fail ${code} on streamable-http or sse`, () => {
      const err = Object.assign(new Error(`error ${code}`), { code });
      for (const transport of ["streamable-http", "sse"] as const) {
        assert.equal(isNonRetryableStdioSpawnError(transport, err), false);
        assert.deepEqual(
          classifyConnectFailure({
            error: err,
            aborted: false,
            corruptStateRecovered: false,
            hasAuth: false,
            transport,
            retryCount: 0,
            maxRetries: 1,
            serverName: "remote",
          }),
          { kind: "retry", delayMs: 1000 },
        );
      }
    });
  }

  it("keeps transient stdio errors and HTTP 404 retryable", () => {
    for (const code of ["EPIPE", "ECONNRESET", "EAGAIN"]) {
      const err = Object.assign(new Error(`spawn ${code}`), { code });
      assert.equal(isNonRetryableStdioSpawnError("stdio", err), false);
      assert.deepEqual(
        classifyConnectFailure({
          error: err,
          aborted: false,
          corruptStateRecovered: false,
          hasAuth: false,
          transport: "stdio",
          retryCount: 0,
          maxRetries: 1,
        }),
        { kind: "retry", delayMs: 1000 },
      );
    }

    for (const transport of ["streamable-http", "sse"] as const) {
      const http404 = Object.assign(new Error("HTTP 404 Not Found"), { status: 404 });
      assert.deepEqual(
        classifyConnectFailure({
          error: http404,
          aborted: false,
          corruptStateRecovered: false,
          hasAuth: false,
          transport,
          retryCount: 0,
          maxRetries: 1,
        }),
        { kind: "retry", delayMs: 1000 },
      );
    }
  });

  it("keeps aborted cancellation ahead of stdio spawn errors and handles non-Error objects", () => {
    const enoent = Object.assign(new Error("spawn missing ENOENT"), { code: "ENOENT" });
    assert.deepEqual(
      classifyConnectFailure({
        error: enoent,
        aborted: true,
        corruptStateRecovered: false,
        hasAuth: false,
        transport: "stdio",
        retryCount: 0,
        maxRetries: 5,
      }),
      { kind: "cancelled" },
    );

    assert.equal(isNonRetryableStdioSpawnError("stdio", null), false);
    assert.equal(isNonRetryableStdioSpawnError("stdio", "ENOENT"), false);
    assert.equal(isNonRetryableStdioSpawnError("stdio", { code: "ENOENT" }), true);

    const plainAction = classifyConnectFailure({
      error: { code: "ENOENT", message: "missing" },
      aborted: false,
      corruptStateRecovered: false,
      hasAuth: false,
      transport: "stdio",
      retryCount: 0,
      maxRetries: 5,
    });
    assert.equal(plainAction.kind, "fail");
    assert.ok(plainAction.kind === "fail" && plainAction.error instanceof Error);
  });
});
