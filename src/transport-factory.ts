/**
 * SDK transport construction for pi-mcp.
 *
 * Builds the configured MCP SDK transport (stdio, streamable-http, or sse),
 * wires silent OAuth providers and static headers, and applies transport-level
 * SDK workarounds.
 */

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpError } from "./errors.js";
import type { ServerConfig } from "./config.js";
import { McpOAuthProvider } from "./oauth-provider.js";
import { createLineSplitter } from "./stdio-process.js";
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

function createRequestInit(config: ServerConfig): RequestInit | undefined {
  // Build requestInit for static headers (API keys, etc.)
  return config.headers ? { headers: config.headers } : undefined;
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

function wireStdioStderr(transport: StdioClientTransport, onStderr: (line: string) => void): void {
  if (!transport.stderr) return;
  const splitter = createLineSplitter((rawLine) => {
    const clean = sanitizeTerminalText(rawLine);
    if (clean) onStderr(clean);
  });
  transport.stderr.on("data", (chunk: Buffer) => {
    splitter.write(chunk);
  });
  const flush = (): void => {
    splitter.end();
  };
  transport.stderr.on("end", flush);
  transport.stderr.on("close", flush);
}

function createStdioTransport(
  serverName: string,
  config: ServerConfig,
  cwd: string | undefined,
  onStderr: ((line: string) => void) | undefined,
): Transport {
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

export function createTransport(
  serverName: string,
  config: ServerConfig,
  cwdOrOnStderr?: string | ((line: string) => void),
  storageDir?: string,
  cwdArg?: string,
): Transport {
  const cwd = typeof cwdOrOnStderr === "string" ? cwdOrOnStderr : cwdArg;
  const onStderr = typeof cwdOrOnStderr === "function" ? cwdOrOnStderr : undefined;
  const requestInit = createRequestInit(config);
  const authProvider = createOAuthProvider(serverName, config, storageDir);

  switch (config.transport) {
    case "stdio":
      return createStdioTransport(serverName, config, cwd, onStderr);
    case "streamable-http":
      return createStreamableHttpTransport(config, requestInit, authProvider);
    case "sse":
      return createSseTransport(config, requestInit, authProvider);
  }
}
