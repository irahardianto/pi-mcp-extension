/**
 * Server lifecycle manager for pi-mcp.
 *
 * Manages MCP server connections using the official SDK.
 * Deliberately thin: the SDK handles protocol state, transport, and process lifecycle.
 * This module handles:
 *   - 3-state lifecycle per server (stopped / starting / ready)
 *   - Retry with a fixed delay schedule
 *   - roots/list capability for the MCP handshake
 *   - notifications/tools/list_changed → tool refresh callback
 *   - Stderr capture (circular buffer)
 *   - PID tracking for safety-net SIGKILL on shutdown failure
 */

import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ListRootsRequestSchema,
  ToolListChangedNotificationSchema,
  LoggingMessageNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpError, AuthCancelledError } from "./errors.js";
import type { McpConfig, ServerConfig, Settings } from "./config.js";
import { AuthRequiredError, getAuthStatus, resetAuth, invalidateStoredTokens } from "./oauth-provider.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { ToolRefreshOptions } from "./tool-bridge.js";
import { sanitizeTerminalText, type SanitizeTerminalTextOptions } from "./terminal-text.js";
import { describeError, reportDiagnostic } from "./debug-log.js";
import {
  ensurePidTerminated,
  instrumentStdioTransport,
} from "./stdio-process.js";
import { createTransport } from "./transport-factory.js";

export {
  type ToolRefreshOptions,
  AuthCancelledError,
  sanitizeTerminalText,
  type SanitizeTerminalTextOptions,
};


export function isOAuthUnauthorizedError(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || seen.has(error)) {
    return false;
  }
  if (typeof error === "object") {
    seen.add(error);
  }

  if (error instanceof AuthRequiredError || error instanceof UnauthorizedError) {
    return true;
  }

  if (error instanceof McpError) {
    // WHY: Tool-level application errors (`isError: true`) come from tool execution logic
    // (e.g. "found 401 items in database") and must never trigger MCP OAuth re-authentication.
    if (error.code === "tool") {
      return false;
    }
    if (error.cause !== undefined && isOAuthUnauthorizedError(error.cause, seen)) {
      return true;
    }
  }

  if (typeof error === "object") {
    const rec = error as { code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
    if (rec.cause !== undefined && isOAuthUnauthorizedError(rec.cause, seen)) {
      return true;
    }
    const numericCode =
      typeof rec.code === "number"
        ? rec.code
        : typeof rec.status === "number"
          ? rec.status
          : typeof rec.statusCode === "number"
            ? rec.statusCode
            : undefined;
    // WHY: Only treat 100..599 as HTTP status codes so negative JSON-RPC error codes
    // (e.g. -32000) still inspect the error message for wrapped HTTP 401/403 status text.
    if (numericCode !== undefined && numericCode >= 100 && numericCode <= 599) {
      if (numericCode === 401) return true;
      const msg = error instanceof Error ? error.message : String(error);
      if (numericCode === 403 && /\b(insufficient_scope|trying upscoping)\b/i.test(msg)) {
        return true;
      }
      return false;
    }
  }

  const msg = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!msg) return false;

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

  if (
    // nosemgrep: pi-mcp.no-401-substring -- WHY: intentional message-text fallback after structured checks for SDK paths that only surface text
    /^\s*401\s*$/.test(msg) ||
    // nosemgrep: pi-mcp.no-401-substring -- WHY: intentional message-text fallback after structured checks for SDK paths that only surface text
    /\bHTTP(?:\/\d(?:\.\d)?)?[:\s]+401\b/i.test(msg) ||
    // nosemgrep: pi-mcp.no-401-substring -- WHY: intentional message-text fallback after structured checks for SDK paths that only surface text
    /\bstatus(?:\s+code)?[:\s(]+401\b/i.test(msg) ||
    // nosemgrep: pi-mcp.no-401-substring -- WHY: intentional message-text fallback after structured checks for SDK paths that only surface text
    /\b(?:POSTing|GETting|connecting)\s+to\s+\S+:\s*401\b/i.test(msg) ||
    // nosemgrep: pi-mcp.no-401-substring -- WHY: intentional message-text fallback after structured checks for SDK paths that only surface text
    /\breturned\s+401\b/i.test(msg) ||
    // nosemgrep: pi-mcp.no-401-substring -- WHY: intentional message-text fallback after structured checks for SDK paths that only surface text
    /\b401\s+Unauthorized\b/i.test(msg) ||
    // nosemgrep: pi-mcp.no-401-substring -- WHY: intentional message-text fallback after structured checks for SDK paths that only surface text
    /\(401\)/.test(msg) ||
    /\binvalid_token\b/i.test(msg)
  ) {
    return true;
  }

  if (
    /\b(403|Forbidden)\b/i.test(msg) &&
    /\b(insufficient_scope|trying upscoping)\b/i.test(msg)
  ) {
    return true;
  }

  return false;
}

/**
 * Strip carriage returns, ANSI CSI/OSC/DCS/PM/APC escape sequences, and C0/C1
 * control characters from a single server stderr line before storing or logging.
 */
export function sanitizeStderrLine(line: string): string {
  return sanitizeTerminalText(line);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ServerState = "stopped" | "starting" | "ready";

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

  if (error instanceof McpError && (error.code === "protocol" || error.code === "config")) {
    return { kind: "fail", error };
  }

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

/** Maximum stderr lines stored per server (circular). */
const STDERR_BUFFER_SIZE = 100;

export interface ManagedServer {
  name: string;
  config: ServerConfig;
  state: ServerState;
  client: Client | null;
  transport?: Transport | undefined;
  cwd?: string | undefined;
  /** PID of the child process (stdio transport only). Used for safety-net cleanup. */
  childPid: number | null;
  retryCount: number;
  lastError: Error | null;
  /** Recent stderr lines from the server subprocess. */
  stderrLog: string[];
  healthCheckTimer: ReturnType<typeof setInterval> | null;
  /** Pending retry timeout — cleared on shutdown to prevent ghost reconnects. */
  retryTimer: ReturnType<typeof setTimeout> | null;
  attempt?: Promise<void> | undefined;
  controller?: AbortController | undefined;
  generation?: number;
  /** Timestamp of the last state transition — used for the debug log's `ms` field. */
  stateSince?: number | undefined;
}

/** Called after tool list is refreshed for a server (e.g. on list_changed notification). */
export type ToolRefreshCallback = (
  serverName: string,
  client: Client,
  options?: ToolRefreshOptions,
) => Promise<void>;

/** Called when background auto-recovery after a disconnect or health check fails. */
export type RecoveryFailedCallback = (serverName: string, error: Error) => void;

// ─── ServerManager ────────────────────────────────────────────────────────────

export class ServerManager {
  private readonly servers = new Map<string, ManagedServer>();
  private settings: Settings;
  private onToolRefresh: ToolRefreshCallback | null = null;
  private onServerStopped: ((name: string) => void) | null = null;
  private onRecoveryFailed: RecoveryFailedCallback | null = null;

  constructor(config: McpConfig, private readonly storageDir?: string) {
    this.settings = config.settings;
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      this.servers.set(name, {
        name,
        config: serverConfig,
        state: "stopped",
        client: null,
        childPid: null,
        retryCount: 0,
        lastError: null,
        stderrLog: [],
        healthCheckTimer: null,
        retryTimer: null,
        stateSince: Date.now(),
      });
    }
  }

  /** Register callback invoked after tool list changes for a server. */
  setToolRefreshCallback(cb: ToolRefreshCallback): void {
    this.onToolRefresh = cb;
  }

  setServerStoppedCallback(cb: (name: string) => void): void {
    this.onServerStopped = cb;
  }

  setRecoveryFailedCallback(cb: RecoveryFailedCallback): void {
    this.onRecoveryFailed = cb;
  }

  private _resolveTimeoutMs(server: ManagedServer): number {
    return server.config.requestTimeoutMs ?? this.settings.requestTimeoutMs;
  }

  /**
   * Move a server to a new lifecycle state and record the transition.
   *
   * The transition is reported to the debug log (never to stderr while a UI is
   * active) so maintainers can see when a server started, became ready, or
   * was torn down.
   */
  private _setState(server: ManagedServer, next: ServerState, reason?: string): void {
    const from = server.state;
    if (from === next) return;
    const now = Date.now();
    const ms = server.stateSince !== undefined ? now - server.stateSince : undefined;
    server.state = next;
    server.stateSince = now;
    reportDiagnostic({
      level: "info",
      event: "server.state",
      server: server.name,
      message: `Server ${server.name} state ${from} -> ${next}`,
      fields: { from, to: next, ms, reason },
    });
  }

  createTransport(name: string, config: ServerConfig, cwd?: string): Transport {
    return createTransport(name, config, cwd, this.storageDir, cwd);
  }

  getServer(name: string): ManagedServer | undefined {
    return this.servers.get(name);
  }

  getServerStatus(name: string): ManagedServer | undefined {
    return this.servers.get(name);
  }

  getAllServers(): ManagedServer[] {
    return Array.from(this.servers.values());
  }

  getReadyServers(): ManagedServer[] {
    return this.getAllServers().filter((s) => s.state === "ready");
  }

  private _updateServerCwd(server: ManagedServer, cwd: string): void {
    const prevCwd = server.cwd;
    server.cwd = cwd;
    if (prevCwd !== undefined && prevCwd !== cwd && server.state === "ready" && server.client) {
      void server.client.sendRootsListChanged().catch(() => {
        // WHY: Best-effort notification; some MCP servers ignore or do not support roots/list_changed.
      });
    }
  }

  /** Update workspace cwd for all managed servers and notify ready servers if cwd changed. */
  updateCwd(cwd: string): void {
    for (const server of this.servers.values()) {
      this._updateServerCwd(server, cwd);
    }
  }

  /** Status summary for /mcp command. */
  getStatusSummary(): string {
    const all = this.getAllServers();
    if (all.length === 0) return "pi-mcp: No servers configured (create ~/.pi/agent/mcp.json)";
    const lines = all.map((s) => {
      const icon = s.state === "ready" ? "✓" : s.state === "starting" ? "⟳" : "✗";
      const err = s.lastError ? ` — ${sanitizeTerminalText(s.lastError.message)}` : "";
      return `  ${icon} ${s.name} (${s.state})${err}`;
    });
    const ready = all.filter((s) => s.state === "ready").length;
    return [`MCP: ${ready}/${all.length} servers ready`, ...lines].join("\n");
  }

  /** Reset OAuth credentials for a server, forcing re-authorization on next connect. */
  async resetServerAuth(name: string): Promise<void> {
    await resetAuth(name, this.storageDir);
  }

  /** Get auth status for a server. */
  async getServerAuthStatus(name: string): Promise<{
    hasTokens: boolean;
    hasClientInfo: boolean;
    savedAt: string | undefined;
    scope: string | undefined;
  } | null> {
    const serverUrl = this.servers.get(name)?.config.url;
    return getAuthStatus(name, this.storageDir, serverUrl);
  }

  /**
    * Mark an OAuth server as requiring re-authorization when a mid-session
    * request (tools/list or tools/call) fails with 401/403 insufficient_scope.
    */
  async handleUnauthorizedServerError(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server || !server.config.auth || server.config.transport === "stdio") {
      return;
    }
    const authError = new AuthRequiredError(name);
    // WHY: Shut down immediately before async disk I/O so server.generation increments
    // synchronously and cancels any concurrent _recover() microtask queued by client.onerror.
    await this._shutdown(server);
    server.lastError = authError;
    await invalidateStoredTokens(name, this.storageDir, server.config.url);
    server.lastError = authError;
  }

  /** Get recent stderr output for a server. */
  getServerLogs(name: string): string {
    const server = this.servers.get(name);
    if (!server) return `No server named "${name}"`;
    if (server.stderrLog.length === 0) return `(no stderr output from ${name})`;
    return server.stderrLog.join("\n");
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Start a server and connect to it.
   * cwd is passed to roots/list — the workspace root exposed to the MCP server.
   */
  async startServer(name: string, cwd: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) {
      throw new McpError(`Unknown server "${name}"`, name, "config");
    }
    this._updateServerCwd(server, cwd);
    if (server.attempt && !server.controller?.signal.aborted) return server.attempt;
    if (server.state === "ready") return;
    server.retryCount = 0;
    const controller = new AbortController();
    server.controller = controller;
    this._setState(server, "starting");
    const attempt = this._connect(server, cwd, controller.signal);
    server.attempt = attempt;
    try {
      await attempt;
    } finally {
      if (server.attempt === attempt) {
        server.attempt = undefined;
      }
      if (server.controller === controller && (server.state as ServerState) !== "ready") {
        server.controller = undefined;
      }
    }
  }

  async stopServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) return;
    await this._shutdown(server);
  }

  async shutdownAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.servers.values()).map((s) => this._shutdown(s)),
    );
  }

  /** Add or replace a stopped server entry in the manager. */
  setServer(name: string, serverConfig: ServerConfig): void {
    this.servers.set(name, {
      name,
      config: serverConfig,
      state: "stopped",
      client: null,
      childPid: null,
      retryCount: 0,
      lastError: null,
      stderrLog: [],
      healthCheckTimer: null,
      retryTimer: null,
      stateSince: Date.now(),
    });
  }

  /** Shut down and remove a server entry from the manager. */
  async removeServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) return;
    await this._shutdown(server);
    this.servers.delete(name);
  }

  /**
   * Rebuild the server map from a new config.
   * Must only be called after shutdownAll() — old servers are discarded.
   * New servers that didn't exist before are added; servers removed from
   * config are dropped (their tools should already be deactivated).
   */
  rebuildServers(config: McpConfig): void {
    this.settings = config.settings;
    this.servers.clear();
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      this.setServer(name, serverConfig);
    }
  }

  /** Alias for rebuildServers when replacing configuration on session_start. */
  replaceConfig(config: McpConfig): void {
    this.rebuildServers(config);
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private async _connectWithTimeoutAndSignal(
    client: Client,
    transport: Transport,
    timeoutMs: number,
    signal: AbortSignal,
    serverName: string,
  ): Promise<void> {
    if (signal.aborted) {
      throw new AuthCancelledError(serverName);
    }

    const connectPromise = client.connect(transport, { timeout: timeoutMs, signal });
    // WHY: Attach a no-op catch handler so if the outer timeout or abort wins the race
    // while transport.start() is still in flight, a late rejection from connect() never
    // triggers an unhandledRejection.
    connectPromise.catch(() => {
      // WHY: Handled via Promise.race below.
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const raceOutcome = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new AuthCancelledError(serverName));
        return;
      }
      onAbort = () => {
        reject(new AuthCancelledError(serverName));
      };
      signal.addEventListener("abort", onAbort, { once: true });

      timer = setTimeout(() => {
        reject(
          new McpError(
            `Connection timed out after ${timeoutMs}ms`,
            serverName,
            "timeout",
          ),
        );
      }, timeoutMs);
    });

    try {
      await Promise.race([connectPromise, raceOutcome]);
    } catch (err) {
      if (signal.aborted || err instanceof AuthCancelledError) {
        throw err instanceof AuthCancelledError ? err : new AuthCancelledError(serverName);
      }
      if (
        !(err instanceof McpError) &&
        ((err as { code?: unknown })?.code === -32001 ||
          /Request timed out|timed out/i.test(err instanceof Error ? err.message : String(err)))
      ) {
        throw new McpError(
          `Connection timed out after ${timeoutMs}ms`,
          serverName,
          "timeout",
          err,
        );
      }
      throw err;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  private _appendStderr(server: ManagedServer, line: string): void {
    server.stderrLog.push(line);
    if (server.stderrLog.length > STDERR_BUFFER_SIZE) {
      server.stderrLog.shift();
    }
  }

  private _createAndInstrumentTransport(server: ManagedServer, cwd: string): Transport {
    let transport: Transport;
    try {
      transport = this.createTransport(server.name, server.config, cwd);
    } catch (err) {
      this._setState(server, "stopped", "transport");
      server.lastError = err instanceof Error ? err : new Error(String(err));
      throw new McpError(
        `Failed to create transport: ${server.lastError.message}`,
        server.name,
        "connection",
        err,
      );
    }

    if (transport instanceof StdioClientTransport) {
      instrumentStdioTransport(transport, {
        onPid: (pid) => {
          server.childPid = pid;
        },
        onStderrLine: (rawLine) => {
          const clean = sanitizeStderrLine(rawLine);
          if (!clean) return;
          this._appendStderr(server, clean);
          reportDiagnostic({
            level: "info",
            event: "server.stderr",
            server: server.name,
            message: clean,
            // WHY: child-server stderr historically went to stderr; keep it
            // visible in headless runs, where there is no /mcp ring buffer UI.
            stderr: true,
          });
        },
      });
    }

    return transport;
  }

  private _createClient(
    server: ManagedServer,
    cwd: string,
    signal: AbortSignal,
  ): Client {
    const client = new Client(
      { name: "pi-mcp", version: "1.0.0" },
      {
        capabilities: {
          // Expose workspace root to MCP servers
          roots: { listChanged: true },
          // Sampling: explicitly NOT declared — not supported in v1
        },
      },
    );

    // Handle roots/list requests from the server
    client.setRequestHandler(
      ListRootsRequestSchema,
      async () => {
        const effectiveCwd = server.cwd ?? cwd;
        return {
          roots: [
            {
              uri: pathToFileURL(effectiveCwd).href,
              name: basename(effectiveCwd) || "workspace",
            },
          ],
        };
      },
    );

    // tools/list_changed: re-discover tools and update Pi registrations
    client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        if (!signal.aborted && this.onToolRefresh && server.state === "ready" && server.client === client) {
          try {
            const refreshTimeoutMs = this._resolveTimeoutMs(server);
            await this.onToolRefresh(server.name, server.client, {
              requestTimeoutMs: refreshTimeoutMs,
              signal,
            });
          } catch (err) {
            const { kind, message } = describeError(err);
            reportDiagnostic({
              level: "error",
              event: "server.tools_refresh_failed",
              server: server.name,
              message: `Failed to refresh tools for ${server.name}: ${message}`,
              fields: { kind },
              notify: true,
            });
          }
        }
      },
    );

    // notifications/message: structured logging from MCP servers
    client.setNotificationHandler(
      LoggingMessageNotificationSchema,
      async (notification) => {
        const { level = "info", logger = server.name, data } = notification.params ?? {};
        const rawMsg = typeof data === "string" ? data : JSON.stringify(data);
        const safeLevel = sanitizeTerminalText(String(level), { maxLength: 32 });
        const safeLogger = sanitizeTerminalText(String(logger), { maxLength: 100 });
        const safeMsg = sanitizeTerminalText(rawMsg ?? "");
        reportDiagnostic({
          level: "info",
          event: "server.log",
          server: server.name,
          message: `[${safeLevel}] ${safeLogger}: ${safeMsg}`,
          fields: { logLevel: safeLevel, logger: safeLogger },
          // WHY: server log messages historically went to stderr; keep them
          // visible in headless runs, where there is no /mcp ring buffer UI.
          stderr: true,
        });
        this._appendStderr(server, `[${safeLevel}] ${safeLogger}: ${safeMsg}`);
      },
    );

    return client;
  }

  private async _handshakeAndDiscover(
    server: ManagedServer,
    client: Client,
    transport: Transport,
    timeoutMs: number,
    signal: AbortSignal,
    currentCwd: string,
  ): Promise<void> {
    await this._connectWithTimeoutAndSignal(client, transport, timeoutMs, signal, server.name);
    if (signal.aborted) throw new AuthCancelledError(server.name);
    if (transport instanceof StdioClientTransport && !server.childPid) {
      server.childPid = transport.pid;
    }
    // Readiness includes tool discovery, not just the MCP handshake.
    if (this.onToolRefresh) {
      await this.onToolRefresh(server.name, client, {
        requestTimeoutMs: timeoutMs,
        signal,
      });
    }
    if (signal.aborted) throw new AuthCancelledError(server.name);
    this._setState(server, "ready");
    server.retryCount = 0;
    server.lastError = null;
    if (server.cwd && server.cwd !== currentCwd) {
      void client.sendRootsListChanged().catch(() => {
        // WHY: Best-effort notification if cwd was updated while handshake was in flight.
      });
    }
  }

  private _startHealthCheck(
    server: ManagedServer,
    timeoutMs: number,
    signal: AbortSignal,
    cwd: string,
  ): void {
    if (!server.config.healthCheckIntervalMs) {
      return;
    }
    let pingInFlight = false;
    const runHealthCheck = async (): Promise<void> => {
      if (pingInFlight || server.state !== "ready" || !server.client || signal.aborted) {
        return;
      }
      pingInFlight = true;
      let pingTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const pingOptions = {
          timeout: timeoutMs,
          signal,
        };
        const pingCall = (
          server.client.ping as (
            opts?: { timeout?: number; signal?: AbortSignal },
            extraOpts?: { timeout?: number; signal?: AbortSignal },
          ) => Promise<unknown>
        )(pingOptions, pingOptions);
        pingCall.catch(() => {
          // WHY: Handled via Promise.race below.
        });
        await Promise.race([
          pingCall,
          new Promise<never>((_resolve, reject) => {
            pingTimer = setTimeout(
              () =>
                reject(
                  new McpError(
                    `Health check ping timed out after ${timeoutMs}ms`,
                    server.name,
                    "timeout",
                  ),
                ),
              timeoutMs,
            );
          }),
        ]);
      } catch {
        // WHY: Ping failure triggers background recovery if the server is still ready.
        // The ping error is intentionally not kept on lastError because _recover() →
        // _shutdown() synchronously resets lastError during teardown before any reader
        // observes it; if reconnection fails, _recover() records the failure on lastError.
        if (server.state === "ready" && !signal.aborted) {
          void this._recover(server, server.cwd ?? cwd);
        }
      } finally {
        if (pingTimer !== undefined) {
          clearTimeout(pingTimer);
        }
        pingInFlight = false;
      }
    };
    server.healthCheckTimer = setInterval(() => {
      void runHealthCheck();
    }, server.config.healthCheckIntervalMs);
  }

  private _wireDisconnectRecovery(
    server: ManagedServer,
    client: Client,
    signal: AbortSignal,
    cwd: string,
  ): void {
    // Unexpected transport close (e.g. the server subprocess crashes
    // mid-session). Without this the state would stay "ready" and tools
    // would remain active against a dead server. Deliberate closes abort
    // the signal first, so they are ignored here.
    client.onclose = () => {
      if (signal.aborted || server.client !== client) return;
      reportDiagnostic({
        level: "warn",
        event: "server.disconnected",
        server: server.name,
        message: `Server ${server.name} closed unexpectedly, reconnecting`,
        fields: { transport: server.config.transport },
      });
      void this._recover(server, server.cwd ?? cwd);
    };
    // WHY: SSEClientTransport and StreamableHTTPClientTransport report unexpected
    // stream drops via transport.onerror (forwarded to client.onerror) rather than
    // transport.onclose. Crucially, StreamableHTTPClientTransport.send() invokes
    // this.onerror(error) synchronously BEFORE `throw error` rejects the send()
    // promise; deferring _recover() via setImmediate lets Protocol.request() and
    // ToolBridge.execute() observe the original transport/401 error (and run
    // handleUnauthorizedServerError if applicable) before client.close() rejects
    // pending requests with "Connection closed".
    const scheduleErrorRecovery = () => {
      const errorGeneration = server.generation ?? 0;
      setImmediate(() => {
        if (
          (server.generation ?? 0) !== errorGeneration ||
          server.state !== "ready" ||
          signal.aborted ||
          server.client !== client
        ) {
          return;
        }
        void this._recover(server, server.cwd ?? cwd);
      });
    };
    client.onerror = (err) => {
      if (server.state !== "ready" || signal.aborted || server.client !== client) {
        return;
      }
      const rawMsg = err instanceof Error ? err.message : String(err);
      if (
        /unknown message ID|Received a response for an unknown message ID|notifications\/progress|unknown token/i.test(
          rawMsg,
        )
      ) {
        return;
      }
      const msg = sanitizeTerminalText(rawMsg);
      if (server.config.transport === "sse") {
        reportDiagnostic({
          level: "warn",
          event: "server.stream_error",
          server: server.name,
          message: `Server ${server.name} SSE stream error, reconnecting: ${msg}`,
          fields: { transport: "sse" },
        });
        scheduleErrorRecovery();
        return;
      }
      if (server.config.transport === "streamable-http") {
        if (isOAuthUnauthorizedError(err)) {
          reportDiagnostic({
            level: "warn",
            event: "server.auth_error",
            server: server.name,
            message: `Server ${server.name} HTTP auth error, recovering: ${msg}`,
            fields: { transport: "streamable-http" },
          });
          scheduleErrorRecovery();
          return;
        }
        // WHY: After notifications/initialized, the SDK fires an unawaited optional GET probe
        // (_startOrAuthSse) to open a standalone SSE stream. The SDK already ignores HTTP 405,
        // so a non-auth "Failed to open SSE stream: ..." error here means a POST-only HTTP
        // server returned a non-405 status (e.g. 404 Not Found, 400 Bad Request, 501 Not Implemented)
        // on GET. Ignore it so POST-only servers do not enter a spurious recovery loop; genuine
        // stream drops on established streams report "SSE stream disconnected" or
        // "Maximum reconnection attempts (0) exceeded." instead.
        if (/Failed to open SSE stream:/i.test(rawMsg)) {
          return;
        }
        reportDiagnostic({
          level: "warn",
          event: "server.stream_error",
          server: server.name,
          message: `Server ${server.name} HTTP stream error, reconnecting: ${msg}`,
          fields: { transport: "streamable-http" },
        });
        scheduleErrorRecovery();
      }
    };
  }

  private async _cleanupFailedConnect(
    server: ManagedServer,
    client: Client,
    transport: Transport,
  ): Promise<void> {
    const pid =
      server.childPid ??
      (transport as unknown as { _process?: { pid?: number } })?._process?.pid ??
      (transport instanceof StdioClientTransport ? transport.pid : null);
    server.childPid = null;
    await Promise.allSettled([
      client.close(),
      ensurePidTerminated(pid),
    ]);
    // WHY: Secondary safety check to guarantee PID termination even if transport.close()
    // or child process exit raced during the initial Promise.allSettled.
    await ensurePidTerminated(pid);
    if (server.client === client) {
      server.client = null;
      server.transport = undefined;
    }
  }

  private async _waitRetry(
    server: ManagedServer,
    signal: AbortSignal,
    delayMs: number,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const onAbort = () => {
        if (server.retryTimer) {
          clearTimeout(server.retryTimer);
          server.retryTimer = null;
        }
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        server.retryTimer = null;
        resolve();
      }, delayMs);
      server.retryTimer = timer;
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async _connect(
    server: ManagedServer,
    cwd: string,
    signal: AbortSignal,
    corruptStateRecovered = false,
  ): Promise<void> {
    server.lastError = null;
    const currentCwd = server.cwd ?? cwd;
    server.cwd = currentCwd;
    const timeoutMs = this._resolveTimeoutMs(server);
    // Note: retryCount is NOT reset here — it's only reset after successful connect.
    // This ensures the retry limit is respected across reconnection attempts.
    // It IS reset when startServer() is called explicitly (e.g. /mcp:start)
    // via the caller having already set retryCount = 0 before calling _connect.

    const transport = this._createAndInstrumentTransport(server, currentCwd);
    server.transport = transport;

    const client = this._createClient(server, cwd, signal);
    server.client = client;

    try {
      await this._handshakeAndDiscover(server, client, transport, timeoutMs, signal, currentCwd);
      this._startHealthCheck(server, timeoutMs, signal, cwd);
      this._wireDisconnectRecovery(server, client, signal, cwd);
    } catch (err) {
      await this._cleanupFailedConnect(server, client, transport);

      const action = classifyConnectFailure({
        error: err,
        aborted: signal.aborted,
        corruptStateRecovered,
        hasAuth: Boolean(server.config.auth),
        transport: server.config.transport,
        retryCount: server.retryCount,
        maxRetries: this.settings.maxRetries,
        serverName: server.name,
      });

      const error = err instanceof Error ? err : new Error(String(err));
      const { kind: errorKind, message: errorMessage } = describeError(err);

      reportDiagnostic({
        level: action.kind === "cancelled" ? "info" : "warn",
        event: "server.connect_failure",
        server: server.name,
        message: `Connection attempt for ${server.name} failed: ${errorMessage}`,
        fields: { outcome: action.kind, kind: errorKind, attempt: server.retryCount },
      });

      switch (action.kind) {
        case "cancelled":
          throw err instanceof AuthCancelledError ? err : new AuthCancelledError(server.name);
        case "retry-corrupt-state": {
          reportDiagnostic({
            level: "warn",
            event: "oauth.state_corrupt",
            server: server.name,
            message: errorMessage,
            fields: { kind: errorKind },
          });
          if (signal.aborted) throw new AuthCancelledError(server.name);
          return this._connect(server, server.cwd ?? cwd, signal, true);
        }
        case "auth-required": {
          server.lastError = error;
          if (action.invalidateTokens) {
            await invalidateStoredTokens(server.name, this.storageDir, server.config.url);
          }
          const authError = err instanceof AuthRequiredError ? err : new AuthRequiredError(server.name);
          server.lastError = authError;
          this._setState(server, "stopped", "auth-required");
          throw authError;
        }
        case "fail":
          server.lastError = action.error;
          this._setState(server, "stopped", "failed");
          throw action.error;
        case "give-up":
          server.lastError = error;
          this._setState(server, "stopped", "give-up");
          throw action.error;
        case "retry": {
          server.lastError = error;
          server.retryCount++;
          reportDiagnostic({
            level: "warn",
            event: "server.retry",
            server: server.name,
            message: `Retrying ${server.name} in ${action.delayMs}ms (attempt ${server.retryCount})`,
            fields: { attempt: server.retryCount, delayMs: action.delayMs },
          });
          await this._waitRetry(server, signal, action.delayMs);
          if (signal.aborted) throw new AuthCancelledError(server.name);
          return this._connect(server, server.cwd ?? cwd, signal, corruptStateRecovered);
        }
      }
    }
  }


  /** Tear down a server that died or stopped responding, then reconnect. */
  private async _recover(server: ManagedServer, cwd: string): Promise<void> {
    const recoveryGeneration = (server.generation ?? 0) + 1;
    await this._shutdown(server);
    if (server.generation === recoveryGeneration) {
      // An external stop during cleanup increments the generation again.
      queueMicrotask(() => {
        if (server.generation !== recoveryGeneration) return;
        void this.startServer(server.name, cwd).catch((err) => {
          if (err instanceof AuthCancelledError) return;
          const error = err instanceof Error ? err : new Error(String(err));
          server.lastError = error;
          const { kind, message } = describeError(err);
          reportDiagnostic({
            level: "error",
            event: "server.recovery_failed",
            server: server.name,
            message: `Background recovery failed for ${server.name}: ${message}`,
            fields: { kind },
          });
          this.onRecoveryFailed?.(server.name, error);
        });
      });
    }
  }

  private async _shutdown(server: ManagedServer): Promise<void> {
    server.controller?.abort();
    server.controller = undefined;
    server.attempt = undefined;
    server.generation = (server.generation ?? 0) + 1;

    // Cancel pending retry
    if (server.retryTimer) {
      clearTimeout(server.retryTimer);
      server.retryTimer = null;
    }

    // Stop health check
    if (server.healthCheckTimer) {
      clearInterval(server.healthCheckTimer);
      server.healthCheckTimer = null;
    }

    this._setState(server, "stopped", "shutdown");
    server.lastError = null;
    this.onServerStopped?.(server.name);
    const client = server.client;
    const pid =
      server.childPid ??
      (server.transport as unknown as { _process?: { pid?: number } })?._process?.pid ??
      null;
    server.client = null;
    server.transport = undefined;
    server.childPid = null;

    await Promise.allSettled([
      client?.close(),
      ensurePidTerminated(pid),
    ]);
    await ensurePidTerminated(pid);
  }
}

