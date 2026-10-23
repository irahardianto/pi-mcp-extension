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
import {
  buildLogEntry,
  formatLogLine,
  sanitizeLogText,
  type BuildLogEntryParams,
  type DiagnosticLevel,
  type LogFields,
} from "./debug-log-format.js";

export {
  buildLogEntry,
  DEBUG_LOG_MAX_SERVER_LENGTH,
  DEBUG_LOG_MAX_TEXT_LENGTH,
  describeError,
  formatLogLine,
  redactSecrets,
  SAFE_FIELD_NAMES,
  sanitizeLogFields,
  sanitizeLogText,
  type BuildLogEntryParams,
  type DebugLogEntry,
  type DiagnosticLevel,
  type LogFields,
  type LogFieldValue,
} from "./debug-log-format.js";

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
