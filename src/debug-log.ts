/**
 * Opt-in diagnostic log for pi-mcp.
 *
 * Two related responsibilities:
 *
 *  1. `DebugLog` — a redacting, size-capped JSON Lines log file written to
 *     `<agentDir>/logs/pi-mcp.log`, enabled with `PI_MCP_DEBUG=1`. Writes are
 *     best-effort and never block or break a connection or tool call.
 *  2. `reportDiagnostic` — the process-wide sink that replaces the extension's
 *     `console.error` calls. While a UI is active nothing is written to Pi's
 *     stderr (the TUI owns that stream); user-actionable events are surfaced
 *     through `ctx.ui.notify(...)` instead. Without a UI (bootstrap before
 *     `session_start`, headless runs) warn/error events (and info events
 *     flagged `stderr: true`, such as child-server output) use stderr; other
 *     info-level telemetry is log-file only, so headless stderr keeps exactly
 *     the output it had before this sink existed.
 *
 * Redaction is allow-list first — only known-safe field names are serialized —
 * and pattern-based second, as a safety net for values that were passed by
 * mistake.
 */

import { appendFile, chmod, mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { McpError } from "./errors.js";
import { sanitizeTerminalText } from "./terminal-text.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Environment variable that turns the debug log on. */
export const DEBUG_LOG_ENV_VAR = "PI_MCP_DEBUG";

/** Log file name inside the log directory. */
export const DEBUG_LOG_FILE_NAME = "pi-mcp.log";

/** Name of the single rotated backup kept next to the log file. */
export const DEBUG_LOG_ROTATED_FILE_NAME = "pi-mcp.log.1";

/** Maximum size of the log file before it is rotated (~2 MB). */
export const DEBUG_LOG_MAX_BYTES = 2 * 1024 * 1024;

/** Permissions of the log directory — same as the credential directories. */
export const DEBUG_LOG_DIR_MODE = 0o700;

/** Permissions of the log file — same as the credential files. */
export const DEBUG_LOG_FILE_MODE = 0o600;

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

// ─── File Logger ──────────────────────────────────────────────────────────────

export interface DebugLogFs {
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
  appendFile(path: string, data: string, options?: { mode?: number }): Promise<void>;
  stat(path: string): Promise<{ size: number }>;
  rename(oldPath: string, newPath: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface DebugLogDeps {
  fs: DebugLogFs;
  now: () => Date;
}

export function createDefaultDebugLogDeps(): DebugLogDeps {
  return {
    fs: {
      mkdir: (path, options) => mkdir(path, options),
      appendFile: (path, data, options) => appendFile(path, data, options),
      stat: (path) => stat(path),
      rename: (oldPath, newPath) => rename(oldPath, newPath),
      chmod: (path, mode) => chmod(path, mode),
      unlink: (path) => unlink(path),
    },
    now: () => new Date(),
  };
}

/** True when `PI_MCP_DEBUG` asks for the debug log. */
export function isDebugLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DEBUG_LOG_ENV_VAR];
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * A size-capped JSON Lines log file.
 *
 * Writes are queued and executed in order, but never awaited by the caller:
 * a logging failure must not break a connection or a tool call.
 */
export class DebugLog {
  readonly dir: string;
  readonly filePath: string;
  readonly rotatedFilePath: string;
  private readonly deps: DebugLogDeps;
  private queue: Promise<void> = Promise.resolve();
  private dirReady = false;
  private fileModeEnsured = false;

  constructor(dir: string, deps?: Partial<DebugLogDeps>) {
    this.dir = dir;
    this.filePath = join(dir, DEBUG_LOG_FILE_NAME);
    this.rotatedFilePath = join(dir, DEBUG_LOG_ROTATED_FILE_NAME);
    this.deps = { ...createDefaultDebugLogDeps(), ...deps };
  }

  /** Queue one event. Never throws, never blocks the caller. */
  write(params: Omit<BuildLogEntryParams, "ts"> & { ts?: Date | undefined }): void {
    const line = formatLogLine(
      buildLogEntry({ ...params, ts: params.ts ?? this.deps.now() }),
    );
    this.queue = this.queue
      .then(() => this._append(line))
      .catch((err: unknown) => {
        reportLoggerFailure(err);
      });
  }

  /** Wait for all queued writes to settle. Used by tests and on shutdown. */
  async flush(): Promise<void> {
    await this.queue;
  }

  private async _append(line: string): Promise<void> {
    const fs = this.deps.fs;
    if (!this.dirReady) {
      await fs.mkdir(this.dir, { recursive: true, mode: DEBUG_LOG_DIR_MODE });
      await fs.chmod(this.dir, DEBUG_LOG_DIR_MODE);
      this.dirReady = true;
    }
    await this._rotateIfNeeded(Buffer.byteLength(line, "utf8"));
    await fs.appendFile(this.filePath, line, { mode: DEBUG_LOG_FILE_MODE });
    if (!this.fileModeEnsured) {
      // WHY: `mode` only applies when the file is created; an existing file may
      // have looser permissions, so the mode is enforced once per logger.
      await fs.chmod(this.filePath, DEBUG_LOG_FILE_MODE);
      this.fileModeEnsured = true;
    }
  }

  private async _rotateIfNeeded(incomingBytes: number): Promise<void> {
    const fs = this.deps.fs;
    let size = 0;
    try {
      size = (await fs.stat(this.filePath)).size;
    } catch {
      // WHY: The log file does not exist yet — there is nothing to rotate.
      return;
    }
    if (size <= 0 || size + incomingBytes <= DEBUG_LOG_MAX_BYTES) return;
    await fs.unlink(this.rotatedFilePath).catch(() => {
      // WHY: No previous backup to remove — the rename below creates the only one.
    });
    await fs.rename(this.filePath, this.rotatedFilePath);
  }
}

// ─── Diagnostic Sink ──────────────────────────────────────────────────────────

export interface Diagnostic {
  level: DiagnosticLevel;
  /** Machine-readable event id, e.g. `server.state`. */
  event: string;
  /** Human-readable summary. */
  message: string;
  server?: string | undefined;
  fields?: LogFields | undefined;
  /** Surface the event in the Pi UI when no log file is available. */
  notify?: boolean | undefined;
  /**
   * Also write to stderr in headless mode (no UI) even for info-level events —
   * for output that historically went to stderr, such as child-server logs.
   * warn/error events always reach stderr when no UI is active.
   */
  stderr?: boolean | undefined;
}

export interface DiagnosticNotifier {
  notify(message: string, level: "info" | "warning" | "error"): void;
}

let activeLogger: DebugLog | null = null;
let activeNotifier: DiagnosticNotifier | null = null;
let uiActive = false;
let loggerFailureReported = false;

/** Install (or clear) the debug log file writer. */
export function setDebugLog(logger: DebugLog | null): void {
  activeLogger = logger;
  loggerFailureReported = false;
}

export function getDebugLog(): DebugLog | null {
  return activeLogger;
}

/**
 * Tell the sink whether a UI is active.
 *
 * `hasUI` mirrors `ExtensionContext.hasUI`: while it is true, nothing is ever
 * written to Pi's stderr.
 */
export function setDiagnosticUi(notifier: DiagnosticNotifier | null, hasUI: boolean): void {
  activeNotifier = notifier;
  uiActive = hasUI && notifier !== null;
}

export function isUiActive(): boolean {
  return uiActive;
}

/**
 * Report a diagnostic event.
 *
 * - With a debug log: the event is written to the log file.
 * - Without a debug log and with an active UI: the event is dropped, or
 *   surfaced through `ctx.ui.notify(...)` when it is user-actionable.
 * - Without a UI: warn/error events (and info events flagged `stderr`) go to
 *   stderr. Other info-level telemetry is log-file only, so headless stderr
 *   keeps exactly the output it had before this sink existed.
 */
export function reportDiagnostic(diagnostic: Diagnostic): void {
  const message = sanitizeLogText(diagnostic.message, 500);

  if (activeLogger) {
    activeLogger.write({
      level: diagnostic.level,
      event: diagnostic.event,
      server: diagnostic.server,
      message,
      fields: diagnostic.fields,
    });
  }

  if (uiActive) {
    if (diagnostic.notify && activeNotifier) {
      const level = diagnostic.level === "warn" ? "warning" : diagnostic.level;
      activeNotifier.notify(`pi-mcp: ${message}`, level);
    }
    return;
  }

  // WHY: info-level telemetry (state transitions, token refresh, session
  // lifecycle) would be new noise on headless stderr — before the sink these
  // events did not exist. Only warn/error events and info events flagged
  // `stderr` (child-server output, the headless OAuth URL fallback) reach it.
  if (diagnostic.level === "info" && diagnostic.stderr !== true) return;

  console.error(`[pi-mcp] ${message}`);
}

/**
 * Report a failure of the log writer itself. A broken log must never break a
 * connection, so the failure is reported once and then ignored.
 */
function reportLoggerFailure(err: unknown): void {
  if (loggerFailureReported) return;
  loggerFailureReported = true;
  if (uiActive) {
    // WHY: While a UI is active, stderr belongs to the TUI. The failed log write
    // is silently ignored — logging must never break a connection or a tool call.
    return;
  }
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[pi-mcp] Debug log write failed: ${sanitizeLogText(detail, 200)}`);
}
