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
import { buildToolCallOutcome, convertMcpContent } from "../src/tool-content.js";
import {
  discoverServerTools,
  readClientInstructions,
  type McpToolDefinition,
} from "../src/tool-discovery.js";
import {
  callToolWithClient,
  createPiToolDefinition,
  createProgressReporter,
  executeMcpToolCall,
  formatProgressText,
  rethrowToolCallError,
  toHiddenToolDefinition,
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

    const TINY_PNG =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const isErrorEmptyClient = {
      callTool: async () => ({
        isError: true,
        content: [{ type: "image", data: TINY_PNG, mimeType: "image/png" }],
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
      structuredContent: { content: [{ type: "text", text: "done" }] },
    });

    const structuredErrorOutcome = await executeMcpToolCall({
      serverName: "srv",
      toolName: "broken",
      client: isErrorEmptyClient,
      params: {},
      timeoutMs: 1000,
      supportsErrorResult: true,
    });
    assert.equal(structuredErrorOutcome.isError, true);
    assert.equal(structuredErrorOutcome.content[1]?.type, "text");

    await assert.rejects(
      () =>
        executeMcpToolCall({
          serverName: "srv",
          toolName: "ok_tool",
          client: okClient,
          params: {},
          timeoutMs: 1000,
          assertCallable: () => {
            throw new McpError("server disconnected", "srv", "connection");
          },
        }),
      (err: unknown) => err instanceof McpError && err.code === "connection",
    );
  });
});

describe("tool-execution: createPiToolDefinition and toHiddenToolDefinition", () => {
  it("wires exposure, namespace, outputSchema, assertCallable, dynamic getTimeoutMs/onAuthError, and toHiddenToolDefinition", async () => {
    const seenTimeouts: number[] = [];
    let failUnauthorized = false;
    let reportToolError = false;
    const client = {
      callTool: async (_args: unknown, _schema: unknown, opts: { timeout: number }) => {
        seenTimeouts.push(opts.timeout);
        if (failUnauthorized) {
          throw new UnauthorizedError("401 unauthorized");
        }
        if (reportToolError) {
          return { isError: true, content: [{ type: "text", text: "domain error" }] };
        }
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as Client;

    let currentTimeout = 2500;
    let callable = true;
    const authEvents: string[] = [];
    const tool: McpToolDefinition = {
      name: "search",
      description: "Search records across the workspace with a long description that exceeds one hundred and twenty characters so promptSnippet slices cleanly.",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      outputSchema: { type: "object", properties: { count: { type: "number" } } },
      annotations: { title: "Search Records", readOnlyHint: true },
    };

    const defOptions: CreatePiToolDefinitionOptions = {
      piName: "mcp_srv_search",
      serverName: "srv",
      tool,
      client,
      exposure: "direct",
      namespace: { name: "mcp_srv", aliases: ["srv"] },
      getTimeoutMs: () => currentTimeout,
      assertCallable: () => {
        if (!callable) throw new McpError("stopped", "srv", "connection");
      },
    };
    const definition = createPiToolDefinition(defOptions);

    assert.equal(definition.name, "mcp_srv_search");
    assert.equal(definition.label, "Search Records");
    assert.equal(definition.exposure, "direct");
    assert.equal("defaultActive" in definition, false);
    assert.deepEqual(definition.namespace, { name: "mcp_srv", aliases: ["srv"] });
    assert.ok(definition.outputSchema);
    assert.equal(definition.promptSnippet?.length, 120);
    assert.deepEqual(definition.annotations, { readOnlyHint: true });

    const bareDefinition = createPiToolDefinition({
      piName: "mcp_srv_plain",
      serverName: "srv",
      tool: { name: "plain", inputSchema: { type: "object", properties: {} } },
      client,
      exposure: "codemode",
      namespace: { name: "mcp_srv" },
      getTimeoutMs: () => currentTimeout,
    });
    assert.equal(bareDefinition.label, "plain");
    assert.equal(bareDefinition.exposure, "deferred");
    assert.equal((bareDefinition as { defaultActive?: boolean }).defaultActive, false);
    assert.equal("annotations" in bareDefinition, false);

    const hiddenCopy = toHiddenToolDefinition(bareDefinition);
    assert.ok(hiddenCopy);
    assert.equal(hiddenCopy.exposure, "hidden");
    assert.equal((hiddenCopy as { defaultActive?: boolean }).defaultActive, false);
    assert.equal(toHiddenToolDefinition(hiddenCopy), undefined);

    await definition.execute("call-1", { q: "first" }, undefined, undefined, dummyCtx);
    reportToolError = true;
    const pi13Ctx = { executeTool: async () => ({}) } as unknown as ExtensionToolContext;
    const errRes = await definition.execute("call-err", { q: "err" }, undefined, undefined, pi13Ctx);
    assert.equal((errRes as { isError?: boolean }).isError, true);
    reportToolError = false;

    currentTimeout = 9000;
    defOptions.onAuthError = (serverName) => {
      authEvents.push(serverName);
    };
    failUnauthorized = true;

    await assert.rejects(
      () => definition.execute("call-2", { q: "second" }, undefined, undefined, dummyCtx),
      (err: unknown) => err instanceof McpError && err.code === "protocol",
    );

    callable = false;
    await assert.rejects(
      () => definition.execute("call-3", { q: "third" }, undefined, undefined, dummyCtx),
      (err: unknown) => err instanceof McpError && err.code === "connection",
    );

    assert.deepEqual(seenTimeouts, [2500, 2500, 9000]);
    assert.deepEqual(authEvents, ["srv"]);
  });
});

describe("tool-content: image MIME canonicalization, SVG decoding, and payload validation", () => {
  const SAMPLE_BASE64 = "YWJj";
  const SVG_MARKUP = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>';
  const SVG_BASE64 = Buffer.from(SVG_MARKUP, "utf8").toString("base64");

  it("decodes image/svg+xml (including uppercase and parameters) to UTF-8 text while preserving structuredContent", () => {
    const outcome = buildToolCallOutcome(
      {
        content: [
          { type: "image", data: SVG_BASE64, mimeType: "image/svg+xml" },
          { type: "image", data: SVG_BASE64, mimeType: "IMAGE/SVG+XML; charset=utf-8" },
        ],
      },
      "srv",
      true,
    );

    assert.deepEqual(outcome.content, [
      { type: "text", text: SVG_MARKUP },
      { type: "text", text: SVG_MARKUP },
    ]);
    assert.deepEqual(outcome.structuredContent, {
      content: [
        { type: "image", data: SVG_BASE64, mimeType: "image/svg+xml" },
        { type: "image", data: SVG_BASE64, mimeType: "IMAGE/SVG+XML; charset=utf-8" },
      ],
    });
  });

  it("canonicalizes parameterized and jpg MIME types, preserves BMP/TIFF for Photon, and strips ASCII whitespace", () => {
    const out = convertMcpContent([
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/png; charset=binary" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "IMAGE/PNG; foo=bar" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/jpg" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "IMAGE/JPG; charset=binary" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/bmp" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/x-ms-bmp" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/tiff" },
      { type: "image", data: " YWJj \r\n\t ", mimeType: "image/webp" },
    ]);

    assert.deepEqual(out, [
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/png" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/png" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/jpeg" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/jpeg" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/bmp" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/x-ms-bmp" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/tiff" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/webp" },
    ]);
  });

  it("degrades empty, invalid, and non-string image payloads (including empty SVG) to omission text without throwing", () => {
    const invalidInputs = [
      { type: "image", data: "", mimeType: "image/png" },
      { type: "image", data: "   \n\t  ", mimeType: "image/png" },
      { type: "image", data: "abc", mimeType: "image/png" },
      { type: "image", data: "====", mimeType: "image/png" },
      { type: "image", data: "a===", mimeType: "image/png" },
      { type: "image", data: "ab=c", mimeType: "image/png" },
      { type: "image", data: "ab-_", mimeType: "image/png" },
      { type: "image", data: 1234, mimeType: "image/png" },
      { type: "image", data: { toString: false }, mimeType: { toString: false } },
      { type: "image", data: "", mimeType: "image/svg+xml" },
      { type: "image", data: "abc", mimeType: "image/svg+xml" },
    ];

    const out = convertMcpContent(invalidInputs);
    for (const block of out) {
      assert.deepEqual(block, {
        type: "text",
        text: "[Image omitted: empty or invalid base64 payload]",
      });
    }
  });

  it("degrades unsupported and control-tainted image MIME types to sanitized omission text", () => {
    const out = convertMcpContent([
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/x-icon" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/heic; profile=main" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "application/pdf" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/x-icon\u001b[31m" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/png\u001b[31m" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/jpg\u001b[31m" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/svg+xml\u001b[31m" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "\u001b[31m" },
    ]);

    assert.deepEqual(out, [
      { type: "text", text: "[Image omitted: unsupported image type (image/x-icon)]" },
      { type: "text", text: "[Image omitted: unsupported image type (image/heic)]" },
      { type: "text", text: "[Image omitted: unsupported image type (application/pdf)]" },
      { type: "text", text: "[Image omitted: unsupported image type (image/x-icon)]" },
      { type: "text", text: "[Image omitted: unsupported image type (invalid MIME type)]" },
      { type: "text", text: "[Image omitted: unsupported image type (invalid MIME type)]" },
      { type: "text", text: "[Image omitted: unsupported image type (invalid MIME type)]" },
      { type: "text", text: "[Image omitted: unsupported image type (unknown)]" },
    ]);
  });

  it("degrades binary or NUL-containing image/svg+xml payloads instead of emitting corrupted UTF-8", () => {
    const binaryPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const out = convertMcpContent([
      { type: "image", data: binaryPng, mimeType: "image/svg+xml" },
      { type: "image", data: "AA==", mimeType: "IMAGE/SVG+XML; charset=utf-8" },
    ]);

    assert.deepEqual(out, [
      { type: "text", text: "[Image omitted: invalid UTF-8 image/svg+xml payload]" },
      { type: "text", text: "[Image omitted: invalid UTF-8 image/svg+xml payload]" },
    ]);
  });

  it("normalizes embedded type=resource image blobs through convertMcpContent while preserving structuredContent", () => {
    const rawContent = [
      { type: "resource", resource: { uri: "res://diagram.svg", mimeType: "IMAGE/SVG+XML; charset=utf-8", blob: SVG_BASE64 } },
      { type: "resource", resource: { uri: "res://pic.png", mimeType: "image/png; charset=binary", blob: SAMPLE_BASE64 } },
      { type: "resource", resource: { uri: "res://photo.jpg", mimeType: "image/jpg", blob: SAMPLE_BASE64 } },
      { type: "resource", resource: { uri: "res://scan.bmp", mimeType: "image/bmp", blob: SAMPLE_BASE64 } },
      { type: "resource", resource: { uri: "res://empty.png", mimeType: "image/png", blob: "" } },
      { type: "resource", resource: { uri: "res://nul.svg", mimeType: "image/svg+xml", blob: "AA==" } },
      { type: "resource", resource: { uri: "res://fav.ico", mimeType: "image/x-icon", blob: SAMPLE_BASE64 } },
    ];
    const outcome = buildToolCallOutcome({ content: rawContent }, "srv", true);

    assert.deepEqual(outcome.content, [
      { type: "text", text: SVG_MARKUP },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/png" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/jpeg" },
      { type: "image", data: SAMPLE_BASE64, mimeType: "image/bmp" },
      { type: "text", text: "[Binary resource: res://empty.png (image/png, empty or invalid base64 payload)]" },
      { type: "text", text: "[Binary resource: res://nul.svg (image/svg+xml, invalid UTF-8 payload)]" },
      { type: "text", text: "[Binary resource: res://fav.ico (image/x-icon, 3 bytes)]" },
    ]);
    assert.deepEqual(outcome.structuredContent, { content: rawContent });
  });

  it("composes cleanly with blank-text structuredContent fallback (#359)", () => {
    // Empty/invalid image produces a non-blank omission notice rather than hiding the omission.
    const invalidImageOutcome = buildToolCallOutcome(
      {
        content: [{ type: "image", data: "", mimeType: "image/png" }],
        structuredContent: { ok: true },
      },
      "srv",
      true,
    );
    assert.deepEqual(invalidImageOutcome.content, [
      { type: "text", text: "[Image omitted: empty or invalid base64 payload]" },
    ]);

    // A whitespace-only decoded SVG falls back to structuredContent on success and generic error text on isError.
    const whitespaceSvg = Buffer.from("  \n\t", "utf8").toString("base64");
    const blankSvgOutcome = buildToolCallOutcome(
      {
        content: [{ type: "image", data: whitespaceSvg, mimeType: "image/svg+xml" }],
        structuredContent: { rendered: false },
      },
      "srv",
      true,
    );
    assert.deepEqual(blankSvgOutcome.content, [
      { type: "text", text: '{\n  "rendered": false\n}' },
    ]);

    const blankSvgError = buildToolCallOutcome(
      {
        isError: true,
        content: [{ type: "image", data: whitespaceSvg, mimeType: "image/svg+xml" }],
      },
      "srv",
      true,
    );
    assert.equal(blankSvgError.isError, true);
    assert.deepEqual(blankSvgError.content, [{ type: "text", text: "Tool reported an error" }]);
  });

  it("never leaks broken ImageContent from isError: true tool responses", () => {
    assert.throws(
      () =>
        buildToolCallOutcome(
          { isError: true, content: [{ type: "image", data: "", mimeType: "image/png" }] },
          "srv",
          false,
        ),
      (err: unknown) =>
        err instanceof McpError &&
        err.code === "tool" &&
        err.message === "[Image omitted: empty or invalid base64 payload]",
    );

    const structured = buildToolCallOutcome(
      { isError: true, content: [{ type: "image", data: "abc", mimeType: "image/svg+xml" }] },
      "srv",
      true,
    );
    assert.equal(structured.isError, true);
    assert.deepEqual(structured.content, [
      { type: "text", text: "[Image omitted: empty or invalid base64 payload]" },
    ]);
  });
});

describe("tool-discovery: discoverServerTools and readClientInstructions", () => {
  it("reads handshake instructions safely and classifies discovery errors", async () => {
    assert.equal(
      readClientInstructions({ getInstructions: () => "Use search first" } as unknown as Client),
      "Use search first",
    );
    assert.equal(readClientInstructions({} as unknown as Client), undefined);

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
