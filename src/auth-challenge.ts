/**
 * OAuth challenge discovery helpers for manual MCP authentication commands.
 */

import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";

export interface ManualAuthChallenge {
  resourceMetadataUrl?: URL | undefined;
  scope?: string | undefined;
}

export type AuthChallengeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const AUTH_CHALLENGE_TIMEOUT_MS = 10_000;

export interface ManualAuthChallengeOptions {
  fetchFn?: AuthChallengeFetch | undefined;
  timeoutMs?: number | undefined;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Drop any `Authorization` header (any casing) from a configured static header set.
 *
 * WHY: `Authorization` is the one header an OAuth server owns. The MCP SDK builds it from the
 * OAuth provider's access token and then spreads `requestInit.headers` on top, so an exact-case
 * `Authorization` key silently replaces the token, while `authorization` in any other casing
 * survives as a second entry that `new Headers()` comma-joins into one malformed value. The same
 * static value would also ride along on the OAuth discovery, registration, and token requests
 * made through `createHeadersFetch`, leaking a resource-server credential to the authorization
 * server. Drop it (and only it) whenever OAuth is configured; every other static header
 * (tenant keys, gateways) still applies.
 */
export function stripAuthorizationHeader(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const kept = Object.entries(headers).filter(([name]) => !isAuthorizationHeader(name));
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/** Case-insensitive test for the single header an OAuth server owns. */
export function isAuthorizationHeader(name: string): boolean {
  return name.toLowerCase() === "authorization";
}

/**
 * Wrap a fetch implementation so configured server headers are attached as
 * defaults on every request (e.g. during SDK OAuth metadata discovery and
 * token exchange) without overriding explicit per-request headers.
 */
export function createHeadersFetch(
  baseHeaders?: Record<string, string>,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  if (!baseHeaders || Object.keys(baseHeaders).length === 0) {
    return baseFetch;
  }
  return async (input, init) => {
    const merged = new Headers(baseHeaders);
    if (init?.headers) {
      const incoming = new Headers(init.headers);
      incoming.forEach((value, key) => {
        merged.set(key, value);
      });
    }
    return baseFetch(input, { ...init, headers: merged });
  };
}

/**
 * Discover OAuth challenge parameters from an MCP resource server.
 *
 * Some resource servers expose the protected resource metadata URL only in the
 * WWW-Authenticate header of the initial 401 response. Manual auth must carry
 * those values into the SDK auth flow so discovery reaches the real
 * authorization server instead of falling back to the resource server origin.
 */
export async function discoverManualAuthChallenge(
  serverUrl: string,
  options: ManualAuthChallengeOptions = {},
): Promise<ManualAuthChallenge> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? AUTH_CHALLENGE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json, text/event-stream");
  let response = await fetchFn(serverUrl, {
    method: "GET",
    headers,
    signal,
  });

  if (response.status === 405) {
    // WHY: Streamable HTTP MCP servers may only accept POST and return 405 on GET without
    // a WWW-Authenticate challenge. Probe with a minimal JSON-RPC ping POST to elicit 401/403.
    await response.body?.cancel().catch(() => {
      // WHY: Body cancel errors during challenge probe cleanup are non-fatal.
    });
    const postHeaders = new Headers(options.headers);
    postHeaders.set("Accept", "application/json, text/event-stream");
    postHeaders.set("Content-Type", "application/json");
    response = await fetchFn(serverUrl, {
      method: "POST",
      headers: postHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 0 }),
      signal,
    });
  }

  try {
    if (response.status !== 401 && response.status !== 403) {
      return {};
    }

    const { resourceMetadataUrl, scope, error } = extractWWWAuthenticateParams(response);
    if (response.status === 403 && error !== "insufficient_scope") {
      return {};
    }

    return {
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      ...(scope ? { scope } : {}),
    };
  } finally {
    await response.body?.cancel().catch(() => {
      // WHY: Body cancel errors during challenge probe cleanup are non-fatal.
    });
  }
}
