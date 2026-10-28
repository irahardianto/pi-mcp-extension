/**
 * Pure connection failure classification and retry policy for pi-mcp.
 *
 * Owns:
 *   - Pure OAuth 401/403 connect and tool error detection (`isOAuthUnauthorizedError`)
 *   - Pure SDK request-timeout detection (`isSdkTimeoutError`) and cancellation detection
 *     (`isCancellationError`)
 *   - Fixed retry backoff schedule (`RETRY_DELAYS_MS`)
 *   - Connect-failure classification into retry, auth-required, fast-fail, give-up, or cancelled (`classifyConnectFailure`)
 */

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpError, AuthCancelledError } from "./errors.js";
import { AuthRequiredError } from "./oauth-provider.js";
import type { ServerConfig } from "./config.js";

function isHttpStatusCodeUnauthorized(numericCode: number, error: unknown): boolean {
  if (numericCode === 401) return true;
  const msg = error instanceof Error ? error.message : String(error);
  if (numericCode === 403 && /\b(insufficient_scope|trying upscoping)\b/i.test(msg)) {
    return true;
  }
  return false;
}

function extractNumericStatusCode(rec: {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
}): number | undefined {
  if (typeof rec.code === "number") return rec.code;
  if (typeof rec.status === "number") return rec.status;
  if (typeof rec.statusCode === "number") return rec.statusCode;
  return undefined;
}

function isObjectRecordUnauthorized(
  error: object,
  seen: Set<unknown>,
): boolean | undefined {
  if (error instanceof McpError && error.code === "tool") {
    // WHY: Tool-level application errors (`isError: true`) come from tool execution logic
    // (e.g. "found 401 items in database") and must never trigger MCP OAuth re-authentication.
    return false;
  }

  const rec = error as { code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
  if (rec.cause !== undefined && isOAuthUnauthorizedError(rec.cause, seen)) {
    return true;
  }
  const numericCode = extractNumericStatusCode(rec);
  // WHY: Only treat 100..599 as HTTP status codes so negative JSON-RPC error codes
  // (e.g. -32000) still inspect the error message for wrapped HTTP 401/403 status text.
  if (numericCode !== undefined && numericCode >= 100 && numericCode <= 599) {
    return isHttpStatusCodeUnauthorized(numericCode, error);
  }
  return undefined;
}

function hasBare401StatusMarker(msg: string): boolean {
  return (
    // nosemgrep: pi-mcp.no-401-substring -- WHY: intentional message-text fallback after structured checks for SDK paths that only surface text
    /^\s*401\s*$/.test(msg) ||
    // nosemgrep: pi-mcp.no-401-substring -- WHY: intentional message-text fallback after structured checks for SDK paths that only surface text
    /\bHTTP(?:\/\d(?:\.\d)?)?[:\s]+401\b/i.test(msg) ||
    // nosemgrep: pi-mcp.no-401-substring -- WHY: intentional message-text fallback after structured checks for SDK paths that only surface text
    /\bstatus(?:\s+code)?[:\s(]+401\b/i.test(msg)
  );
}

function hasWrapped401StatusText(msg: string): boolean {
  return (
    // nosemgrep: pi-mcp.no-401-substring -- WHY: intentional message-text fallback after structured checks for SDK paths that only surface text
    /\b(?:POSTing|GETting|connecting)\s+to\s+\S+:\s*401\b/i.test(msg) ||
    // nosemgrep: pi-mcp.no-401-substring -- WHY: intentional message-text fallback after structured checks for SDK paths that only surface text
    /\breturned\s+401\b/i.test(msg) ||
    // nosemgrep: pi-mcp.no-401-substring -- WHY: intentional message-text fallback after structured checks for SDK paths that only surface text
    /\b401\s+Unauthorized\b/i.test(msg)
  );
}

function has401MessageMarker(msg: string): boolean {
  return (
    // nosemgrep: pi-mcp.no-401-substring -- WHY: intentional message-text fallback after structured checks for SDK paths that only surface text
    /\(401\)/.test(msg) ||
    /\binvalid_token\b/i.test(msg)
  );
}

function hasUnauthorizedMessageMarker(msg: string): boolean {
  return hasBare401StatusMarker(msg) || hasWrapped401StatusText(msg) || has401MessageMarker(msg);
}

function isUnauthorizedErrorMessage(msg: string): boolean {
  // Reject messages that explicitly report a non-401/403 HTTP status code
  const httpStatusMatch = msg.match(
    /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?:\s+code)?[:\s]+|(?:POSTing|GETting|connecting)\s+to\s+\S+:\s*|(?:Non-200\s+status\s+code\s*\())(\d{3})\b/i,
  );
  if (httpStatusMatch) {
    const status = Number(httpStatusMatch[1]);
    if (status !== 401 && status !== 403) {
      return false;
    }
  }

  if (hasUnauthorizedMessageMarker(msg)) {
    return true;
  }

  return (
    /\b(403|Forbidden)\b/i.test(msg) &&
    /\b(insufficient_scope|trying upscoping)\b/i.test(msg)
  );
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

export function isOAuthUnauthorizedError(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || seen.has(error)) {
    return false;
  }
  if (typeof error === "object") {
    seen.add(error);
    if (error instanceof AuthRequiredError || error instanceof UnauthorizedError) {
      return true;
    }
    const objectResult = isObjectRecordUnauthorized(error, seen);
    if (objectResult !== undefined) {
      return objectResult;
    }
  }

  const msg = extractErrorMessage(error);
  return msg ? isUnauthorizedErrorMessage(msg) : false;
}

/** Fixed retry delay schedule — predictable, no jitter math needed. */
export const RETRY_DELAYS_MS = [1000, 3000, 5000, 10000, 30000] as const;

/** Message text of an error-ish value, preferring a real `message` field over `String()`. */
function errorMessageOf(err: unknown): string {
  // WHY: transports reject with plain `{ code, message, data }` objects too, where
  // `String(err)` is "[object Object]" and the message would be lost.
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(err);
}

/**
 * Whether `err` is the MCP SDK's own request-timeout rejection.
 *
 * The SDK rejects a timed-out `initialize`, `tools/list`, or `tools/call` with **its**
 * `McpError` carrying the numeric JSON-RPC code `ErrorCode.RequestTimeout` (-32001) —
 * a different class from pi-mcp's own {@link McpError}, so an `instanceof McpError`
 * check here only excludes codes this extension already decided on. Any layer that
 * re-wraps an SDK error must keep the timeout distinction: `classifyConnectFailure`
 * fast-fails an error coded `"protocol"`, which would turn a transient discovery
 * timeout into a first-attempt failure with no retries.
 */
export function isSdkTimeoutError(err: unknown): boolean {
  // WHY: our own McpError already carries a deliberate code; never re-derive it from
  // the message (e.g. "Connection timed out after 5000ms" is already code "timeout").
  if (err instanceof McpError) return false;
  const code = (err as { code?: unknown } | null)?.code;
  // WHY: a negative numeric code is a JSON-RPC error code, and a server error response
  // arrives with its own (e.g. ErrorCode.InternalError = -32603) plus a message that may
  // well say "timed out". Only the SDK's own RequestTimeout means the client gave up on
  // the server, so no other negative code may fall through to the message heuristic.
  if (typeof code === "number" && code < 0) return code === -32001;
  return /Request timed out|timed out/i.test(errorMessageOf(err));
}

/**
 * Whether `err`/`signal` are our own cancellation rather than a failure of the server.
 *
 * The SDK's `Protocol.request` rejects an in-flight request on abort as
 * `McpError(ErrorCode.RequestTimeout, String(signal.reason))` — carrying the *timeout* code
 * for a caller cancellation (`cancel()` in the SDK is shared by the timeout handler and the
 * abort listener). Anything that classifies an SDK error must therefore test cancellation
 * first, or a cancelled tool call is reported as a server timeout.
 */
export function isCancellationError(err: unknown, signal?: AbortSignal | undefined): boolean {
  // WHY: the caller's own abort is authoritative — it survives the SDK rewrapping the reason.
  if (signal?.aborted || err instanceof AuthCancelledError) return true;
  if (!(err instanceof Error)) return false;
  // WHY: fallback for an abort-shaped rejection that arrives without our signal — the SDK's
  // abort listener sets `signal.aborted` before rejecting, so this leg only matters when the
  // rejection came from a signal we were never handed (or a transport-level abort). Still
  // narrow on purpose: only a -32001 carrier is inspected, so a JSON-RPC error response whose
  // message merely mentions "aborted" keeps its own class.
  return err.name === "AbortError" || ((err as { code?: unknown }).code === -32001 && /abort/i.test(err.message));
}

export type TransportType = ServerConfig["transport"];

export type ConnectFailureAction =
  | { kind: "cancelled" }
  | { kind: "retry-corrupt-state" }
  | { kind: "auth-required"; invalidateTokens: boolean }
  | { kind: "fail"; error: Error }
  | { kind: "give-up"; error: McpError }
  | { kind: "retry"; delayMs: number };

export interface ClassifyConnectFailureInput {
  error: unknown;
  aborted: boolean;
  corruptStateRecovered: boolean;
  hasAuth: boolean;
  transport: TransportType;
  retryCount: number;
  maxRetries: number;
  serverName?: string;
}

function classifyOAuthFailure(
  input: ClassifyConnectFailureInput,
  error: Error,
): ConnectFailureAction | null {
  if (error instanceof AuthRequiredError) {
    return { kind: "auth-required", invalidateTokens: false };
  }
  if (input.hasAuth && input.transport !== "stdio" && isOAuthUnauthorizedError(input.error)) {
    // WHY: Check OAuth unauthorized errors BEFORE the generic `error.code === "protocol"`
    // fast-fail so 401/403 failures during initial tools/list (`onToolRefresh`) are
    // classified as `AuthRequiredError` rather than raw protocol failures, and stale
    // tokens on disk are invalidated before interactive re-authorization runs.
    return { kind: "auth-required", invalidateTokens: true };
  }
  return null;
}

function classifyPreRetryFailure(
  input: ClassifyConnectFailureInput,
  error: Error,
): ConnectFailureAction | null {
  if (
    !input.corruptStateRecovered &&
    error instanceof McpError &&
    error.code === "config" &&
    /Corrupt OAuth state file/i.test(error.message)
  ) {
    // WHY: McpOAuthProvider._loadState() already backed up and removed the corrupt
    // state file before throwing this error. Log the warning and retry once immediately
    // without consuming retryCount so OAuth can proceed cleanly into AuthRequiredError.
    return { kind: "retry-corrupt-state" };
  }

  const oauthAction = classifyOAuthFailure(input, error);
  if (oauthAction) return oauthAction;

  if (error instanceof McpError && (error.code === "protocol" || error.code === "config")) {
    return { kind: "fail", error };
  }

  return null;
}

function classifyRetryOrGiveUp(
  input: ClassifyConnectFailureInput,
  error: Error,
): ConnectFailureAction {
  if (input.retryCount >= input.maxRetries) {
    const serverName = input.serverName ?? (error instanceof McpError ? error.server : "");
    const code = error instanceof McpError && error.code === "timeout" ? "timeout" : "connection";
    return {
      kind: "give-up",
      error: new McpError(
        `Connection failed after ${input.retryCount} retries: ${error.message}`,
        serverName,
        code,
        input.error,
      ),
    };
  }

  const delayMs = RETRY_DELAYS_MS[Math.min(input.retryCount, RETRY_DELAYS_MS.length - 1)] ?? 30000;
  return { kind: "retry", delayMs };
}

/**
 * Pure failure classifier for connection attempts.
 * Classifies failure into cancelled, retry-corrupt-state, auth-required, fail (fast-fail),
 * give-up (retries exhausted), or retry with a specific delay.
 */
export function classifyConnectFailure(input: ClassifyConnectFailureInput): ConnectFailureAction {
  if (input.aborted || input.error instanceof AuthCancelledError) {
    return { kind: "cancelled" };
  }

  const error = input.error instanceof Error ? input.error : new Error(String(input.error));
  const preRetryAction = classifyPreRetryFailure(input, error);
  if (preRetryAction) {
    return preRetryAction;
  }

  return classifyRetryOrGiveUp(input, error);
}
