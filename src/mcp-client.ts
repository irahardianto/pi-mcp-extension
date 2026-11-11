/**
 * Stateless MCP client protocol wiring for pi-mcp.
 *
 * Owns everything about a single SDK `Client` connection that does not touch
 * `ManagedServer` lifecycle state:
 *   - handshake race guard + timeout normalization (`createConnectRaceGuard`,
 *     `rethrowNormalizedConnectError`, `connectClientWithTimeout`)
 *   - client construction and protocol notifications (`createMcpClient`) —
 *     `roots/list`, `notifications/tools/list_changed`,
 *     `notifications/resources/list_changed`, `notifications/message`
 *   - pure formatting helpers (`buildWorkspaceRoot`, `formatServerLogNotification`)
 *   - time-bounded, non-overlapping health-check pings (`pingClientWithTimeout`,
 *     `startHealthCheck`)
 *
 * Every lifecycle decision (is this server still `ready`, is this client still the
 * current one, should a failed ping trigger recovery) stays in `ServerManager`, which
 * supplies it through the callbacks in {@link CreateMcpClientOptions} and
 * {@link HealthCheckOptions}.
 */

import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ListRootsRequestSchema,
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  LoggingMessageNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpError, AuthCancelledError } from "./errors.js";
import { isSdkTimeoutError } from "./connect-policy.js";
import { sanitizeTerminalText } from "./terminal-text.js";

// ─── Timer injection ──────────────────────────────────────────────────────────

/**
 * Timer functions used by the connect race guard, ping deadline, and health-check
 * scheduler.
 *
 * WHY: tests drive every deadline through a fake clock instead of wall-clock sleeps, so
 * the modules that own timers accept this deps object with the production globals as
 * defaults (same pattern as `AuthLockDeps` / `StdioProcessDeps`).
 */
export interface McpClientTimerDeps {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

function resolveTimerDeps(deps?: Partial<McpClientTimerDeps> | undefined): McpClientTimerDeps {
  // WHY: merge the production globals per call instead of returning `defaultTimerDeps`, so a
  // replaced clock (node:test `mock.timers`) is the one the caller's deadlines actually use.
  return {
    setTimeout: deps?.setTimeout ?? setTimeout,
    clearTimeout: deps?.clearTimeout ?? clearTimeout,
    setInterval: deps?.setInterval ?? setInterval,
    clearInterval: deps?.clearInterval ?? clearInterval,
  };
}

// ─── Handshake race & timeout normalization ───────────────────────────────────

export interface ConnectRaceGuard {
  outcome: Promise<never>;
  dispose: () => void;
}

/**
 * Race a connection attempt against its deadline and its abort signal.
 *
 * `outcome` rejects with {@link McpError} (`timeout`) when `timeoutMs` elapses and with
 * {@link AuthCancelledError} when `signal` aborts; `dispose()` releases both the timer and
 * the abort listener, and is safe to call after either of them fired.
 */
export function createConnectRaceGuard(
  timeoutMs: number,
  signal: AbortSignal,
  serverName: string,
  deps?: Partial<McpClientTimerDeps> | undefined,
): ConnectRaceGuard {
  const timers = resolveTimerDeps(deps);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const outcome = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new AuthCancelledError(serverName));
      return;
    }
    onAbort = () => {
      reject(new AuthCancelledError(serverName));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    timer = timers.setTimeout(() => {
      reject(
        new McpError(
          `Connection timed out after ${timeoutMs}ms`,
          serverName,
          "timeout",
        ),
      );
    }, timeoutMs);
  });

  const dispose = (): void => {
    if (timer !== undefined) {
      timers.clearTimeout(timer);
    }
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  };

  return { outcome, dispose };
}

/**
 * Re-throw a failed handshake with the error class the connect classifier downstream reads.
 *
 * WHY: a caller abort and an SDK request timeout must stay distinguishable — the SDK rejects
 * an aborted in-flight request with its own timeout code, so checking `signal.aborted` first
 * keeps `/mcp:stop` from being reported as a server timeout.
 */
export function rethrowNormalizedConnectError(
  err: unknown,
  signal: AbortSignal,
  serverName: string,
  timeoutMs: number,
): never {
  if (signal.aborted || err instanceof AuthCancelledError) {
    throw err instanceof AuthCancelledError ? err : new AuthCancelledError(serverName);
  }
  if (isSdkTimeoutError(err)) {
    throw new McpError(
      `Connection timed out after ${timeoutMs}ms`,
      serverName,
      "timeout",
      err,
    );
  }
  throw err;
}

export interface ConnectClientOptions {
  client: Client;
  transport: Transport;
  timeoutMs: number;
  signal: AbortSignal;
  serverName: string;
}

/**
 * Connect a client to its transport, bounded by `timeoutMs`, cancellable by `signal`.
 *
 * `client.connect` is awaited against the race guard rather than trusted to honour both,
 * because the SDK applies its own `timeout` per request and a transport whose `start()` hangs
 * never reaches a request at all.
 */
export async function connectClientWithTimeout(
  options: ConnectClientOptions,
  deps?: Partial<McpClientTimerDeps> | undefined,
): Promise<void> {
  const { client, transport, timeoutMs, signal, serverName } = options;
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

  const guard = createConnectRaceGuard(timeoutMs, signal, serverName, deps);
  try {
    await Promise.race([connectPromise, guard.outcome]);
  } catch (err) {
    rethrowNormalizedConnectError(err, signal, serverName, timeoutMs);
  } finally {
    guard.dispose();
  }
}

// ─── Client construction & protocol notifications ─────────────────────────────

export interface WorkspaceRoot {
  uri: string;
  name: string;
}

/**
 * The single `roots/list` entry exposing the workspace to the server.
 *
 * The `"workspace"` fallback is kept as-is: the extracted helper must not change what a server
 * sees for a cwd whose basename is empty (a filesystem root), even though returning the cwd
 * itself would read more naturally.
 */
export function buildWorkspaceRoot(cwd: string): WorkspaceRoot {
  return {
    uri: pathToFileURL(cwd).href,
    name: basename(cwd) || "workspace",
  };
}

export interface ServerLogNotificationParams {
  level?: unknown;
  logger?: unknown;
  data?: unknown;
}

export interface FormattedServerLog {
  safeLevel: string;
  safeLogger: string;
  formatted: string;
}

/**
 * Turn a `notifications/message` payload into sanitized log fields.
 *
 * Every field is server-controlled, so it passes through `sanitizeTerminalText` before it can
 * reach the stderr ring buffer, the debug log, or a notification.
 */
export function formatServerLogNotification(
  serverName: string,
  params: ServerLogNotificationParams | undefined,
): FormattedServerLog {
  const { level = "info", logger = serverName, data } = params ?? {};
  const rawMsg = typeof data === "string" ? data : JSON.stringify(data);
  const safeLevel = sanitizeTerminalText(String(level), { maxLength: 32 });
  const safeLogger = sanitizeTerminalText(String(logger), { maxLength: 100 });
  const safeMsg = sanitizeTerminalText(rawMsg ?? "");
  return {
    safeLevel,
    safeLogger,
    formatted: `[${safeLevel}] ${safeLogger}: ${safeMsg}`,
  };
}

export interface CreateMcpClientOptions {
  /** Server name, used as the default logger name for `notifications/message`. */
  serverName: string;
  /** Current workspace root exposed to the server (`server.cwd` when it is set). */
  getCwd: () => string;
  /** `notifications/tools/list_changed` — the caller decides whether it still applies. */
  onToolsChanged: (client: Client) => Promise<void>;
  /** `notifications/resources/list_changed` — the caller decides whether it still applies. */
  onResourcesChanged: (client: Client) => void;
  /** `notifications/message` — already sanitized and formatted. */
  onLogLine: (entry: FormattedServerLog) => void;
}

/**
 * Build the pi-mcp MCP client and wire its protocol surface.
 *
 * The handlers are registered on the client but hold no lifecycle state: each one forwards
 * the *current* client back to its owner so a superseded client's late notification cannot
 * mutate a server it no longer belongs to.
 */
export function createMcpClient(options: CreateMcpClientOptions): Client {
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
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [buildWorkspaceRoot(options.getCwd())],
  }));

  // tools/list_changed: re-discover tools and update Pi registrations
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    await options.onToolsChanged(client);
  });

  // resources/list_changed: drop the cached resource catalog so the next
  // `mcp_list_resources` / `/mcp:resources` call re-reads it.
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
    options.onResourcesChanged(client);
  });

  // notifications/message: structured logging from MCP servers
  client.setNotificationHandler(LoggingMessageNotificationSchema, async (notification) => {
    options.onLogLine(formatServerLogNotification(options.serverName, notification.params));
  });

  return client;
}

// ─── Health checks ────────────────────────────────────────────────────────────

export interface PingClientOptions {
  client: Client;
  serverName: string;
  timeoutMs: number;
  signal: AbortSignal;
}

/**
 * Ping a server with a hard deadline that is independent of the SDK's own request timeout.
 *
 * WHY: the ping is raced against a local timer because a wedged transport can leave the SDK's
 * per-request timeout unarmed — the point of a health check is to notice that.
 */
export async function pingClientWithTimeout(
  options: PingClientOptions,
  deps?: Partial<McpClientTimerDeps> | undefined,
): Promise<void> {
  const { client, serverName, timeoutMs, signal } = options;
  const timers = resolveTimerDeps(deps);
  let pingTimer: ReturnType<typeof setTimeout> | undefined;

  const pingOptions = { timeout: timeoutMs, signal };
  const pingCall = (
    client.ping as (
      opts?: { timeout?: number; signal?: AbortSignal },
      extraOpts?: { timeout?: number; signal?: AbortSignal },
    ) => Promise<unknown>
  )(pingOptions, pingOptions);
  // WHY: Handled via Promise.race below — a ping that loses the race must not surface as
  // an unhandled rejection.
  pingCall.catch(() => {
    // WHY: Handled via Promise.race below.
  });

  try {
    await Promise.race([
      pingCall,
      new Promise<never>((_resolve, reject) => {
        pingTimer = timers.setTimeout(
          () =>
            reject(
              new McpError(
                `Health check ping timed out after ${timeoutMs}ms`,
                serverName,
                "timeout",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (pingTimer !== undefined) {
      timers.clearTimeout(pingTimer);
    }
  }
}

export interface HealthCheckOptions {
  serverName: string;
  /** The connection to ping, or `null` when the server has no live client. */
  getClient: () => Client | null;
  /** Whether the owning server is currently `ready` (guards the interval and recovery). */
  isReady: () => boolean;
  intervalMs: number;
  timeoutMs: number;
  signal: AbortSignal;
  /** Called after a failed, non-cancelled ping on a still-ready server. */
  onPingFailure: () => void;
}

/**
 * Start the periodic health check, or return `null` when the server has none configured.
 *
 * The interval is deliberately non-overlapping (`pingInFlight`) and bounded per tick, and it
 * is `unref()`d so an idle server never keeps the Pi process alive. The caller keeps sole
 * ownership of the timer handle and of what a failure means.
 */
export function startHealthCheck(
  options: HealthCheckOptions,
  deps?: Partial<McpClientTimerDeps> | undefined,
): ReturnType<typeof setInterval> | null {
  if (!options.intervalMs) {
    return null;
  }

  const timers = resolveTimerDeps(deps);
  let pingInFlight = false;

  const runHealthCheck = async (): Promise<void> => {
    const client = options.getClient();
    if (pingInFlight || !client || !options.isReady() || options.signal.aborted) {
      return;
    }
    pingInFlight = true;
    try {
      await pingClientWithTimeout(
        {
          client,
          serverName: options.serverName,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
        },
        deps,
      );
    } catch {
      // WHY: Ping failure triggers background recovery if the server is still ready.
      // The ping error is intentionally not kept on the server's lastError because
      // recovery tears the server down synchronously, which resets lastError before any
      // reader observes it; if reconnection fails, recovery records that failure instead.
      if (options.isReady() && !options.signal.aborted) {
        options.onPingFailure();
      }
    } finally {
      pingInFlight = false;
    }
  };

  const timer = timers.setInterval(() => {
    void runHealthCheck();
  }, options.intervalMs);
  timer.unref();
  return timer;
}
