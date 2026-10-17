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
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ListRootsRequestSchema,
  ToolListChangedNotificationSchema,
  LoggingMessageNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpError, AuthCancelledError } from "./errors.js";
import type { McpConfig, ServerConfig, Settings } from "./config.js";
import { McpOAuthProvider, AuthRequiredError, getAuthStatus, resetAuth, invalidateStoredTokens } from "./oauth-provider.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  setClientDefaultOptions,
  getClientDefaultOptions,
  type ToolRefreshOptions,
} from "./tool-bridge.js";

export { setClientDefaultOptions, getClientDefaultOptions, type ToolRefreshOptions, AuthCancelledError };


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
    /\b(?:HTTP\s+|status(?:\s+code)?[:\s]+|(?:POSTing|GETting|connecting)\s+to\s+\S+:\s*|(?:Non-200\s+status\s+code\s*\())(\d{3})\b/i,
  );
  if (httpStatusMatch) {
    const status = Number(httpStatusMatch[1]);
    if (status !== 401 && status !== 403) {
      return false;
    }
  }

  if (
    /^\s*401\s*$/.test(msg) ||
    /\bHTTP\s+401\b/i.test(msg) ||
    /\bstatus(?:\s+code)?[:\s(]+401\b/i.test(msg) ||
    /\breturned\s+401\b/i.test(msg) ||
    /\b401\s+Unauthorized\b/i.test(msg) ||
    /:\s*401\b/.test(msg) ||
    /\(401\)/.test(msg) ||
    /\bUnauthorized\b/i.test(msg) ||
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
  return line
    .replace(/\r$/, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P^_][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\x1b|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function resolveEnv(extra?: Record<string, string>): Record<string, string> {
  // Build clean env: process.env may contain undefined values,
  // child_process.spawn silently drops them, but let's be explicit
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (extra) {
    Object.assign(env, extra);
  }
  return env;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ServerState = "stopped" | "starting" | "ready";

/** Fixed retry delay schedule — predictable, no jitter math needed. */
const RETRY_DELAYS_MS = [1000, 3000, 5000, 10000, 30000] as const;

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
}

/** Called after tool list is refreshed for a server (e.g. on list_changed notification). */
export type ToolRefreshCallback = (
  serverName: string,
  client: Client,
  options?: ToolRefreshOptions,
) => Promise<void>;

/** Called when background auto-recovery after a disconnect or health check fails. */
export type RecoveryFailedCallback = (serverName: string, error: Error) => void;

export interface TransportAuthCallbacks {
  /** Legacy callback type. Background transport attempts never invoke this callback. */
  onAuthRequired: (serverName: string, authorizationUrl: URL) => void | Promise<void>;
}

// ─── Transport Factory ────────────────────────────────────────────────────────

export function createTransport(
  serverName: string,
  config: ServerConfig,
  cwdOrOnStderr?: string | ((line: string) => void),
  storageDir?: string,
  cwdArg?: string,
): Transport {
  const cwd = typeof cwdOrOnStderr === "string" ? cwdOrOnStderr : cwdArg;
  const onStderr = typeof cwdOrOnStderr === "function" ? cwdOrOnStderr : undefined;

  // Build requestInit for static headers (API keys, etc.)
  const requestInit: RequestInit | undefined = config.headers
    ? { headers: config.headers }
    : undefined;

  // Build OAuth authProvider if auth config is present
  let authProvider: OAuthClientProvider | undefined;
  if (config.auth && config.transport !== "stdio") {
    // Silent transport attempts must not write PKCE or launch a browser.
    authProvider = new McpOAuthProvider(
      serverName,
      config.auth,
      undefined,
      storageDir,
      true,
      undefined,
      undefined,
      config.url,
    );
  }

  switch (config.transport) {
    case "stdio": {
      if (!config.command) {
        throw new McpError("stdio transport requires 'command'", serverName, "config");
      }
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: resolveEnv(config.env),
        ...(cwd !== undefined ? { cwd } : {}),
        stderr: "pipe",
      });
      if (onStderr && transport.stderr) {
        const decoder = new StringDecoder("utf8");
        let remainder = "";
        let flushed = false;
        transport.stderr.on("data", (chunk: Buffer) => {
          remainder += decoder.write(chunk);
          const lines = remainder.split("\n");
          remainder = lines.pop() ?? "";
          for (const rawLine of lines) {
            const clean = sanitizeStderrLine(rawLine);
            if (clean) onStderr(clean);
          }
        });
        const flush = (): void => {
          if (flushed) return;
          flushed = true;
          remainder += decoder.end();
          if (remainder) {
            const clean = sanitizeStderrLine(remainder);
            remainder = "";
            if (clean) onStderr(clean);
          }
        };
        transport.stderr.on("end", flush);
        transport.stderr.on("close", flush);
      }
      return transport;
    }
    case "streamable-http":
      return new StreamableHTTPClientTransport(
        new URL(config.url!),
        {
          ...(requestInit && { requestInit }),
          ...(authProvider && { authProvider }),
          // WHY: Disable internal SDK SSE stream retries so unexpected disconnects
          // immediately surface to ServerManager._recover() for deterministic backoff.
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 0,
            maxReconnectionDelay: 0,
            reconnectionDelayGrowFactor: 1,
          },
        },
      ) as unknown as Transport;
    case "sse": {
      const transport = new SSEClientTransport(
        new URL(config.url!),
        {
          ...(requestInit && { requestInit }),
          ...(authProvider && { authProvider }),
        },
      );
      // WHY: SSEClientTransport.start() awaits the initial `event: endpoint` SSE frame,
      // while SSEClientTransport.close() aborts _abortController and closes _eventSource
      // without firing _eventSource.onerror, leaving start() pending forever (which would
      // deadlock `await client.close()`). Wrap start() and close() so closing the transport
      // immediately rejects any pending start() promise.
      const origStart = transport.start.bind(transport);
      const origClose = transport.close.bind(transport);
      let rejectPendingStart: ((err: Error) => void) | null = null;
      transport.start = () =>
        new Promise<void>((resolve, reject) => {
          rejectPendingStart = reject;
          origStart().then(
            () => {
              rejectPendingStart = null;
              resolve();
            },
            (err) => {
              rejectPendingStart = null;
              reject(err);
            },
          );
        });
      transport.close = async () => {
        if (rejectPendingStart) {
          const reject = rejectPendingStart;
          rejectPendingStart = null;
          reject(new Error("SSE transport closed before endpoint event"));
        }
        await origClose();
      };
      return transport;
    }
  }
}

// ─── ServerManager ────────────────────────────────────────────────────────────

export class ServerManager {
  private readonly servers = new Map<string, ManagedServer>();
  private settings: Settings;
  private onToolRefresh: ToolRefreshCallback | null = null;
  private onServerStopped: ((name: string) => void) | null = null;
  private onRecoveryFailed: RecoveryFailedCallback | null = null;

  constructor(config: McpConfig, _authCallbacks?: TransportAuthCallbacks, private readonly storageDir?: string) {
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

  createTransport(name: string, config: ServerConfig, cwd?: string): Transport {
    return createTransport(name, config, cwd, this.storageDir, cwd);
  }

  getServer(name: string): ManagedServer | undefined {
    return this.servers.get(name);
  }

  getAllServers(): ManagedServer[] {
    return Array.from(this.servers.values());
  }

  getReadyServers(): ManagedServer[] {
    return this.getAllServers().filter((s) => s.state === "ready");
  }

  /** Status summary for /mcp command. */
  getStatusSummary(): string {
    const all = this.getAllServers();
    if (all.length === 0) return "pi-mcp: No servers configured (create ~/.pi/agent/mcp.json)";
    const lines = all.map((s) => {
      const icon = s.state === "ready" ? "✓" : s.state === "starting" ? "⟳" : "✗";
      const err = s.lastError ? ` — ${s.lastError.message}` : "";
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
  async handleUnauthorizedServerError(name: string, _cause?: unknown): Promise<void> {
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
    server.cwd = cwd;
    if (server.attempt && !server.controller?.signal.aborted) return server.attempt;
    if (server.state === "ready") return;
    server.retryCount = 0;
    const controller = new AbortController();
    server.controller = controller;
    server.state = "starting";
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

  private _isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        return false;
      }
      return true;
    }
  }

  private async _ensurePidTerminated(pid: number | null | undefined): Promise<void> {
    if (!pid || !this._isPidAlive(pid)) {
      return;
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
    }

    const sigtermDeadline = Date.now() + 500;
    while (Date.now() < sigtermDeadline) {
      if (!this._isPidAlive(pid)) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    if (!this._isPidAlive(pid)) {
      return;
    }

    try {
      process.kill(pid, "SIGKILL");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
    }

    const sigkillDeadline = Date.now() + 200;
    while (Date.now() < sigkillDeadline) {
      if (!this._isPidAlive(pid)) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  private async _connect(
    server: ManagedServer,
    cwd: string,
    signal: AbortSignal,
    corruptStateRecovered = false,
  ): Promise<void> {
    server.lastError = null;
    server.cwd = cwd;
    const timeoutMs = this._resolveTimeoutMs(server);
    // Note: retryCount is NOT reset here — it's only reset after successful connect.
    // This ensures the retry limit is respected across reconnection attempts.
    // It IS reset when startServer() is called explicitly (e.g. /mcp:start)
    // via the caller having already set retryCount = 0 before calling _connect.

    const appendStderr = (line: string): void => {
      server.stderrLog.push(line);
      if (server.stderrLog.length > STDERR_BUFFER_SIZE) {
        server.stderrLog.shift();
      }
    };

    let transport: Transport;
    try {
      transport = this.createTransport(server.name, server.config, cwd);
    } catch (err) {
      server.state = "stopped";
      server.lastError = err instanceof Error ? err : new Error(String(err));
      throw new McpError(
        `Failed to create transport: ${server.lastError.message}`,
        server.name,
        "connection",
        err,
      );
    }

    server.transport = transport;

    if (transport instanceof StdioClientTransport) {
      // WHY: Capture child PID immediately when StdioClientTransport spawns the process
      // (before `initialize` is sent), so a timeout or cancellation during `initialize`
      // can still terminate the child process deterministically before retrying.
      const origStart = transport.start.bind(transport);
      transport.start = async () => {
        const startPromise = origStart();
        const earlyProc = (transport as unknown as { _process?: { pid?: number } })._process;
        if (earlyProc?.pid) {
          server.childPid = earlyProc.pid;
        }
        await startPromise;
        const proc = (transport as unknown as { _process?: { pid?: number } })._process;
        if (proc?.pid) {
          server.childPid = proc.pid;
        } else if (transport.pid) {
          server.childPid = transport.pid;
        }
      };

      // WHY: Client.connect's catch block fires `void this.close()` without awaiting it,
      // which clears `this._process = undefined` synchronously on the first call. Memoize
      // transport.close() so our `await client.close()` awaits the actual close completion.
      let closePromise: Promise<void> | null = null;
      const origClose = transport.close.bind(transport);
      transport.close = () => {
        if (!closePromise) {
          closePromise = origClose();
        }
        return closePromise;
      };

      if (transport.stderr) {
        const decoder = new StringDecoder("utf8");
        let stderrRemainder = "";
        let stderrFlushed = false;
        const emitLine = (rawLine: string): void => {
          const clean = sanitizeStderrLine(rawLine);
          if (!clean) return;
          appendStderr(clean);
          console.error(`[pi-mcp] [${server.name}] ${clean}`);
        };
        transport.stderr.on("data", (chunk: Buffer) => {
          stderrRemainder += decoder.write(chunk);
          const lines = stderrRemainder.split("\n");
          stderrRemainder = lines.pop() ?? "";
          for (const rawLine of lines) {
            emitLine(rawLine);
          }
        });
        const flushStderr = (): void => {
          if (stderrFlushed) return;
          stderrFlushed = true;
          stderrRemainder += decoder.end();
          if (stderrRemainder) {
            emitLine(stderrRemainder);
            stderrRemainder = "";
          }
        };
        transport.stderr.on("end", flushStderr);
        transport.stderr.on("close", flushStderr);
      }
    }

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
            setClientDefaultOptions(server.client, {
              requestTimeoutMs: refreshTimeoutMs,
              signal,
            });
            await this.onToolRefresh(server.name, server.client, {
              requestTimeoutMs: refreshTimeoutMs,
              signal,
            });
          } catch (err) {
            console.error(
              `[pi-mcp] Failed to refresh tools for ${server.name}:`,
              err,
            );
          }
        }
      },
    );

    // notifications/message: structured logging from MCP servers
    client.setNotificationHandler(
      LoggingMessageNotificationSchema,
      async (notification) => {
        const { level = "info", logger = server.name, data } = notification.params ?? {};
        const msg = typeof data === "string" ? data : JSON.stringify(data);
        console.error(`[pi-mcp:${server.name}] [${level}] ${logger}: ${msg}`);
        appendStderr(`[${level}] ${logger}: ${msg}`);
      },
    );

    server.client = client;
    try {
      await this._connectWithTimeoutAndSignal(client, transport, timeoutMs, signal, server.name);
      if (signal.aborted) throw new AuthCancelledError(server.name);
      if (transport instanceof StdioClientTransport && !server.childPid) {
        server.childPid = transport.pid;
      }
      // Readiness includes tool discovery, not just the MCP handshake.
      setClientDefaultOptions(client, { requestTimeoutMs: timeoutMs, signal });
      if (this.onToolRefresh) {
        await this.onToolRefresh(server.name, client, {
          requestTimeoutMs: timeoutMs,
          signal,
        });
      }
      if (signal.aborted) throw new AuthCancelledError(server.name);
      server.state = "ready";
      server.retryCount = 0;
      server.lastError = null;
      if (server.config.healthCheckIntervalMs) {
        let pingInFlight = false;
        server.healthCheckTimer = setInterval(async () => {
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
            if (server.state === "ready" && !signal.aborted) {
              void this._recover(server, server.cwd ?? cwd);
            }
          } finally {
            if (pingTimer !== undefined) {
              clearTimeout(pingTimer);
            }
            pingInFlight = false;
          }
        }, server.config.healthCheckIntervalMs);
      }
      // Unexpected transport close (e.g. the server subprocess crashes
      // mid-session). Without this the state would stay "ready" and tools
      // would remain active against a dead server. Deliberate closes abort
      // the signal first, so they are ignored here.
      client.onclose = () => {
        if (signal.aborted || server.client !== client) return;
        console.error(`[pi-mcp] Server ${server.name} closed unexpectedly, reconnecting`);
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
        const msg = err instanceof Error ? err.message : String(err);
        if (
          /unknown message ID|Received a response for an unknown message ID|notifications\/progress|unknown token/i.test(
            msg,
          )
        ) {
          return;
        }
        if (server.config.transport === "sse") {
          console.error(`[pi-mcp] Server ${server.name} SSE stream error, reconnecting: ${msg}`);
          scheduleErrorRecovery();
          return;
        }
        if (server.config.transport === "streamable-http") {
          if (isOAuthUnauthorizedError(err)) {
            console.error(`[pi-mcp] Server ${server.name} HTTP auth error, recovering: ${msg}`);
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
          if (/Failed to open SSE stream:/i.test(msg)) {
            return;
          }
          console.error(`[pi-mcp] Server ${server.name} HTTP stream error, reconnecting: ${msg}`);
          scheduleErrorRecovery();
        }
      };
    } catch (err) {
      const pid =
        server.childPid ??
        (transport as unknown as { _process?: { pid?: number } })?._process?.pid ??
        (transport instanceof StdioClientTransport ? transport.pid : null);
      server.childPid = null;
      await Promise.allSettled([
        client.close(),
        this._ensurePidTerminated(pid),
      ]);
      await this._ensurePidTerminated(pid);
      if (server.client === client) {
        server.client = null;
        server.transport = undefined;
      }
      if (signal.aborted || err instanceof AuthCancelledError) {
        throw err instanceof AuthCancelledError ? err : new AuthCancelledError(server.name);
      }
      const error = err instanceof Error ? err : new Error(String(err));
      if (
        !corruptStateRecovered &&
        error instanceof McpError &&
        error.code === "config" &&
        /Corrupt OAuth state file/i.test(error.message)
      ) {
        // WHY: McpOAuthProvider._loadState() already backed up and removed the corrupt
        // state file before throwing this error. Log the warning and retry once immediately
        // without consuming retryCount so OAuth can proceed cleanly into AuthRequiredError.
        console.error(`[pi-mcp] ${error.message}`);
        if (signal.aborted) throw new AuthCancelledError(server.name);
        return this._connect(server, cwd, signal, true);
      }
      server.lastError = error;
      if (error instanceof AuthRequiredError) {
        server.state = "stopped";
        throw error;
      }
      if (Boolean(server.config.auth) && server.config.transport !== "stdio" && isOAuthUnauthorizedError(error)) {
        // WHY: Check OAuth unauthorized errors BEFORE the generic `error.code === "protocol"`
        // fast-fail so 401/403 failures during initial tools/list (`onToolRefresh`) are
        // classified as `AuthRequiredError` rather than raw protocol failures, and stale
        // tokens on disk are invalidated before interactive re-authorization runs.
        await invalidateStoredTokens(server.name, this.storageDir, server.config.url);
        const authError = new AuthRequiredError(server.name);
        server.lastError = authError;
        server.state = "stopped";
        throw authError;
      }
      if (error instanceof McpError && error.code === "protocol") {
        server.state = "stopped";
        throw error;
      }
      if (server.retryCount >= this.settings.maxRetries) {
        server.state = "stopped";
        const code = error instanceof McpError && error.code === "timeout" ? "timeout" : "connection";
        throw new McpError(
          `Connection failed after ${server.retryCount} retries: ${error.message}`,
          server.name,
          code,
          err,
        );
      }
      const delayMs = RETRY_DELAYS_MS[Math.min(server.retryCount++, RETRY_DELAYS_MS.length - 1)] ?? 30000;
      await new Promise<void>((resolve) => {
        server.retryTimer = setTimeout(() => { server.retryTimer = null; resolve(); }, delayMs);
        signal.addEventListener("abort", () => {
          if (server.retryTimer) { clearTimeout(server.retryTimer); server.retryTimer = null; }
          resolve();
        }, { once: true });
      });
      if (signal.aborted) throw new AuthCancelledError(server.name);
      return this._connect(server, cwd, signal, corruptStateRecovered);
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
          console.error(`[pi-mcp] [${server.name}] Background recovery failed: ${error.message}`);
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

    server.state = "stopped";
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
      this._ensurePidTerminated(pid),
    ]);
    await this._ensurePidTerminated(pid);
  }
}

