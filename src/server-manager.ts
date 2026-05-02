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
import type { McpConfig, ServerConfig, Settings, AuthConfig } from "./config.js";
import { McpOAuthProvider, getAuthStatus, resetAuth } from "./oauth-provider.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

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
}

/** Called after tool list is refreshed for a server (e.g. on list_changed notification). */
export type ToolRefreshCallback = (serverName: string, client: Client) => Promise<void>;

export interface TransportAuthCallbacks {
  /** Called when OAuth authorization is required (browser redirect needed). */
  onAuthRequired: (serverName: string, authorizationUrl: URL) => void | Promise<void>;
}

// ─── Transport Factory ────────────────────────────────────────────────────────

function createTransport(
  serverName: string,
  config: ServerConfig,
  onStderr: (line: string) => void,
  authCallbacks?: TransportAuthCallbacks,
): Transport {
  // Build requestInit for static headers (API keys, etc.)
  const requestInit: RequestInit | undefined = config.headers
    ? { headers: config.headers }
    : undefined;

  // Build OAuth authProvider if auth config is present
  let authProvider: OAuthClientProvider | undefined;
  if (config.auth && config.transport !== "stdio") {
    authProvider = new McpOAuthProvider(
      serverName,
      config.auth,
      authCallbacks
        ? (url: URL) => authCallbacks.onAuthRequired(serverName, url)
        : undefined,
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

  private authCallbacks: TransportAuthCallbacks | undefined;

  constructor(config: McpConfig, authCallbacks?: TransportAuthCallbacks) {
    this.settings = config.settings;
    this.authCallbacks = authCallbacks;
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
    await resetAuth(name);
  }

  /** Get auth status for a server. */
  async getServerAuthStatus(name: string): Promise<{
    hasTokens: boolean;
    hasClientInfo: boolean;
    savedAt: string | undefined;
    scope: string | undefined;
  } | null> {
    return getAuthStatus(name);
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
    if (server.state !== "stopped") return; // Already starting or ready
    // Reset retry count on explicit start — allows /mcp:start after exhaustion
    server.retryCount = 0;
    await this._connect(server, cwd);
  }

  async stopServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server || server.state === "stopped") return;
    await this._shutdown(server);
  }

  async shutdownAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.servers.values()).map((s) => this._shutdown(s)),
    );
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

  // ─── Internal ───────────────────────────────────────────────────────────────

  private async _connect(server: ManagedServer, cwd: string): Promise<void> {
    server.state = "starting";
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
      transport = createTransport(server.name, server.config, appendStderr, this.authCallbacks);
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
        if (this.onToolRefresh && server.client) {
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

    try {
      await client.connect(transport);
    } catch (err) {
      server.state = "stopped";
      server.lastError = err instanceof Error ? err : new Error(String(err));
      // Clean up the transport we created (client.close() also closes transport)
      try { await client.close(); } catch { /* best effort */ }
      // Attempt retry if under the limit
      await this._scheduleRetry(server, cwd);
      return;
    }

    // Guard against shutdown being called while we were connecting.
    // _shutdown sets state to "stopped" but can't close the local client variable.
    if (server.state !== "starting") {
      try { await client.close(); } catch { /* best effort */ }
      return;
    }

    // Extract PID from stdio transport for safety-net cleanup
    if (server.config.transport === "stdio") {
      // StdioClientTransport exposes the underlying process
      server.childPid = (transport as any).process?.pid ?? null;
    }

    server.client = client;
    server.state = "ready";
    server.retryCount = 0;
    server.lastError = null;

    // Start opt-in health check
    if (server.config.healthCheckIntervalMs) {
      server.healthCheckTimer = setInterval(async () => {
        try {
          await client.ping();
        } catch {
          clearInterval(server.healthCheckTimer!);
          server.healthCheckTimer = null;
          console.error(`[pi-mcp] Health check failed for ${server.name}, reconnecting`);
          server.state = "stopped";
          await this._scheduleRetry(server, cwd);
        }
      }, server.config.healthCheckIntervalMs);
    }

    // Trigger initial tool registration
    if (this.onToolRefresh) {
      try {
        await this.onToolRefresh(server.name, client);
      } catch (err) {
        console.error(`[pi-mcp] Initial tool registration failed for ${server.name}:`, err);
      }
    }
  }

  private async _scheduleRetry(server: ManagedServer, cwd: string): Promise<void> {
    const maxRetries = this.settings.maxRetries;
    if (server.retryCount >= maxRetries) {
      console.error(
        `[pi-mcp] Server "${server.name}" failed after ${maxRetries} retries: ${server.lastError?.message}`,
      );
      return;
    }

    const delayMs = RETRY_DELAYS_MS[Math.min(server.retryCount, RETRY_DELAYS_MS.length - 1)] ?? 30000;
    server.retryCount++;
    console.error(
      `[pi-mcp] Retrying "${server.name}" in ${delayMs}ms (attempt ${server.retryCount}/${maxRetries})`,
    );

    await new Promise<void>((resolve) => {
      server.retryTimer = setTimeout(() => {
        server.retryTimer = null;
        resolve();
      }, delayMs);
    });
    if (server.state !== "stopped") return; // May have been stopped externally
    await this._connect(server, cwd);
  }

  private async _shutdown(server: ManagedServer): Promise<void> {
    if (server.state === "stopped") return;

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
