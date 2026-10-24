/**
 * Paginated tools/list discovery for pi-mcp.
 *
 * Owns cursor-based pagination loop, max-page guard diagnostics, and
 * cooperative abort handling for MCP tools/list requests.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
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
  const MAX_PAGES = 100;
  let pageCount = 0;

  do {
    if (signal?.aborted) {
      throw new AuthCancelledError(serverName);
    }
    if (pageCount >= MAX_PAGES) {
      reportDiagnostic({
        level: "warn",
        event: "tools.pagination_limit",
        server: serverName,
        message: `tools/list pagination exceeded ${MAX_PAGES} pages, stopping. The server may be malfunctioning.`,
        fields: { pages: pageCount },
      });
      break;
    }
    const requestOptions = {
      timeout: requestTimeoutMs,
      ...(signal ? { signal } : {}),
    };
    const callPromise =
      typeof client.listTools === "function"
        ? client.listTools(cursor ? { cursor } : undefined, requestOptions)
        : client.request(
            { method: "tools/list", params: cursor ? { cursor } : {} },
            ListToolsResultSchema,
            requestOptions,
          );

    let result: Awaited<typeof callPromise>;
    if (signal) {
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
        result = await Promise.race([callPromise, abortPromise]);
      } finally {
        if (onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
      }
    } else {
      result = await callPromise;
    }

    tools.push(...(result.tools as McpToolDefinition[]));
    cursor = result.nextCursor;
    pageCount++;
  } while (cursor);

  return tools;
}
