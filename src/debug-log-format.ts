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

/** Credential names that appear before `:`/`=` in JSON, key-value, or header text. */
const SECRET_KEY_NAME =
  "access[_-]?token|refresh[_-]?token|id[_-]?token|registration[_-]?access[_-]?token" +
  "|authorization[_-]?code|code[_-]?verifier|client[_-]?secret|x[_-]?api[_-]?key" +
  "|api[_-]?key|private[_-]?key|secret[_-]?key|secret[_-]?access[_-]?key" +
  "|password|passwd|secret|token";

/** Credential-bearing query parameters on a server URL. */
const QUERY_SECRET_NAME =
  "access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|code[_-]?verifier" +
  "|api[_-]?key|x[_-]?api[_-]?key|token|key|secret|password|passwd|auth(?:orization)?|code";

/** An optional quote — `"`, `'`, or the JSON-escaped form — around a key name. */
const QUOTE = String.raw`(?:\\?["'])?`;

/**
 * A credential key and its separator. A key may be a compound name (`db_password`,
 * `aws_secret_access_key`), so the leading boundary rejects only an alphanumeric
 * predecessor — `\b` also rejects `_` and would miss every prefixed name.
 *
 * The value is deliberately not part of the match: `maskCredentialValues` reads it from the
 * text so the mask can honour the value's own delimiter (see `readCredentialValue`).
 */
const SECRET_KEY_PATTERN = new RegExp(
  String.raw`(${QUOTE}(?<![A-Za-z0-9])(?:${SECRET_KEY_NAME})\b${QUOTE}\s*[:=]\s*)`,
  "gi",
);

/**
 * `?code=…`, `&api_key=…`, `?token=…` — query parameters on a server URL. The value needs at
 * least one character, so an empty parameter stays as it is and both this pattern and
 * `readCredentialValue` treat "nothing to mask" the same way.
 */
const QUERY_SECRET_PATTERN = new RegExp(
  String.raw`([?&](?:${QUERY_SECRET_NAME})=)[^&\s"']+`,
  "gi",
);

/**
 * `Authorization: Bearer …`, `authorization=Basic …`, `"Authorization":"Token …"`, and the
 * scheme-less `Authorization: …` form. A known scheme name is kept; any other leading token
 * is masked together with the value, because a scheme-less credential may contain spaces.
 */
const AUTHORIZATION_PATTERN = new RegExp(
  String.raw`(${QUOTE}(?<![A-Za-z0-9])authorization\b${QUOTE}\s*[:=]\s*(?:(?:bearer|basic|digest|token|apikey|dpop|oauth|negotiate)\s+)?)`,
  "gi",
);

/** A bare `Bearer <token>` anywhere in the text. */
const BEARER_PATTERN = /\b(bearer|basic)\s+[A-Za-z0-9\-._~+/=]{8,}/gi;

/** `https://user:password@mcp.example.com/mcp` — userinfo credentials in a URL. */
const URL_CREDENTIALS_PATTERN = /(https?:\/\/[^/\s:@]+:)[^/\s@]+(@)/gi;

/** Characters that end an unquoted credential value. Brackets are paired so a mask never
 * leaves an orphaned closing delimiter behind. */
const UNQUOTED_VALUE_TERMINATORS = new Set([" ", "\t", "\n", "\r", "\f", "\v", ";", ",", "{", "}", "(", ")"]);

/**
 * Characters that end an unquoted Authorization value. Whitespace is not a terminator: an
 * unknown scheme's value can contain spaces, and stopping at the first one would mask the
 * scheme token and leave the credential behind it in the log. Brackets still terminate, so
 * `(Authorization: ApiKey …) 401` keeps the status code that follows the credential.
 */
const AUTHORIZATION_VALUE_TERMINATORS = new Set(["\n", "\r", ";", ",", "(", ")", "{", "}"]);

/** `&name=` — a query separator rather than part of an unquoted value. */
const QUERY_SEPARATOR_PATTERN = /&[A-Za-z0-9_.\-]+=/y;

/** A credential value located in the text: where it ends and the delimiter to re-emit. */
interface CredentialValue {
  end: number;
  delimiter: string;
}

/**
 * Skip the quoted string that opens at `start`. Returns the index just past its closing quote,
 * or the end of the text when it is unterminated. Backslash escapes are skipped so a `\"` inside
 * the string cannot close it.
 */
function skipQuoted(text: string, start: number): number {
  const quote = text.charAt(start);
  let index = start + 1;
  while (index < text.length) {
    if (text.startsWith(quote, index)) return index + 1;
    index += text.charAt(index) === "\\" ? 2 : 1;
  }
  return text.length;
}

/** A quoted value runs from its opening delimiter to the matching one. */
function readQuotedValue(text: string, start: number, opening: string): CredentialValue {
  let index = start + opening.length;
  while (index < text.length) {
    if (text.startsWith(opening, index)) return { end: index + opening.length, delimiter: opening };
    index += text.charAt(index) === "\\" ? 2 : 1;
  }
  return { end: text.length, delimiter: opening };
}

/**
 * A `{`/`[` value runs to its matching bracket, so a nested credential object or array is masked
 * as one unit. Quoted strings inside it are skipped, or a bracket inside a string value would
 * close the structure early and leave the rest of the secret in the log.
 */
function readStructuredValue(text: string, start: number, opening: string): CredentialValue {
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '"' || char === "'") {
      index = skipQuoted(text, index);
      continue;
    }
    if (char === opening) {
      depth += 1;
    } else if (char === closing) {
      depth -= 1;
      if (depth === 0) return { end: index + 1, delimiter: "" };
    }
    index += 1;
  }
  return { end: text.length, delimiter: "" };
}

/** An unquoted value runs to the next separator; `undefined` when there is nothing to mask. */
function readBareValue(
  text: string,
  start: number,
  terminators: Set<string>,
): CredentialValue | undefined {
  let end = start;
  while (end < text.length) {
    const char = text.charAt(end);
    if (terminators.has(char)) break;
    if (char === "&") {
      QUERY_SEPARATOR_PATTERN.lastIndex = end;
      if (QUERY_SEPARATOR_PATTERN.test(text)) break;
    }
    end += 1;
  }
  return end > start ? { end, delimiter: "" } : undefined;
}

/**
 * Read the credential value that starts at `start`, honouring its opening delimiter: a quoted
 * value runs to its matching quote, a `{`/`[` value runs to its matching bracket, and an
 * unquoted value runs to the next separator. Returns `undefined` when there is no value to mask.
 */
function readCredentialValue(
  text: string,
  start: number,
  terminators: Set<string> = UNQUOTED_VALUE_TERMINATORS,
): CredentialValue | undefined {
  // An out-of-range start yields an empty opening and falls through to `readBareValue`, which
  // returns `undefined` for an empty value.
  const opening = text.charAt(start);
  if (opening === "\\" && (text.charAt(start + 1) === '"' || text.charAt(start + 1) === "'")) {
    return readQuotedValue(text, start, text.slice(start, start + 2));
  }
  if (opening === '"' || opening === "'") return readQuotedValue(text, start, opening);
  if (opening === "{" || opening === "[") return readStructuredValue(text, start, opening);
  return readBareValue(text, start, terminators);
}

/**
 * Mask every credential value that follows a key/separator prefix matched by `pattern`.
 *
 * WHY a hand-written scan instead of one regex replacement: the mask has to stop where the
 * value's delimiter says it stops. A single character class cannot tell an apostrophe inside an
 * unquoted secret (`it's …`) from the closing quote of a quoted one, and it cannot consume a
 * nested credential object (`{"token":{"value":"…"}}`) as one unit — both mistakes leave the
 * tail of the secret in the log.
 */
function maskCredentialValues(
  text: string,
  pattern: RegExp,
  terminators: Set<string> = UNQUOTED_VALUE_TERMINATORS,
): string {
  pattern.lastIndex = 0;
  let masked = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const prefix = match[0];
    const value = readCredentialValue(text, match.index + prefix.length, terminators);
    if (!value) continue;
    const mask = value.delimiter === "" ? "[REDACTED]" : `${value.delimiter}[REDACTED]${value.delimiter}`;
    masked += text.slice(cursor, match.index) + prefix + mask;
    cursor = value.end;
    pattern.lastIndex = value.end;
  }
  return cursor === 0 ? text : masked + text.slice(cursor);
}

/**
 * Mask token-like substrings in an already sanitized string.
 *
 * This is the second safety net: the allow-list in {@link sanitizeLogFields}
 * is the primary defense, this only catches values that were passed under an
 * allowed field name or inside a free-form message.
 */
export function redactSecrets(text: string): string {
  let out = text;
  out = out.replace(URL_CREDENTIALS_PATTERN, "$1[REDACTED]$2");
  out = maskCredentialValues(out, SECRET_KEY_PATTERN);
  out = maskCredentialValues(out, AUTHORIZATION_PATTERN, AUTHORIZATION_VALUE_TERMINATORS);
  out = out.replace(QUERY_SECRET_PATTERN, "$1[REDACTED]");
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
