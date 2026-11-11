/**
 * Pure diagnostic log formatting, field allow-listing, and error classification.
 *
 * Owns pure diagnostic log field allow-listing, log-text sanitization, error
 * classification, and JSON Lines entry construction/formatting. Kept pure
 * (no I/O, no filesystem, no process stderr/stdout) so it can be tested and
 * reasoned about in isolation.
 */

import { McpError } from "./errors.js";
import { redactSecrets } from "./secret-redaction.js";
import { sanitizeTerminalText } from "./terminal-text.js";

export { redactSecrets };

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

// ─── Sanitization ─────────────────────────────────────────────────────────────

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
 * Sanitize a single allow-listed field value.
 * Non-finite numbers and `undefined` are dropped (`undefined`) so they never
 * reach the log line.
 */
function sanitizeFieldValue(value: LogFieldValue | undefined): LogFieldValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") return value;
  return sanitizeLogText(value);
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
    const sanitized = sanitizeFieldValue(value);
    if (sanitized === undefined) continue;
    out[key] = sanitized;
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
