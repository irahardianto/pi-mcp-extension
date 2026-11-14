/**
 * Focused deterministic unit tests for `src/tool-execution.ts` and
 * `discoverServerTools` in `src/tool-discovery.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError as SdkMcpError } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { AuthCancelledError, McpError } from "../src/errors.js";
import { discoverServerTools, type McpToolDefinition } from "../src/tool-discovery.js";
import {
  callToolWithClient,
  createPiToolDefinition,
  createProgressReporter,
  executeMcpToolCall,
  formatProgressText,
  rethrowToolCallError,
  type CreatePiToolDefinitionOptions,
} from "../src/tool-execution.js";

const dummyCtx = {} as ExtensionToolContext;

describe("tool-execution: formatProgressText and createProgressReporter", () => {
  it("sanitizes ANSI escapes before redacting secrets, trims whitespace, and caps output to 200 chars", () => {
    const fakeCred = "fake-progress-cred-value";
    const rendered = formatProgressText({
      progress: 1,
      total: 4,
      message: `  \u001b[1mpassword\u001b[0m=${fakeCred} ${"x".repeat(240)}  \n`,
    });
    assert.ok(!rendered.includes(fakeCred), "credential value must be redacted");
    assert.ok(rendered.startsWith("password=[REDACTED] "), `unexpected prefix: ${rendered}`);
    assert.ok([...rendered].length <= 200, `expected <= 200 code points, got ${[...rendered].length}`);
  });

  it("falls back to numeric Progress lines when message is absent, blank, or non-finite", () => {
    assert.equal(formatProgressText({ progress: 3, total: 10 }), "Progress 3/10");
    assert.equal(formatProgressText({ progress: 5, message: "   \n\t  " }), "Progress 5");
    assert.equal(
      formatProgressText({ progress: Number.NaN, total: Number.POSITIVE_INFINITY }),
      "Progress ?",
    );
    assert.equal(formatProgressText({ progress: Number.NaN, total: 8 }), "Progress ?/8");
  });

  it("handles undefined onUpdate as a safe no-op and deduplicates consecutive identical progress lines", () => {
    const noopReporter = createProgressReporter(undefined);
    assert.doesNotThrow(() => noopReporter({ progress: 1, total: 2, message: "tick" }));

    const updates: string[] = [];
    const reporter = createProgressReporter((update) => {
      const block = update.content[0];
      if (block?.type === "text") updates.push(block.text);
    });

    reporter({ progress: 1, total: 3, message: "step one" });
    reporter({ progress: 2, total: 3, message: "step one\n" }); // trims to identical text
    reporter({ progress: 2, total: 3, message: "step two" });
    reporter({ progress: 3, total: 3, message: "step one" }); // non-consecutive repeat is emitted

    assert.deepEqual(updates, ["step one", "step two", "step one"]);
  });
});

describe("tool-execution: callToolWithClient", () => {
  it("uses typed client.callTool when available and forwards timeout, progress reset, and optional signal", async () => {
    let capturedArgs: unknown;
    let capturedOptions: Record<string, unknown> | undefined;
    const client = {
      callTool: async (
        args: unknown,
        _schema: unknown,
        options: Record<string, unknown>,
      ) => {
        capturedArgs = args;
        capturedOptions = options;
        return { content: [{ type: "text", text: "typed-ok" }] };
      },
    } as unknown as Client;

    const ac = new AbortController();
    const resWithSignal = await callToolWithClient(client, "ping_tool", { a: 1 }, 4500, {
      signal: ac.signal,
    });
    assert.deepEqual(resWithSignal, { content: [{ type: "text", text: "typed-ok" }] });
    assert.deepEqual(capturedArgs, { name: "ping_tool", arguments: { a: 1 } });
    assert.equal(capturedOptions?.["timeout"], 4500);
    assert.equal(capturedOptions?.["resetTimeoutOnProgress"], true);
    assert.equal(typeof capturedOptions?.["onprogress"], "function");
    assert.equal(capturedOptions?.["signal"], ac.signal);

    await callToolWithClient(client, "ping_tool", {}, 1200, {});
    assert.equal("signal" in (capturedOptions ?? {}), false);
  });

  it("falls back to raw client.request('tools/call') when client.callTool is not a function", async () => {
    let capturedRequest: unknown;
    const rawClient = {
      request: async (req: unknown) => {
        capturedRequest = req;
        return { content: [{ type: "text", text: "raw-ok" }] };
      },
    } as unknown as Client;

    const res = await callToolWithClient(rawClient, "legacy_tool", { q: "hi" }, 3000, {});
    assert.deepEqual(res, { content: [{ type: "text", text: "raw-ok" }] });
    assert.deepEqual(capturedRequest, {
      method: "tools/call",
      params: { name: "legacy_tool", arguments: { q: "hi" } },
    });
  });
});

describe("tool-execution: rethrowToolCallError and executeMcpToolCall", () => {
  it("preserves existing McpError instances, notifies onAuthError on 401, and classifies timeout vs protocol", async () => {
    const existing = new McpError("already classified", "srv", "tool");
    await assert.rejects(
      () => rethrowToolCallError("srv", existing),
      (err: unknown) => err === existing,
    );

    const authCalls: Array<{ server: string; err: unknown }> = [];
    const unauth = new UnauthorizedError("token expired");
    await assert.rejects(
      () =>
        rethrowToolCallError("oauth-srv", unauth, async (server, err) => {
          await Promise.resolve();
          authCalls.push({ server, err });
        }),
      (err: unknown) =>
        err instanceof McpError &&
        err.server === "oauth-srv" &&
        err.code === "protocol" &&
        err.cause === unauth,
    );
    assert.equal(authCalls.length, 1);
    assert.equal(authCalls[0]?.server, "oauth-srv");

    const sdkTimeout = new SdkMcpError(ErrorCode.RequestTimeout, "Request timed out");
    await assert.rejects(
      () => rethrowToolCallError("slow-srv", sdkTimeout),
      (err: unknown) =>
        err instanceof McpError && err.server === "slow-srv" && err.code === "timeout",
    );

    await assert.rejects(
      () => rethrowToolCallError("raw-srv", "plain string failure"),
      (err: unknown) =>
        err instanceof McpError &&
        err.code === "protocol" &&
        err.message === "plain string failure",
    );
  });

  it("handles pre-aborted signals, mid-call aborts, tool isError outcomes, and successful content conversion", async () => {
    let called = false;
    const neverClient = {
      callTool: async () => {
        called = true;
        return { content: [] };
      },
    } as unknown as Client;

    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(
      () =>
        executeMcpToolCall({
          serverName: "srv",
          toolName: "echo",
          client: neverClient,
          params: {},
          timeoutMs: 1000,
          signal: preAborted.signal,
        }),
      (err: unknown) =>
        err instanceof McpError &&
        err.code === "protocol" &&
        err.message === "Tool execution cancelled",
    );
    assert.equal(called, false);

    const midCallController = new AbortController();
    const abortingClient = {
      callTool: async () => {
        midCallController.abort();
        throw new SdkMcpError(ErrorCode.RequestTimeout, "aborted request");
      },
    } as unknown as Client;
    await assert.rejects(
      () =>
        executeMcpToolCall({
          serverName: "srv",
          toolName: "echo",
          client: abortingClient,
          params: {},
          timeoutMs: 1000,
          signal: midCallController.signal,
        }),
      (err: unknown) =>
        err instanceof McpError &&
        err.code === "protocol" &&
        err.message === "Tool execution cancelled",
    );

    const rawErr = new Error("broken pipe");
    const failingClient = {
      callTool: async () => {
        throw rawErr;
      },
    } as unknown as Client;
    await assert.rejects(
      () =>
        executeMcpToolCall({
          serverName: "srv",
          toolName: "echo",
          client: failingClient,
          params: {},
          timeoutMs: 1000,
        }),
      (err: unknown) => err === rawErr,
    );

    const isErrorTextClient = {
      callTool: async () => ({
        isError: true,
        content: [{ type: "text", text: "invalid query syntax" }],
      }),
    } as unknown as Client;
    await assert.rejects(
      () =>
        executeMcpToolCall({
          serverName: "srv",
          toolName: "query",
          client: isErrorTextClient,
          params: {},
          timeoutMs: 1000,
        }),
      (err: unknown) =>
        err instanceof McpError &&
        err.code === "tool" &&
        err.message === "invalid query syntax",
    );

    const isErrorEmptyClient = {
      callTool: async () => ({
        isError: true,
        content: [{ type: "image", data: "abc", mimeType: "image/png" }],
      }),
    } as unknown as Client;
    await assert.rejects(
      () =>
        executeMcpToolCall({
          serverName: "srv",
          toolName: "broken",
          client: isErrorEmptyClient,
          params: {},
          timeoutMs: 1000,
        }),
      (err: unknown) =>
        err instanceof McpError &&
        err.code === "tool" &&
        err.message === "Tool reported an error",
    );

    const okClient = {
      callTool: async () => ({
        content: [{ type: "text", text: "done" }],
      }),
    } as unknown as Client;
    const outcome = await executeMcpToolCall({
      serverName: "srv",
      toolName: "ok_tool",
      client: okClient,
      params: { x: 1 },
      timeoutMs: 1000,
    });
    assert.deepEqual(outcome, {
      content: [{ type: "text", text: "done" }],
      details: {},
    });
  });
});

describe("tool-execution: createPiToolDefinition dynamic evaluation", () => {
  it("evaluates getTimeoutMs() and onAuthError dynamically at execute() call time", async () => {
    const seenTimeouts: number[] = [];
    let failUnauthorized = false;
    const client = {
      callTool: async (_args: unknown, _schema: unknown, opts: { timeout: number }) => {
        seenTimeouts.push(opts.timeout);
        if (failUnauthorized) {
          throw new UnauthorizedError("401 unauthorized");
        }
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as Client;

    let currentTimeout = 2500;
    const authEvents: string[] = [];
    const tool: McpToolDefinition = {
      name: "search",
      description: "Search records across the workspace with a long description that exceeds one hundred and twenty characters so promptSnippet slices cleanly.",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      annotations: { title: "Search Records", readOnlyHint: true },
    };

    const defOptions: CreatePiToolDefinitionOptions = {
      piName: "mcp_srv_search",
      serverName: "srv",
      tool,
      client,
      getTimeoutMs: () => currentTimeout,
    };
    const definition = createPiToolDefinition(defOptions);

    assert.equal(definition.name, "mcp_srv_search");
    assert.equal(definition.label, "Search Records");
    assert.equal(definition.promptSnippet?.length, 120);
    assert.deepEqual(definition.annotations, { readOnlyHint: true });

    const bareDefinition = createPiToolDefinition({
      piName: "mcp_srv_plain",
      serverName: "srv",
      tool: { name: "plain", inputSchema: { type: "object", properties: {} } },
      client,
      getTimeoutMs: () => currentTimeout,
    });
    assert.equal(bareDefinition.label, "plain");
    assert.equal("annotations" in bareDefinition, false);

    await definition.execute("call-1", { q: "first" }, undefined, undefined, dummyCtx);
    currentTimeout = 9000;
    defOptions.onAuthError = (serverName) => {
      authEvents.push(serverName);
    };
    failUnauthorized = true;

    await assert.rejects(
      () => definition.execute("call-2", { q: "second" }, undefined, undefined, dummyCtx),
      (err: unknown) => err instanceof McpError && err.code === "protocol",
    );

    assert.deepEqual(seenTimeouts, [2500, 9000]);
    assert.deepEqual(authEvents, ["srv"]);
  });
});

describe("tool-discovery: discoverServerTools", () => {
  it("returns discovered tools and classifies cancellation, 401 auth errors, SDK timeouts, and non-Error throws", async () => {
    const okClient = {
      listTools: async () => ({
        tools: [{ name: "alpha", inputSchema: { type: "object", properties: {} } }],
      }),
    } as unknown as Client;
    const discovered = await discoverServerTools({
      client: okClient,
      serverName: "srv",
      requestTimeoutMs: 1000,
    });
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.name, "alpha");

    const preservedCancel = new AuthCancelledError("srv");
    const cancelClient = {
      listTools: async () => {
        throw preservedCancel;
      },
    } as unknown as Client;
    await assert.rejects(
      () => discoverServerTools({ client: cancelClient, serverName: "srv", requestTimeoutMs: 1000 }),
      (err: unknown) => err === preservedCancel,
    );

    const abortErr = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    const abortClient = {
      listTools: async () => {
        throw abortErr;
      },
    } as unknown as Client;
    await assert.rejects(
      () => discoverServerTools({ client: abortClient, serverName: "srv", requestTimeoutMs: 1000 }),
      (err: unknown) =>
        err instanceof AuthCancelledError && err.message === "Authentication cancelled for srv",
    );

    const authNotified: string[] = [];
    const unauthClient = {
      listTools: async () => {
        throw new UnauthorizedError("missing bearer");
      },
    } as unknown as Client;
    await assert.rejects(
      () =>
        discoverServerTools({
          client: unauthClient,
          serverName: "auth-srv",
          requestTimeoutMs: 1000,
          onAuthError: (name) => {
            authNotified.push(name);
          },
        }),
      (err: unknown) => err instanceof McpError && err.code === "protocol",
    );
    assert.deepEqual(authNotified, ["auth-srv"]);

    const timeoutClient = {
      listTools: async () => {
        throw new SdkMcpError(ErrorCode.RequestTimeout, "listTools timed out");
      },
    } as unknown as Client;
    await assert.rejects(
      () =>
        discoverServerTools({
          client: timeoutClient,
          serverName: "slow-srv",
          requestTimeoutMs: 1000,
        }),
      (err: unknown) => err instanceof McpError && err.code === "timeout",
    );

    const stringThrowClient = {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      listTools: () => Promise.reject("malformed frame"),
    } as unknown as Client;
    await assert.rejects(
      () =>
        discoverServerTools({
          client: stringThrowClient,
          serverName: "bad-srv",
          requestTimeoutMs: 1000,
        }),
      (err: unknown) =>
        err instanceof McpError &&
        err.code === "protocol" &&
        err.message.includes("malformed frame"),
    );
  });
});
