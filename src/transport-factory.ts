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
import { reportDiagnostic } from "./debug-log.js";
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
  inMessage: boolean;
  inClose: boolean;
  reportError: (err: unknown) => void;
}

function isJsonRpcNotificationMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const record = message as Record<string, unknown>;
  return typeof record["method"] === "string" && !("id" in record);
}

function invokeMessageSynchronously(
  handler: TransportMessageHandler,
  tracker: NotificationTurnTracker,
  message: Parameters<TransportMessageHandler>[0],
  extra: Parameters<TransportMessageHandler>[1],
): void {
  tracker.inMessage = true;
  try {
    handler(message, extra);
  } finally {
    tracker.inMessage = false;
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

function wrapOrderedMessageHandler(
  handler: TransportMessageHandler,
  tracker: NotificationTurnTracker,
): TransportMessageHandler {
  return (message, extra) => {
    if (tracker.inMessage) {
      handler(message, extra);
      return;
    }
    if (isJsonRpcNotificationMessage(message)) {
      if (tracker.tail === null) {
        try {
          invokeMessageSynchronously(handler, tracker, message, extra);
        } finally {
          enqueueTurnHold(tracker);
        }
      } else {
        enqueueTurnStep(tracker, () => {
          invokeMessageSynchronously(handler, tracker, message, extra);
        });
        enqueueTurnHold(tracker);
      }
      return;
    }
    if (tracker.tail === null) {
      invokeMessageSynchronously(handler, tracker, message, extra);
      return;
    }
    enqueueTurnStep(tracker, () => {
      invokeMessageSynchronously(handler, tracker, message, extra);
    });
  };
}

function invokeCloseSynchronously(
  handler: TransportCloseHandler,
  tracker: NotificationTurnTracker,
): void {
  tracker.inClose = true;
  try {
    handler();
  } finally {
    tracker.inClose = false;
  }
}

function wrapOrderedCloseHandler(
  handler: TransportCloseHandler,
  tracker: NotificationTurnTracker,
): TransportCloseHandler {
  return () => {
    if (tracker.inClose || tracker.tail === null) {
      invokeCloseSynchronously(handler, tracker);
      return;
    }
    enqueueTurnStep(tracker, () => {
      invokeCloseSynchronously(handler, tracker);
    });
  };
}

/**
 * Preserve FIFO wire order when JSON-RPC notifications, responses/requests, and close events
 * share a synchronous read batch (`StdioClientTransport.processReadBuffer()`, SSE chunks, or
 * JSON batch responses).
 *
 * WHY: `Protocol._onnotification` defers notification dispatch onto `Promise.resolve().then(...)`
 * while `Protocol._onresponse` and `Protocol._onclose` clear `_progressHandlers` synchronously.
 * Without ordering, a trailing `notifications/progress` frame arriving in the same chunk as its
 * `tools/call` result loses the race to `_onresponse` and is dropped as an unknown token (#300).
 */
function instrumentTransportMessageOrder(transport: Transport): Transport {
  const tracker: NotificationTurnTracker = {
    tail: null,
    inMessage: false,
    inClose: false,
    reportError: (err: unknown) => {
      transport.onerror?.(err instanceof Error ? err : new Error(String(err)));
    },
  };
  let orderedOnMessage: Transport["onmessage"];
  let orderedOnClose: Transport["onclose"];

  Object.defineProperties(transport, {
    onmessage: {
      configurable: true,
      enumerable: true,
      get: () => orderedOnMessage,
      set: (next: Transport["onmessage"]) => {
        orderedOnMessage = next ? wrapOrderedMessageHandler(next, tracker) : undefined;
      },
    },
    onclose: {
      configurable: true,
      enumerable: true,
      get: () => orderedOnClose,
      set: (next: Transport["onclose"]) => {
        orderedOnClose = next ? wrapOrderedCloseHandler(next, tracker) : undefined;
      },
    },
  });
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
        createStdioTransport(serverName, config, cwd, onStderr),
      );
    case "streamable-http":
      return instrumentTransportMessageOrder(
        createStreamableHttpTransport(config, requestInit, authProvider),
      );
    case "sse":
      return instrumentTransportMessageOrder(
        createSseTransport(config, requestInit, authProvider),
      );
  }
}
