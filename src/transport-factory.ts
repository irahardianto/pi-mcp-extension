/**
 * SDK transport construction for pi-mcp.
 *
 * Builds the configured MCP SDK transport (stdio, streamable-http, or sse),
 * wires silent OAuth providers and static headers, and applies transport-level
 * SDK workarounds.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpError } from "./errors.js";
import type { ServerConfig } from "./config.js";
import { McpOAuthProvider } from "./oauth-provider.js";
import { isAuthorizationHeader, stripAuthorizationHeader } from "./auth-challenge.js";
import { describeError, reportDiagnostic } from "./debug-log.js";
import { instrumentStderr } from "./stdio-process.js";
import { sanitizeTerminalText } from "./terminal-text.js";

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

function createRequestInit(headers: Record<string, string> | undefined): RequestInit | undefined {
  // Build requestInit for static headers (API keys, etc.)
  return headers ? { headers } : undefined;
}

function createOAuthProvider(
  serverName: string,
  config: ServerConfig,
  storageDir?: string,
): OAuthClientProvider | undefined {
  if (!config.auth || config.transport === "stdio") return undefined;
  // Silent transport attempts must not write PKCE or launch a browser.
  return new McpOAuthProvider({
    serverName,
    authConfig: config.auth,
    storageDir,
    mode: "silent",
    serverUrl: config.url,
  });
}

/**
 * Route a `createTransport(..., onStderr)` caller's stderr through the shared instrumentation.
 *
 * WHY: this used to keep its own line splitter that only flushed on the stream's 'end'/'close',
 * so on this path a partial line written before a close was dropped — the same defect
 * `instrumentStderr` fixes for `ServerManager` (#206).
 */
function wireStdioStderr(transport: StdioClientTransport, onStderr: (line: string) => void): void {
  instrumentStderr(transport, (rawLine) => {
    const clean = sanitizeTerminalText(rawLine);
    if (clean) onStderr(clean);
  });
}

/** Expand a leading `~` / `~/` / `~\` to the home directory, the way Pi resolves a config `cwd`. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Resolve the working directory for a stdio server: Pi 1.3.0's per-server `cwd` (relative paths
 * resolve against the session working directory, `~` expands to the home directory), else the
 * session working directory unchanged.
 */
export function resolveStdioCwd(
  configuredCwd: string | undefined,
  sessionCwd: string | undefined,
): string | undefined {
  if (configuredCwd === undefined) return sessionCwd;
  return resolve(sessionCwd ?? process.cwd(), expandHome(configuredCwd));
}

function createStdioTransport(
  serverName: string,
  config: ServerConfig,
  sessionCwd: string | undefined,
  onStderr: ((line: string) => void) | undefined,
): Transport {
  if (!config.command) {
    throw new McpError("stdio transport requires 'command'", serverName, "config");
  }
  const cwd = resolveStdioCwd(config.cwd, sessionCwd);
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: resolveEnv(config.env),
    ...(cwd !== undefined ? { cwd } : {}),
    stderr: "pipe",
  });
  if (onStderr) {
    wireStdioStderr(transport, onStderr);
  }
  return transport;
}

function createStreamableHttpTransport(
  config: ServerConfig,
  requestInit: RequestInit | undefined,
  authProvider: OAuthClientProvider | undefined,
): Transport {
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
  );
}

function createSseTransport(
  config: ServerConfig,
  requestInit: RequestInit | undefined,
  authProvider: OAuthClientProvider | undefined,
): Transport {
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
        (err: unknown) => {
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

type TransportMessageHandler = NonNullable<Transport["onmessage"]>;
type TransportCloseHandler = NonNullable<Transport["onclose"]>;

interface NotificationTurnTracker {
  tail: Promise<void> | null;
  reportError: (err: unknown) => void;
}

function isJsonRpcNotificationMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const record = message as Record<string, unknown>;
  return typeof record["method"] === "string" && !("id" in record);
}

/**
 * Open a synchronous turn hold around an initial notification dispatch.
 *
 * WHY: Installing `tracker.tail` before `handler` runs ensures any re-entrant `onmessage` or
 * `onclose` triggered synchronously inside `handler` queues behind this notification, while
 * resolving `gate` in `finally` schedules the hold release strictly after `Protocol._onnotification`'s
 * internal `Promise.resolve().then(...)` microtask.
 */
function dispatchNotificationWithTurnHold(
  handler: TransportMessageHandler,
  tracker: NotificationTurnTracker,
  message: Parameters<TransportMessageHandler>[0],
  extra: Parameters<TransportMessageHandler>[1],
): void {
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const hold = gate.then(() => {
    if (tracker.tail === hold) {
      tracker.tail = null;
    }
  });
  tracker.tail = hold;
  try {
    handler(message, extra);
  } finally {
    releaseGate();
  }
}

/**
 * Hold the turn queue open for one microtask so `Protocol._onnotification`'s internal
 * `Promise.resolve().then(...)` handler completes before any subsequent non-notification or close.
 */
function enqueueTurnHold(tracker: NotificationTurnTracker): void {
  const base = tracker.tail ?? Promise.resolve();
  const hold = base.then(() => {
    if (tracker.tail === hold) {
      tracker.tail = null;
    }
  });
  tracker.tail = hold;
}

function enqueueTurnStep(tracker: NotificationTurnTracker, step: () => void): void {
  const base = tracker.tail ?? Promise.resolve();
  const next = base.then(() => {
    try {
      step();
    } catch (err) {
      tracker.reportError(err);
    } finally {
      if (tracker.tail === next) {
        tracker.tail = null;
      }
    }
  });
  tracker.tail = next;
}

async function drainTurnQueue(tracker: NotificationTurnTracker): Promise<void> {
  while (tracker.tail !== null) {
    await tracker.tail;
  }
}

function normalizeDeferredError(err: unknown): Error {
  try {
    return err instanceof Error ? err : new Error(String(err));
  } catch {
    // WHY: `String(Object.create(null))` and throwing `toString` getters throw `TypeError`;
    // normalization must never reject `tracker.tail` and wedge subsequent turns.
    return new Error("[unstringifiable value thrown]");
  }
}

function reportDeferredHandlerError(
  serverName: string,
  transport: Transport,
  err: unknown,
): void {
  const normalized = normalizeDeferredError(err);
  try {
    transport.onerror?.(normalized);
  } catch (onErrorErr) {
    // WHY: Never allow a throwing `transport.onerror` listener to reject `tracker.tail`, which
    // would strand remaining frames in the batch and permanently poison future turns.
    const { kind, message } = describeError(onErrorErr);
    reportDiagnostic({
      level: "info",
      event: "transport.onerror_error",
      server: serverName,
      message: `Transport onerror threw while reporting deferred handler error: ${message}`,
      fields: { kind },
    });
  }
}

function wrapOrderedMessageHandler(
  handler: TransportMessageHandler,
  tracker: NotificationTurnTracker,
  isSuperseded: () => boolean,
): TransportMessageHandler {
  return (message, extra) => {
    if (isSuperseded()) {
      handler(message, extra);
      return;
    }
    if (isJsonRpcNotificationMessage(message)) {
      if (tracker.tail === null) {
        dispatchNotificationWithTurnHold(handler, tracker, message, extra);
      } else {
        enqueueTurnStep(tracker, () => {
          handler(message, extra);
        });
        enqueueTurnHold(tracker);
      }
      return;
    }
    if (tracker.tail === null) {
      handler(message, extra);
      return;
    }
    enqueueTurnStep(tracker, () => {
      handler(message, extra);
    });
  };
}

function wrapOrderedCloseHandler(
  handler: TransportCloseHandler,
  tracker: NotificationTurnTracker,
  isSuperseded: () => boolean,
): TransportCloseHandler {
  // WHY: `Protocol._onclose()` clears `client.transport` without clearing `transport.onclose`,
  // while `StreamableHTTPClientTransport.close()` and `SSEClientTransport.close()` invoke
  // `this.onclose?.()`. Latch per top-level handler registration so both same-turn and cross-tick
  // `onclose` + `transport.close()` combinations fire `onclose` at most once.
  let closeDispatched = false;
  return () => {
    if (isSuperseded()) {
      handler();
      return;
    }
    if (closeDispatched) return;
    closeDispatched = true;
    if (tracker.tail === null) {
      handler();
      return;
    }
    enqueueTurnStep(tracker, handler);
  };
}

function bindOrderedHandlerProperty<K extends "onmessage" | "onclose">(
  transport: Transport,
  key: K,
  wrap: (
    handler: NonNullable<Transport[K]>,
    isSuperseded: () => boolean,
  ) => NonNullable<Transport[K]>,
): void {
  let ordered: Transport[K];
  Object.defineProperty(transport, key, {
    configurable: true,
    enumerable: true,
    get: () => ordered,
    set: (next: Transport[K]) => {
      if (!next) {
        ordered = undefined;
        return;
      }
      if (next === ordered) return;
      const wrapped = wrap(next, () => ordered !== wrapped);
      ordered = wrapped;
    },
  });
}

function wrapOrderedTransportClose(
  transport: Transport,
  tracker: NotificationTurnTracker,
): void {
  // WHY: Deferring `Protocol._onclose()` behind an in-flight notification leaves `client.transport`
  // defined until the turn queue drains, so concurrent `client.close()` calls (e.g. `Client.connect`'s
  // `void this.close()` followed by `_cleanupFailedConnect`'s `await client.close()`) both reach
  // `transport.close()`. Memoize the close promise so `origClose()` runs once and every caller
  // awaits the drained queue.
  let closePromise: Promise<void> | null = null;
  const origClose = transport.close.bind(transport);
  transport.close = (): Promise<void> => {
    closePromise ??= (async () => {
      try {
        await origClose();
      } finally {
        await drainTurnQueue(tracker);
      }
    })();
    return closePromise;
  };
}

/**
 * Preserve FIFO wire order when JSON-RPC notifications, responses/requests, and close events
 * share a synchronous read batch (`StdioClientTransport.processReadBuffer()`, SSE chunks, or
 * JSON batch responses), and drain any queued turn steps before `transport.close()` resolves.
 *
 * WHY: `Protocol._onnotification` defers notification dispatch onto `Promise.resolve().then(...)`
 * while `Protocol._onresponse` and `Protocol._onclose` clear `_progressHandlers` synchronously.
 * Without ordering, a trailing `notifications/progress` frame arriving in the same chunk as its
 * `tools/call` result loses the race to `_onresponse` and is dropped as an unknown token (#300).
 */
function instrumentTransportMessageOrder(serverName: string, transport: Transport): Transport {
  const tracker: NotificationTurnTracker = {
    tail: null,
    reportError: (err: unknown) => {
      reportDeferredHandlerError(serverName, transport, err);
    },
  };
  bindOrderedHandlerProperty(transport, "onmessage", (next, isSuperseded) =>
    wrapOrderedMessageHandler(next, tracker, isSuperseded),
  );
  bindOrderedHandlerProperty(transport, "onclose", (next, isSuperseded) =>
    wrapOrderedCloseHandler(next, tracker, isSuperseded),
  );
  wrapOrderedTransportClose(transport, tracker);
  return transport;
}

export function createTransport(
  serverName: string,
  config: ServerConfig,
  cwdOrOnStderr?: string | ((line: string) => void),
  storageDir?: string,
  cwdArg?: string,
): Transport {
  const cwd = typeof cwdOrOnStderr === "string" ? cwdOrOnStderr : cwdArg;
  const onStderr = typeof cwdOrOnStderr === "function" ? cwdOrOnStderr : undefined;
  // WHY: with OAuth configured the SDK owns `Authorization` (see stripAuthorizationHeader);
  // a leftover static header is a migration artifact, so drop it and record that we did.
  const staticHeaders = config.auth ? stripAuthorizationHeader(config.headers) : config.headers;
  if (config.auth && config.headers && Object.keys(config.headers).some(isAuthorizationHeader)) {
    reportDiagnostic({
      level: "info",
      event: "config.static_authorization_ignored",
      server: serverName,
      message: `Ignoring the static Authorization header for "${serverName}": OAuth is configured, so requests carry the OAuth access token instead.`,
    });
  }
  const requestInit = createRequestInit(staticHeaders);
  const authProvider = createOAuthProvider(serverName, config, storageDir);

  switch (config.transport) {
    case "stdio":
      return instrumentTransportMessageOrder(
        serverName,
        createStdioTransport(serverName, config, cwd, onStderr),
      );
    case "streamable-http":
      return instrumentTransportMessageOrder(
        serverName,
        createStreamableHttpTransport(config, requestInit, authProvider),
      );
    case "sse":
      return instrumentTransportMessageOrder(
        serverName,
        createSseTransport(config, requestInit, authProvider),
      );
  }
}
