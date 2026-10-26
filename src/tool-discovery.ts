/**
 * Paginated tools/list discovery for pi-mcp.
 *
 * Owns cursor-based pagination loop, max-page guard diagnostics, and
 * cooperative abort handling for MCP tools/list requests.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { AuthCancelledError } from "./errors.js";
import { reportDiagnostic } from "./debug-log.js";

// ─── Tool Listing ─────────────────────────────────────────────────────────────

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    title?: string;
  };
}

/** Upper bound on tools/list pages, so a malfunctioning server cannot page us forever. */
const MAX_PAGES = 100;

/** Report the max-page guard tripping, then let the caller stop paginating. */
function reportPaginationLimit(serverName: string, pageCount: number): void {
  reportDiagnostic({
    level: "warn",
    event: "tools.pagination_limit",
    server: serverName,
    message: `tools/list pagination exceeded ${MAX_PAGES} pages, stopping. The server may be malfunctioning.`,
    fields: { pages: pageCount },
  });
}

/**
 * Race a tools/list request against an abort signal.
 * Abort wins as {@link AuthCancelledError}; the in-flight request is left to
 * settle on its own (its rejection is suppressed).
 */
async function raceWithAbort(
  callPromise: Promise<ListToolsResult>,
  signal: AbortSignal,
  serverName: string,
): Promise<ListToolsResult> {
  callPromise.catch(() => {
    // WHY: Suppress unhandled rejection if in-flight listTools rejects after abort wins the race.
  });
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new AuthCancelledError(serverName));
      return;
    }
    onAbort = () => reject(new AuthCancelledError(serverName));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([callPromise, abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Request one tools/list page: use the SDK's typed `listTools()` helper when the
 * client provides it, and fall back to a raw JSON-RPC request otherwise.
 */
function fetchToolsPage(
  client: Client,
  cursor: string | undefined,
  requestTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ListToolsResult> {
  const requestOptions = {
    timeout: requestTimeoutMs,
    ...(signal ? { signal } : {}),
  };
  if (typeof client.listTools === "function") {
    return client.listTools(cursor ? { cursor } : undefined, requestOptions);
  }
  return client.request(
    { method: "tools/list", params: cursor ? { cursor } : {} },
    ListToolsResultSchema,
    requestOptions,
  );
}

/** Fetch one page, cooperating with `signal` when the caller passed one. */
function fetchToolsPageAbortable(
  client: Client,
  cursor: string | undefined,
  requestTimeoutMs: number,
  signal: AbortSignal | undefined,
  serverName: string,
): Promise<ListToolsResult> {
  const page = fetchToolsPage(client, cursor, requestTimeoutMs, signal);
  if (!signal) return page;
  return raceWithAbort(page, signal, serverName);
}

/**
 * Fetch all tools from a server using cursor-based pagination.
 * The MCP spec mandates clients follow nextCursor until exhausted.
 * Includes a max-page guard to prevent infinite loops from broken servers.
 */
export async function listAllTools(
  client: Client,
  requestTimeoutMs: number,
  signal?: AbortSignal,
  serverName = "<unknown>",
): Promise<McpToolDefinition[]> {
  const tools: McpToolDefinition[] = [];
  let cursor: string | undefined;
  let pageCount = 0;

  do {
    if (signal?.aborted) {
      throw new AuthCancelledError(serverName);
    }
    if (pageCount >= MAX_PAGES) {
      reportPaginationLimit(serverName, pageCount);
      break;
    }

    const result = await fetchToolsPageAbortable(
      client,
      cursor,
      requestTimeoutMs,
      signal,
      serverName,
    );
    tools.push(...(result.tools as McpToolDefinition[]));
    cursor = result.nextCursor;
    pageCount++;
  } while (cursor);

  return tools;
}
