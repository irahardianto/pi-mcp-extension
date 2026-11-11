/**
 * Pure delimiter-aware credential value redaction.
 *
 * Masks credential-shaped substrings — key/value and JSON secrets (including
 * compound names like `db_password` and `aws_secret_access_key`), server URL
 * query parameters, `Authorization` headers under any scheme, bare
 * `Bearer`/`Basic` tokens, and URL userinfo passwords — up to each value's own
 * delimiter. Kept zero-dependency so UI prompts, status renderers, child
 * stderr ring buffers, tool progress lines, and JSONL diagnostic logs share
 * one redactor without pulling in filesystem or logger I/O.
 */

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
 * `?code=…`, `&api_key=…`, `?token=…` — query parameters on a server URL. Matched as a
 * key/separator prefix so `maskCredentialValues` applies the same delimiter-aware value reader
 * as `SECRET_KEY_PATTERN` (preserving apostrophes inside a secret and stopping before closing
 * quotes, brackets, or the next `&name=` parameter).
 */
const QUERY_SECRET_PATTERN = new RegExp(
  String.raw`([?&](?:[A-Za-z0-9_.\-]*[_-])?(?:${QUERY_SECRET_NAME})=)`,
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
const URL_CREDENTIALS_PATTERN = /(https?:\/\/[^/\s?#@:"']+:)[^/\s?#@]+(@)/gi;

/**
 * Characters that end an unquoted credential value. Brackets (`()`, `{}`, `[]`), double quotes,
 * and backslash escapes (`\"`) terminate so a mask never swallows an enclosing JSON string or
 * bracketed clause.
 */
const UNQUOTED_VALUE_TERMINATORS = new Set([
  " ",
  "\t",
  "\n",
  "\r",
  "\f",
  "\v",
  ";",
  ",",
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  '"',
  "\\",
]);

/**
 * Characters that end an unquoted Authorization value. Whitespace is not a terminator: an
 * unknown scheme's value can contain spaces, and stopping at the first one would mask the
 * scheme token and leave the credential behind it in the log. Brackets and quotes still
 * terminate, so `(Authorization: ApiKey …) 401` and `[Authorization: Bearer …] 401` keep the
 * status code that follows the credential.
 */
const AUTHORIZATION_VALUE_TERMINATORS = new Set([
  "\n",
  "\r",
  ";",
  ",",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  '"',
  "\\",
]);

/** `&name=` — a query separator rather than part of an unquoted value. */
const QUERY_SEPARATOR_PATTERN = /&[A-Za-z0-9_.\-]+=/y;

/** Supported quote delimiters around a credential value, longest-first. */
const QUOTE_DELIMITERS: readonly string[] = ['\\"', "\\'", '"', "'"];

/** A credential value located in the text: where it ends and the delimiter to re-emit. */
interface CredentialValue {
  end: number;
  delimiter: string;
}

/**
 * Return the quote delimiter (`"`, `'`, `\"`, or `\'`) that opens at `index`, or `undefined`
 * when `index` does not start a quoted string.
 */
function openingQuoteAt(text: string, index: number): string | undefined {
  return QUOTE_DELIMITERS.find((quote) => text.startsWith(quote, index));
}

/**
 * A quoted value runs from its opening delimiter (`"`, `'`, `\"`, or `\'`) to the matching one,
 * or to the end of the text when unterminated. Backslash escapes inside the string are skipped.
 */
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
 * as one unit. Quoted strings (including JSON-escaped `\"...\"`) inside it are skipped, or a
 * bracket inside a string value would close the structure early and leave the rest of the secret
 * in the log.
 */
function readStructuredValue(text: string, start: number, opening: string): CredentialValue {
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const quote = openingQuoteAt(text, index);
    if (quote) {
      index = readQuotedValue(text, index, quote).end;
      continue;
    }
    const char = text.charAt(index);
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

const REDACTED_MASKS: readonly string[] = [
  "[REDACTED]",
  '"[REDACTED]"',
  "'[REDACTED]'",
  '\\"[REDACTED]\\"',
  "\\'[REDACTED]\\'",
];

const AUTH_SCHEME_NAMES: readonly string[] = [
  "bearer",
  "basic",
  "digest",
  "token",
  "apikey",
  "dpop",
  "oauth",
  "negotiate",
];

/**
 * True when `text.slice(start)` is an already-redacted mask (or known `Authorization` scheme
 * prefix) that post-redaction length capping sliced with a trailing `…` (`[REDACTED…`,
 * `"[RED…`, `Authorization: Bea…`, `token=…`). Skipping it keeps `redactSecrets` + truncation
 * idempotent without sparing any free secret characters.
 */
function isTruncatedRedactedTail(
  text: string,
  start: number,
  terminators: Set<string>,
): boolean {
  if (!text.endsWith("…")) return false;
  const body = text.slice(start, -1);
  if (REDACTED_MASKS.some((mask) => mask.startsWith(body))) return true;
  const lower = body.toLowerCase();
  return (
    terminators === AUTHORIZATION_VALUE_TERMINATORS &&
    AUTH_SCHEME_NAMES.some((scheme) => scheme.startsWith(lower))
  );
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
  if (isTruncatedRedactedTail(text, start, terminators)) return undefined;
  // An out-of-range start yields an empty opening and falls through to `readBareValue`, which
  // returns `undefined` for an empty value.
  const quote = openingQuoteAt(text, start);
  if (quote) return readQuotedValue(text, start, quote);
  const opening = text.charAt(start);
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
 * Mask credential-shaped substrings in diagnostic, status, and notification text.
 *
 * For structured JSONL debug logs, field allow-listing (`SAFE_FIELD_NAMES` in
 * `debug-log-format.ts`) is the primary defense; `redactSecrets` is the
 * delimiter-aware safety net for values inside allowed fields, error messages,
 * server instructions, progress updates, and child `stderr` lines.
 */
export function redactSecrets(text: string): string {
  let out = text;
  out = out.replace(URL_CREDENTIALS_PATTERN, "$1[REDACTED]$2");
  // WHY: `AUTHORIZATION_PATTERN` must run before `SECRET_KEY_PATTERN` because scheme names
  // like `ApiKey` and `Token` are also in `SECRET_KEY_NAME`; if a credential after
  // `Authorization: ApiKey ` starts with `=` or `:`, running `SECRET_KEY_PATTERN` first
  // would treat `ApiKey =…` as a key/value pair and leave a double `[REDACTED][REDACTED]`.
  out = maskCredentialValues(out, AUTHORIZATION_PATTERN, AUTHORIZATION_VALUE_TERMINATORS);
  out = maskCredentialValues(out, SECRET_KEY_PATTERN);
  out = maskCredentialValues(out, QUERY_SECRET_PATTERN);
  out = out.replace(BEARER_PATTERN, "$1 [REDACTED]");
  return out;
}
