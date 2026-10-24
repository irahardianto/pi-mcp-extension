/**
 * Pure diagnostic log formatting, field allow-listing, and secret redaction.
 *
 * Owns pure diagnostic log field allow-listing, secret redaction, error
 * classification, and JSON Lines entry construction/formatting. Kept pure
 * (no I/O, no filesystem, no process stderr/stdout) so it can be tested and
 * reasoned about in isolation.
 */

import { McpError } from "./errors.js";
import { sanitizeTerminalText } from "./terminal-text.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum length of a single logged string. */
export const DEBUG_LOG_MAX_TEXT_LENGTH = 300;

/** Maximum length of a server name in a log field. */
export const DEBUG_LOG_MAX_SERVER_LENGTH = 100;

export type DiagnosticLevel = "info" | "warn" | "error";

export type LogFieldValue = string | number | boolean;

export type LogFields = Record<string, LogFieldValue | undefined>;

/**
 * Field names that may be serialized. Anything else is dropped: an unknown
 * field is far more likely to carry a secret than anything useful.
 */
export const SAFE_FIELD_NAMES: readonly string[] = [
  "server",
  "from",
  "to",
  "transport",
  "lifecycle",
  "outcome",
  "reason",
  "phase",
  "trigger",
  "kind",
  "logLevel",
  "logger",
  "attempt",
  "retries",
  "delayMs",
  "ms",
  "count",
  "pages",
  "tools",
  "peerReloaded",
  "exitCode",
  "signal",
  "scope",
];

const SAFE_FIELD_NAME_SET = new Set(SAFE_FIELD_NAMES);

// ─── Redaction ────────────────────────────────────────────────────────────────

/** `access_token=…`, `"refresh_token":"…"`, `clientSecret: …`, `code_verifier=…`. */
const SECRET_KEY_PATTERN =
  /("?\b(?:access_token|accessToken|refresh_token|refreshToken|client_secret|clientSecret|code_verifier|codeVerifier|id_token|idToken|authorization_code|authorizationCode|registration_access_token)\b"?\s*[:=]\s*"?)[^"\s,;&}]*/gi;

/** `?code=…`, `&access_token=…` — query parameters of an OAuth redirect. */
const QUERY_SECRET_PATTERN =
  /([?&](?:code|code_verifier|codeVerifier|client_secret|access_token|refresh_token)=)[^&\s"']*/gi;

/** `Authorization: Bearer …` / `authorization=Basic …`. */
const AUTHORIZATION_PATTERN =
  /(\bauthorization\b\s*[:=]\s*)((?:bearer|basic|digest)\s+)[^\s,;"']*/gi;

/** A bare `Bearer <token>` anywhere in the text. */
const BEARER_PATTERN = /\b(bearer|basic)\s+[A-Za-z0-9\-._~+/=]{8,}/gi;

/**
 * Mask token-like substrings in an already sanitized string.
 *
 * This is the second safety net: the allow-list in {@link sanitizeLogFields}
 * is the primary defense, this only catches values that were passed under an
 * allowed field name or inside a free-form message.
 */
export function redactSecrets(text: string): string {
  let out = text;
  out = out.replace(SECRET_KEY_PATTERN, "$1[REDACTED]");
  out = out.replace(QUERY_SECRET_PATTERN, "$1[REDACTED]");
  out = out.replace(AUTHORIZATION_PATTERN, "$1$2[REDACTED]");
  out = out.replace(BEARER_PATTERN, "$1 [REDACTED]");
  return out;
}

/**
 * Make a string safe to store in the log: strip terminal escapes, bound the
 * length, and mask token-like substrings.
 */
export function sanitizeLogText(
  text: string,
  maxLength: number = DEBUG_LOG_MAX_TEXT_LENGTH,
): string {
  return redactSecrets(sanitizeTerminalText(text, { maxLength }));
}

/**
 * Keep only allow-listed field names, and sanitize the values of the ones
 * that are kept.
 */
export function sanitizeLogFields(fields: LogFields | undefined): Record<string, LogFieldValue> {
  const out: Record<string, LogFieldValue> = {};
  if (!fields) return out;
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELD_NAME_SET.has(key)) continue;
    if (value === undefined) continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      out[key] = value;
      continue;
    }
    if (typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    out[key] = sanitizeLogText(value);
  }
  return out;
}

/**
 * Describe an error for a log field: a stable kind plus a sanitized message.
 * Never logs the raw error object (it may carry tokens in its properties).
 */
export function describeError(err: unknown): { kind: string; message: string } {
  if (err instanceof McpError) {
    return { kind: err.code, message: sanitizeLogText(err.message) };
  }
  if (err instanceof Error) {
    return { kind: err.name || "error", message: sanitizeLogText(err.message) };
  }
  return { kind: "unknown", message: sanitizeLogText(String(err)) };
}

// ─── Log Entry ────────────────────────────────────────────────────────────────

export interface DebugLogEntry {
  ts: string;
  level: DiagnosticLevel;
  event: string;
  server?: string;
  message?: string;
  [key: string]: unknown;
}

export interface BuildLogEntryParams {
  ts: Date;
  level: DiagnosticLevel;
  event: string;
  server?: string | undefined;
  message?: string | undefined;
  fields?: LogFields | undefined;
}

/**
 * Build the JSON object for a single log event. Field values are sanitized
 * and unknown field names are dropped.
 */
export function buildLogEntry(params: BuildLogEntryParams): DebugLogEntry {
  const fields = sanitizeLogFields(params.fields);
  const entry: DebugLogEntry = {
    ts: params.ts.toISOString(),
    level: params.level,
    event: params.event,
  };
  if (params.server !== undefined && params.server !== "") {
    entry.server = sanitizeLogText(params.server, DEBUG_LOG_MAX_SERVER_LENGTH);
  }
  if (params.message !== undefined) {
    entry.message = sanitizeLogText(params.message);
  }
  for (const [key, value] of Object.entries(fields)) {
    if (key === "message") continue;
    entry[key] = value;
  }
  return entry;
}

/** Serialize a log entry as a single JSON Lines record (one line, no newline). */
export function formatLogLine(entry: DebugLogEntry): string {
  return `${JSON.stringify(entry)}\n`;
}
