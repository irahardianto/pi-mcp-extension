/**
 * Pure connection failure classification and retry policy for pi-mcp.
 *
 * Owns:
 *   - Pure OAuth 401/403 connect and tool error detection (`isOAuthUnauthorizedError`)
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
