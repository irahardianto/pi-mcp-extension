/**
 * Stateless MCP `tools/call` execution, `notifications/progress` formatting and
 * deduplication (#254), failure normalization (#209), and Pi `ToolDefinition`
 * construction for pi-mcp.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, type Progress } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isCancellationError, isOAuthUnauthorizedError, isSdkTimeoutError } from "./connect-policy.js";
import { McpError } from "./errors.js";
import { convertJsonSchemaToTypebox } from "./schema-convert.js";
import { redactSecrets } from "./secret-redaction.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import {
  buildToolAnnotations,
  buildToolCallContent,
  buildToolDescription,
  toolErrorText,
  type ToolCallOutcome,
  type ToolCallResponse,
} from "./tool-content.js";
import type { McpToolDefinition } from "./tool-discovery.js";

/** Pi's partial-result callback — the `onUpdate` argument of a tool's `execute`. */
export type ToolUpdateCallback = (update: ToolCallOutcome) => void;

/** Callback notified when a mid-session `tools/call` fails with an OAuth 401/403 challenge. */
export type ToolAuthErrorHandler = (serverName: string, error: unknown) => Promise<void> | void;

/** Per-call streaming and cancellation options for one `tools/call`. */
export interface ToolCallOptions {
  signal?: AbortSignal | undefined;
  onUpdate?: ToolUpdateCallback | undefined;
}

/** Input for running a single MCP `tools/call` and converting its result for Pi. */
export interface ExecuteMcpToolCallOptions {
  serverName: string;
  toolName: string;
  client: Client;
  params: unknown;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  onUpdate?: ToolUpdateCallback | undefined;
}

/** Input for constructing a Pi `ToolDefinition` backed by an MCP server tool. */
export interface CreatePiToolDefinitionOptions {
  piName: string;
  serverName: string;
  tool: McpToolDefinition;
  client: Client;
  getTimeoutMs: () => number;
  onAuthError?: ToolAuthErrorHandler | undefined;
}

/** Character budget for one progress line; Pi renders the latest line while the tool runs. */
const PROGRESS_MESSAGE_MAX_LENGTH = 200;

/**
 * Render one MCP `notifications/progress` payload as a single Pi-visible line.
 *
 * `message` is server-controlled and lands in Pi's UI stream, so it is sanitized (ANSI and
 * control sequences stripped, length bounded) and stripped of token-like substrings first.
 * A server that sends no usable text gets a numeric `Progress 3/10` line instead.
 *
 * WHY: sanitize before redacting, as `sanitizeLogText` does — the sanitizer deletes escape
 * sequences, and an escape *inside* a credential (`\u001b[1mtoken\u001b[0m=sk-…`) hides the
 * `key=value` shape from `redactSecrets`, which would then pass the token through verbatim.
 */
export function formatProgressText(progress: Progress): string {
  const rawMessage = typeof progress.message === "string" ? progress.message : "";
  // WHY: decide usability on the full text (`maxLength` = its own length disables truncation) and
  // trim surrounding whitespace first. `sanitizeTerminalText` appends `…` when it truncates and
  // turns trailing newlines into spaces, so untrimmed padding would either defeat the fallback,
  // consume the 200-char budget into a blank `   …` row, or split dedupe across `msg` vs `msg\n`.
  const message = sanitizeTerminalText(rawMessage, { maxLength: rawMessage.length }).trim();
  if (message.length > 0) {
    // WHY: bound after redaction — a `[REDACTED]` mask is longer than the value it replaces, so
    // capping first would let the emitted line grow past the budget (or slice a token before the
    // redactor can recognise it).
    return sanitizeTerminalText(redactSecrets(message), {
      maxLength: PROGRESS_MESSAGE_MAX_LENGTH,
    });
  }
  const current = Number.isFinite(progress.progress) ? String(progress.progress) : "?";
  const total = Number.isFinite(progress.total) ? `/${progress.total}` : "";
  return `Progress ${current}${total}`;
}

/**
 * Build the SDK `onprogress` handler for one `tools/call`.
 *
 * WHY: the handler is installed even when Pi passes no `onUpdate` callback. The SDK attaches
 * `_meta.progressToken` only when `onprogress` is set, and the timer reset that keeps a long,
 * actively-reporting tool alive (`resetTimeoutOnProgress`) hangs off that token (#254).
 *
 * Consecutive identical lines are dropped: some servers repeat one message on every tick, and
 * each emission re-renders Pi's in-progress tool row.
 */
export function createProgressReporter(
  onUpdate: ToolUpdateCallback | undefined,
): (progress: Progress) => void {
  let lastText: string | undefined;
  return (progress: Progress): void => {
    if (!onUpdate) return;
    const text = formatProgressText(progress);
    if (text === lastText) return;
    lastText = text;
    onUpdate({ content: [{ type: "text", text }], details: {} });
  };
}

/** Call tools/call through the typed helper when present, else a raw JSON-RPC request. */
export function callToolWithClient(
  client: Client,
  toolName: string,
  params: unknown,
  timeoutMs: number,
  options: ToolCallOptions,
): Promise<ToolCallResponse> {
  const requestOptions = {
    timeout: timeoutMs,
    // WHY: without these two the SDK never attaches a progress token, so it drops the server's
    // `notifications/progress` as an unknown token and keeps the original inactivity deadline —
    // a tool that reports progress every few seconds was still killed at `requestTimeoutMs` (#254).
    resetTimeoutOnProgress: true,
    onprogress: createProgressReporter(options.onUpdate),
    // Pass AbortSignal to SDK — it will automatically send
    // notifications/cancelled when the signal fires
    ...(options.signal ? { signal: options.signal } : {}),
  };
  if (typeof client.callTool === "function") {
    return client.callTool(
      { name: toolName, arguments: params as Record<string, unknown> },
      CallToolResultSchema,
      requestOptions,
    );
  }
  return client.request(
    {
      method: "tools/call",
      params: { name: toolName, arguments: params },
    },
    CallToolResultSchema,
    requestOptions,
  );
}

/**
 * Normalize a `tools/call` failure into the `McpError` callers see, after notifying the
 * OAuth handler when the failure means the server needs authorization.
 */
export async function rethrowToolCallError(
  serverName: string,
  err: unknown,
  onAuthError?: ToolAuthErrorHandler | undefined,
): Promise<never> {
  if (err instanceof McpError) throw err;
  if (isOAuthUnauthorizedError(err)) {
    await onAuthError?.(serverName, err);
  }
  // Protocol-level errors (JSON-RPC error response, malformed payload) keep
  // "protocol"; an SDK request timeout keeps its own code so callers can tell
  // "the server answered badly" from "the server did not answer in time" (#209).
  throw new McpError(
    err instanceof Error ? err.message : String(err),
    serverName,
    isSdkTimeoutError(err) ? "timeout" : "protocol",
    err,
  );
}

/**
 * Run one `tools/call`: dispatch through the SDK client, convert the result
 * into Pi content blocks, and surface `isError` as `McpError(..., "tool")`.
 */
export async function executeMcpToolCall(
  options: ExecuteMcpToolCallOptions,
): Promise<ToolCallOutcome> {
  const { serverName, toolName, client, params, timeoutMs, signal, onUpdate } = options;
  if (signal?.aborted) {
    throw new McpError("Tool execution cancelled", serverName, "protocol");
  }

  let result: ToolCallResponse;
  try {
    result = await callToolWithClient(client, toolName, params, timeoutMs, { signal, onUpdate });
  } catch (err) {
    // WHY: an abort mid-call is rejected by the SDK with its RequestTimeout error, so the
    // cancellation has to be recognised here — otherwise a caller cancellation is reported
    // as a server timeout, and blamed on the server (#209).
    if (isCancellationError(err, signal)) {
      throw new McpError("Tool execution cancelled", serverName, "protocol");
    }
    throw err;
  }
  const content = buildToolCallContent(result);

  // Tool execution errors (isError: true) — distinct from protocol errors
  if (result.isError) {
    throw new McpError(toolErrorText(content) || "Tool reported an error", serverName, "tool");
  }

  return { content, details: {} };
}

/** Construct a Pi `ToolDefinition` backed by one discovered MCP tool. */
export function createPiToolDefinition(options: CreatePiToolDefinitionOptions): ToolDefinition {
  const { piName, serverName, tool, client } = options;
  const annotations = tool.annotations;
  const description = buildToolDescription(tool, annotations);
  const toolAnnotations = buildToolAnnotations(annotations);
  // WHY: `execute` runs with `this` bound to the registered-tool literal rather than the
  // caller, and both timeout settings (`updateSettings`) and auth handlers
  // (`setAuthErrorCallback`) can change after registration, so read `options.getTimeoutMs()`
  // and `options.onAuthError` dynamically at call time.
  return {
    name: piName,
    label: annotations?.title ?? tool.name,
    description,
    promptSnippet: description.slice(0, 120),
    parameters: convertJsonSchemaToTypebox(tool.inputSchema),
    ...(toolAnnotations ? { annotations: toolAnnotations } : {}),

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      try {
        return await executeMcpToolCall({
          serverName,
          toolName: tool.name,
          client,
          params,
          timeoutMs: options.getTimeoutMs(),
          signal,
          onUpdate,
        });
      } catch (err) {
        return await rethrowToolCallError(serverName, err, options.onAuthError);
      }
    },
  };
}
