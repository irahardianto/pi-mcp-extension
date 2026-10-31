/**
 * MCP resource bridge for pi-mcp.
 *
 * Bridges server-exposed resources and resource templates into Pi:
 *   - Paginated `resources/list` and `resources/templates/list` (cursor loop, max-page guard)
 *   - On-demand `resources/read` with text/image/binary conversion
 *   - A per-server catalog cache invalidated by `notifications/resources/list_changed`
 *   - AbortSignal, request timeouts, and OAuth 401/403 routing
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ReadResourceResultSchema,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { AuthCancelledError, McpError } from "./errors.js";
import { isCancellationError, isOAuthUnauthorizedError, isSdkTimeoutError } from "./connect-policy.js";
import { redactSecrets, reportDiagnostic } from "./debug-log.js";
import { sanitizeTerminalText } from "./terminal-text.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** One `resources/list` entry, reduced to the fields Pi can act on. */
export interface McpResourceDefinition {
  uri: string;
  name: string;
  description?: string | undefined;
  mimeType?: string | undefined;
}

/** One `resources/templates/list` entry. */
export interface McpResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  description?: string | undefined;
  mimeType?: string | undefined;
}

/** A server's advertised resources plus its URI templates. */
export interface ResourceCatalog {
  resources: McpResourceDefinition[];
  templates: McpResourceTemplateDefinition[];
}

export interface ResourceRequestOptions {
  requestTimeoutMs: number;
  signal?: AbortSignal | undefined;
}

/** Pi content block produced from one `resources/read` content entry. */
export type PiResourceContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Upper bound on pages per list method, so a malfunctioning server cannot page us forever. */
const MAX_PAGES = 100;

export interface ResourcePage<T> {
  items: T[];
  nextCursor: string | undefined;
}

// ─── Pagination & method-not-found degradation ────────────────────────────────

function reportPaginationLimit(serverName: string, method: string): void {
  reportDiagnostic({
    level: "warn",
    event: "resources.pagination_limit",
    server: serverName,
    message: `${method} pagination exceeded ${MAX_PAGES} pages, stopping. The server may be malfunctioning.`,
    fields: { pages: MAX_PAGES },
  });
}

/**
 * True for a JSON-RPC `-32601 Method not found` response.
 * WHY: A server may advertise the `resources` capability and still not implement
 * `resources/templates/list` (templates are optional in practice). That answer means
 * "this server has no templates", not "the catalog failed".
 */
function isMethodNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  return (err as { code?: unknown }).code === -32601;
}

/**
 * Follow a cursor across pages until the server stops sending one, degrading a JSON-RPC
 * `-32601 Method not found` response to an empty list.
 * Aborts surface as {@link AuthCancelledError}; every other failure reaches the caller.
 */
export async function collectPages<T>(
  serverName: string,
  method: string,
  signal: AbortSignal | undefined,
  fetchPage: (cursor: string | undefined) => Promise<ResourcePage<T>>,
): Promise<T[]> {
  try {
    return await collectCursorPages(serverName, method, signal, fetchPage);
  } catch (err) {
    if (isMethodNotFoundError(err)) return [];
    throw err;
  }
}

async function collectCursorPages<T>(
  serverName: string,
  method: string,
  signal: AbortSignal | undefined,
  fetchPage: (cursor: string | undefined) => Promise<ResourcePage<T>>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (signal?.aborted) throw new AuthCancelledError(serverName);
    const result = await fetchPage(cursor);
    items.push(...result.items);
    // WHY: The spec ends pagination by omitting `nextCursor`; an empty string means the same
    // thing and some servers send it, so neither may win another round trip.
    cursor = result.nextCursor;
    if (!cursor) return items;
  }
  reportPaginationLimit(serverName, method);
  return items;
}

// ─── Typed requests ───────────────────────────────────────────────────────────

function requestOptionsFor(options: ResourceRequestOptions): { timeout: number; signal?: AbortSignal } {
  return {
    timeout: options.requestTimeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function cursorParams(cursor: string | undefined): { cursor: string } | undefined {
  return cursor ? { cursor } : undefined;
}

/** Fetch one `resources/list` page through the typed helper, falling back to a raw request. */
function fetchResourcesPage(
  client: Client,
  cursor: string | undefined,
  options: ResourceRequestOptions,
): Promise<ListResourcesResult> {
  const reqOpts = requestOptionsFor(options);
  const params = cursorParams(cursor);
  if (typeof client.listResources === "function") return client.listResources(params, reqOpts);
  return client.request({ method: "resources/list", params: params ?? {} }, ListResourcesResultSchema, reqOpts);
}

/** Fetch one `resources/templates/list` page. */
function fetchResourceTemplatesPage(
  client: Client,
  cursor: string | undefined,
  options: ResourceRequestOptions,
): Promise<ListResourceTemplatesResult> {
  const reqOpts = requestOptionsFor(options);
  const params = cursorParams(cursor);
  if (typeof client.listResourceTemplates === "function") return client.listResourceTemplates(params, reqOpts);
  return client.request(
    { method: "resources/templates/list", params: params ?? {} },
    ListResourceTemplatesResultSchema,
    reqOpts,
  );
}

function readResourceOnce(client: Client, uri: string, options: ResourceRequestOptions): Promise<ReadResourceResult> {
  const requestOptions = requestOptionsFor(options);
  if (typeof client.readResource === "function") {
    return client.readResource({ uri }, requestOptions);
  }
  return client.request({ method: "resources/read", params: { uri } }, ReadResourceResultSchema, requestOptions);
}

// ─── Discovery ────────────────────────────────────────────────────────────────

export async function listAllResources(
  client: Client,
  serverName: string,
  options: ResourceRequestOptions,
): Promise<McpResourceDefinition[]> {
  return collectPages(serverName, "resources/list", options.signal, async (cursor) => {
    const result = await fetchResourcesPage(client, cursor, options);
    return { items: result.resources.map(toResourceDefinition), nextCursor: result.nextCursor };
  });
}

export async function listAllResourceTemplates(
  client: Client,
  serverName: string,
  options: ResourceRequestOptions,
): Promise<McpResourceTemplateDefinition[]> {
  return collectPages(serverName, "resources/templates/list", options.signal, async (cursor) => {
    const result = await fetchResourceTemplatesPage(client, cursor, options);
    return { items: result.resourceTemplates.map(toResourceTemplateDefinition), nextCursor: result.nextCursor };
  });
}

function toResourceDefinition(resource: ListResourcesResult["resources"][number]): McpResourceDefinition {
  return {
    uri: resource.uri,
    name: resource.name,
    description: resource.description,
    mimeType: resource.mimeType,
  };
}

function toResourceTemplateDefinition(
  template: ListResourceTemplatesResult["resourceTemplates"][number],
): McpResourceTemplateDefinition {
  return {
    uriTemplate: template.uriTemplate,
    name: template.name,
    description: template.description,
    mimeType: template.mimeType,
  };
}

// ─── Content conversion ───────────────────────────────────────────────────────

/**
 * Convert `resources/read` contents into Pi content blocks.
 *
 * WHY: Inline image blobs are what the model can actually consume; every other binary payload
 * becomes a bounded summary so a large archive cannot flood the context window.
 */
export function convertResourceContents(contents: readonly unknown[]): PiResourceContent[] {
  return contents.map(convertResourceContent);
}

function convertResourceContent(item: unknown): PiResourceContent {
  if (typeof item !== "object" || item === null) {
    return { type: "text", text: String(item) };
  }
  const entry = item as Record<string, unknown>;
  // WHY: Check `typeof text === "string"` rather than truthiness so an empty text resource
  // (`text: ""`) stays empty instead of degrading to a `[Resource: uri]` placeholder.
  if (typeof entry["text"] === "string") {
    return { type: "text", text: entry["text"] };
  }
  if (typeof entry["blob"] === "string") {
    return convertBlobResource(entry);
  }
  return { type: "text", text: `[Resource: ${String(entry["uri"] ?? "unknown")}]` };
}

function convertBlobResource(entry: Record<string, unknown>): PiResourceContent {
  const uri = String(entry["uri"] ?? "unknown");
  const mimeType = typeof entry["mimeType"] === "string" ? entry["mimeType"] : "application/octet-stream";
  const blob = String(entry["blob"]);
  if (mimeType.startsWith("image/")) {
    return { type: "image", data: blob, mimeType };
  }
  return { type: "text", text: `[Binary resource: ${uri} (${mimeType}, ${Buffer.byteLength(blob, "base64")} bytes)]` };
}

// ─── Resource bridge ──────────────────────────────────────────────────────────

interface CachedCatalog {
  generation: number;
  catalog: ResourceCatalog;
}

function cloneCatalog(catalog: ResourceCatalog): ResourceCatalog {
  return { resources: [...catalog.resources], templates: [...catalog.templates] };
}

function formatFailureDetail(err: unknown): string {
  const raw = err instanceof Error ? err.message : String((err as { message?: unknown } | null)?.message ?? err);
  return redactSecrets(sanitizeTerminalText(raw));
}

/**
 * Caches each server's resource catalog and serves `resources/read` on demand.
 *
 * The catalog is fetched lazily (the first `mcp_list_resources` call for a server) and kept
 * until the server reports `notifications/resources/list_changed`, which bumps a monotonic
 * generation. A page set that was in flight when the notification arrived is discarded rather
 * than cached, because the server has already declared it stale.
 */
export class ResourceBridge {
  private readonly catalogs = new Map<string, CachedCatalog>();
  private readonly generations = new Map<string, number>();
  private onAuthError?: ((serverName: string, error: unknown) => Promise<void> | void) | undefined;

  /** Register callback invoked when a `resources/*` request fails with 401/403. */
  setAuthErrorCallback(cb: (serverName: string, error: unknown) => Promise<void> | void): void {
    this.onAuthError = cb;
  }

  /** Drop a server's cached catalog after `notifications/resources/list_changed`. */
  invalidate(serverName: string): void {
    this.generations.set(serverName, this._generation(serverName) + 1);
    this.catalogs.delete(serverName);
  }

  /** Forget a server's cached catalog when it stops or leaves the config. */
  forget(serverName: string): void {
    // WHY: advance the generation instead of deleting it. A page set that was in flight when
    // the server stopped would otherwise be stamped with the same generation a restarted
    // server reads, resurrecting a catalog fetched from the previous client.
    this.generations.set(serverName, this._generation(serverName) + 1);
    this.catalogs.delete(serverName);
  }

  /** Return the server's resources and templates, fetching the catalog on first use. */
  async getCatalog(
    serverName: string,
    client: Client,
    options: ResourceRequestOptions,
  ): Promise<ResourceCatalog> {
    const generation = this._generation(serverName);
    const cached = this.catalogs.get(serverName);
    if (cached?.generation === generation) {
      return cloneCatalog(cached.catalog);
    }
    const catalog = await this._fetchCatalog(serverName, client, options);
    // WHY: only cache when the generation has not advanced while these pages were in flight;
    // otherwise a slow stale response would overwrite a newer generation's catalog or
    // repopulate a server that was forgotten while in flight.
    if (this._generation(serverName) === generation) {
      this.catalogs.set(serverName, { generation, catalog });
    }
    return cloneCatalog(catalog);
  }

  /** Read one resource and convert its contents into Pi content blocks. */
  async readResource(
    serverName: string,
    client: Client,
    uri: string,
    options: ResourceRequestOptions,
  ): Promise<PiResourceContent[]> {
    try {
      const result = await readResourceOnce(client, uri, options);
      return convertResourceContents(result.contents);
    } catch (err) {
      return await this._rethrowFailure(serverName, err, options.signal);
    }
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private _generation(serverName: string): number {
    return this.generations.get(serverName) ?? 0;
  }

  private async _fetchCatalog(
    serverName: string,
    client: Client,
    options: ResourceRequestOptions,
  ): Promise<ResourceCatalog> {
    try {
      const resources = await listAllResources(client, serverName, options);
      const templates = await listAllResourceTemplates(client, serverName, options);
      return { resources, templates };
    } catch (err) {
      return await this._rethrowFailure(serverName, err, options.signal);
    }
  }

  /**
   * Normalize a `resources/*` failure after notifying the OAuth handler when the server needs
   * authorization: cancellation stays a cancellation, an SDK request timeout keeps `"timeout"`,
   * and everything else is a protocol failure.
   */
  private async _rethrowFailure(
    serverName: string,
    err: unknown,
    signal: AbortSignal | undefined,
  ): Promise<never> {
    // WHY: an abort mid-request is authoritative and must be recognized before the protocol
    // mapping — the SDK rejects an in-flight abort with its own RequestTimeout error.
    if (isCancellationError(err, signal)) {
      throw err instanceof AuthCancelledError ? err : new AuthCancelledError(serverName);
    }
    if (err instanceof McpError) throw err;
    if (isOAuthUnauthorizedError(err)) {
      await this.onAuthError?.(serverName, err);
    }
    throw new McpError(
      `MCP resource request failed for ${serverName}: ${formatFailureDetail(err)}`,
      serverName,
      isSdkTimeoutError(err) ? "timeout" : "protocol",
      err,
    );
  }
}
