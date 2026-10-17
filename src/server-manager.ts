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
import { McpError } from "./errors.js";
import type { McpConfig, ServerConfig, Settings } from "./config.js";
import { McpOAuthProvider, AuthRequiredError, getAuthStatus, resetAuth, invalidateStoredTokens } from "./oauth-provider.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

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
export type ToolRefreshCallback = (serverName: string, client: Client) => Promise<void>;

export interface TransportAuthCallbacks {
  /** Legacy callback type. Background transport attempts never invoke this callback. */
  onAuthRequired: (serverName: string, authorizationUrl: URL) => void | Promise<void>;
}

// ─── Transport Factory ────────────────────────────────────────────────────────

function createTransport(
  serverName: string,
  config: ServerConfig,
  onStderr: (line: string) => void,
  storageDir?: string,
): Transport {
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
      // Build clean env: process.env may contain undefined values,
      // child_process.spawn silently drops them, but let's be explicit
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
      }
      Object.assign(env, config.env ?? {});
      const transport = new StdioClientTransport({
        command: config.command!,
        args: config.args,
        env,
        stderr: "pipe",
      });
      // Capture stderr lines into the circular buffer
      transport.stderr?.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n").filter(Boolean);
        for (const line of lines) onStderr(line);
      });
      return transport;
    }
    case "streamable-http":
      return new StreamableHTTPClientTransport(
        new URL(config.url!),
        {
          ...(requestInit && { requestInit }),
          ...(authProvider && { authProvider }),
        },
      ) as unknown as Transport;
    case "sse":
      return new SSEClientTransport(
        new URL(config.url!),
        {
          ...(requestInit && { requestInit }),
          ...(authProvider && { authProvider }),
        },
      );
  }
}

// ─── ServerManager ────────────────────────────────────────────────────────────

export class ServerManager {
  private readonly servers = new Map<string, ManagedServer>();
  private settings: Settings;
  private onToolRefresh: ToolRefreshCallback | null = null;
  private onServerStopped: ((name: string) => void) | null = null;

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
    await invalidateStoredTokens(name, this.storageDir, server.config.url);
    const authError = new AuthRequiredError(name);
    if (server.state === "ready") {
      await this._shutdown(server);
    }
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
    if (server.attempt) return server.attempt;
    if (server.state === "ready") return;
    server.retryCount = 0;
    const controller = new AbortController();
    server.controller = controller;
    server.state = "starting";
    const attempt = this._connect(server, cwd, controller.signal);
    server.attempt = attempt;
    try { await attempt; } finally {
      if (server.attempt === attempt) {
        server.attempt = undefined;
        if (this.getServer(name)?.state !== "ready") server.controller = undefined;
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

  private async _connect(
    server: ManagedServer,
    cwd: string,
    signal: AbortSignal,
    corruptStateRecovered = false,
  ): Promise<void> {
    server.lastError = null;
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
      transport = createTransport(server.name, server.config, appendStderr, this.storageDir);
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
      async () => ({
        // file:// URI for the workspace root. On Windows this produces
        // file://C:\... which is technically non-standard but functional
        // for the common case (MCP servers use roots as hints, not strict paths).
        roots: [{ uri: `file://${cwd}`, name: "workspace" }],
      }),
    );

    // tools/list_changed: re-discover tools and update Pi registrations
    client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        if (!signal.aborted && this.onToolRefresh && server.state === "ready" && server.client === client) {
          try {
            await this.onToolRefresh(server.name, server.client);
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
      await client.connect(transport);
      if (signal.aborted) throw new Error("Connection cancelled");
      server.childPid = transport instanceof StdioClientTransport ? transport.pid : null;
      // Readiness includes tool discovery, not just the MCP handshake.
      if (this.onToolRefresh) await this.onToolRefresh(server.name, client);
      if (signal.aborted) throw new Error("Connection cancelled");
      server.state = "ready";
      server.retryCount = 0;
      server.lastError = null;
      if (server.config.healthCheckIntervalMs) {
        server.healthCheckTimer = setInterval(async () => {
          if (signal.aborted) return;
          try { await client.ping(); }
          catch {
            if (signal.aborted) return;
            await this._recover(server, cwd);
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
        void this._recover(server, cwd);
      };
    } catch (err) {
      try { await client.close(); } catch { /* best effort */ }
      if (server.client === client) { server.client = null; server.childPid = null; }
      if (signal.aborted) throw new Error("Connection cancelled");
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
        if (signal.aborted) throw new Error("Connection cancelled");
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
        throw new McpError(`Connection failed after ${server.retryCount} retries: ${error.message}`, server.name, "connection", err);
      }
      const delayMs = RETRY_DELAYS_MS[Math.min(server.retryCount++, RETRY_DELAYS_MS.length - 1)] ?? 30000;
      await new Promise<void>((resolve) => {
        server.retryTimer = setTimeout(() => { server.retryTimer = null; resolve(); }, delayMs);
        signal.addEventListener("abort", () => {
          if (server.retryTimer) { clearTimeout(server.retryTimer); server.retryTimer = null; }
          resolve();
        }, { once: true });
      });
      if (signal.aborted) throw new Error("Connection cancelled");
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
        void this.startServer(server.name, cwd).catch((error) => {
          server.lastError = error instanceof Error ? error : new Error(String(error));
        });
      });
    }
  }

  private async _shutdown(server: ManagedServer): Promise<void> {
    server.controller?.abort();
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
    const pid = server.childPid;
    server.client = null;
    server.childPid = null;

    try {
      // SDK handles transport-specific cleanup:
      // - stdio: closes stdin, waits for process exit, sends SIGTERM/SIGKILL
      // - streamable-http/sse: closes HTTP connections
      await client?.close();
    } catch {
      // If SDK cleanup fails, force kill the subprocess as a safety net
      if (pid !== null) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Process may already be dead
        }
      }
    }
  }
}
