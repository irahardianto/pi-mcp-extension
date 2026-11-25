/**
 * OAuth challenge discovery, 403 insufficient_scope capture, and step-up scope helpers.
 */

import { extractWWWAuthenticateParams, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { canonicalServerUrl, urlsMatch } from "./oauth-policy.js";

export interface ManualAuthChallenge {
  resourceMetadataUrl?: URL | undefined;
  scope?: string | undefined;
}

export interface PendingAuthChallenge {
  serverUrl: string;
  resourceMetadataUrl?: URL | undefined;
  scope?: string | undefined;
  grantedScope?: string | undefined;
  error?: string | undefined;
}

export interface CapturedAuthChallenge {
  status: 401 | 403;
  serverUrl: string;
  resourceMetadataUrl?: URL | undefined;
  scope?: string | undefined;
  grantedScope?: string | undefined;
  error?: string | undefined;
}

export interface ChallengeCaptureFetchOptions {
  baseFetch?: typeof fetch | undefined;
  rejectInsufficientScope?: boolean | undefined;
}

function splitScopeTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.trim().split(/\s+/).filter(Boolean);
}

function dedupeScopeTokens(tokens: readonly string[]): string | undefined {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      unique.push(token);
    }
  }
  return unique.length > 0 ? unique.join(" ") : undefined;
}

/**
 * Compute a deduplicated space-delimited step-up scope union across
 * `configuredScope`, `grantedScope`, and `challengedScope`.
 *
 * When `challengedScope` is absent or blank, returns only normalized
 * `configuredScope` (or `undefined`) so the SDK can fall back to
 * `resourceMetadata.scopes_supported` instead of repeating the insufficient grant.
 */
export function mergeStepUpScope(
  configuredScope: string | undefined,
  grantedScope: string | undefined,
  challengedScope: string | undefined,
): string | undefined {
  const configured = splitScopeTokens(configuredScope);
  const challenged = splitScopeTokens(challengedScope);
  if (challenged.length === 0) {
    return dedupeScopeTokens(configured);
  }
  return dedupeScopeTokens([
    ...configured,
    ...splitScopeTokens(grantedScope),
    ...challenged,
  ]);
}

function normalizeScopeTokens(raw: string | undefined): string | undefined {
  return dedupeScopeTokens(splitScopeTokens(raw));
}

function mergeInsufficientScopeChallenge(
  prior: PendingAuthChallenge | undefined,
  incoming: CapturedAuthChallenge,
): PendingAuthChallenge {
  const isPriorStepUp = prior?.error === "insufficient_scope";
  const priorChallenged = isPriorStepUp ? prior.scope : undefined;
  const scope = dedupeScopeTokens([
    ...splitScopeTokens(priorChallenged),
    ...splitScopeTokens(incoming.scope),
  ]);
  const resourceMetadataUrl = incoming.resourceMetadataUrl ?? prior?.resourceMetadataUrl;
  // WHY: Keep the earliest captured grantedScope across retries (e.g. a refresh retry that
  // omits or narrows scope must not clobber the token scope that originally hit 403).
  const priorGranted = isPriorStepUp ? normalizeScopeTokens(prior.grantedScope) : undefined;
  const grantedScope = priorGranted ?? normalizeScopeTokens(incoming.grantedScope);
  return {
    serverUrl: incoming.serverUrl,
    error: "insufficient_scope",
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    ...(scope ? { scope } : {}),
    ...(grantedScope ? { grantedScope } : {}),
  };
}

/**
 * Merge an incoming 401/403 challenge into any pending server challenge.
 *
 * A subsequent 401 (such as the silent `startServer()` probe before `/mcp:auth`)
 * never overwrites an existing `insufficient_scope` challenge's `error`, `scope`,
 * or `grantedScope`, and repeated `403` challenges union scopes while keeping the
 * earliest captured `grantedScope`.
 */
export function mergePendingAuthChallenge(
  existing: PendingAuthChallenge | undefined,
  incoming: CapturedAuthChallenge,
): PendingAuthChallenge {
  const prior = existing && urlsMatch(existing.serverUrl, incoming.serverUrl) ? existing : undefined;
  if (incoming.error === "insufficient_scope") {
    return mergeInsufficientScopeChallenge(prior, incoming);
  }
  if (prior?.error === "insufficient_scope") {
    const resourceMetadataUrl = prior.resourceMetadataUrl ?? incoming.resourceMetadataUrl;
    return {
      ...prior,
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    };
  }
  const grantedScope = normalizeScopeTokens(incoming.grantedScope);
  return {
    serverUrl: incoming.serverUrl,
    ...(incoming.resourceMetadataUrl ? { resourceMetadataUrl: incoming.resourceMetadataUrl } : {}),
    ...(incoming.scope ? { scope: incoming.scope } : {}),
    ...(grantedScope ? { grantedScope } : {}),
    ...(incoming.error ? { error: incoming.error } : {}),
  };
}

/**
 * Attach a token's granted scope to a pending `insufficient_scope` challenge
 * if it does not already carry one.
 */
export function withGrantedScope(
  pending: PendingAuthChallenge | undefined,
  grantedScope: string | undefined,
): PendingAuthChallenge | undefined {
  if (!pending || pending.error !== "insufficient_scope" || normalizeScopeTokens(pending.grantedScope)) {
    return pending;
  }
  const normalized = normalizeScopeTokens(grantedScope);
  return normalized ? { ...pending, grantedScope: normalized } : pending;
}

/**
 * Return true when `pending` is a `403 insufficient_scope` step-up challenge
 * bound to `serverUrl`.
 */
export function isPendingStepUpChallenge(
  pending: PendingAuthChallenge | undefined,
  serverUrl: string | undefined,
): boolean {
  return (
    pending?.error === "insufficient_scope" &&
    typeof serverUrl === "string" &&
    urlsMatch(pending.serverUrl, serverUrl)
  );
}

/**
 * Whether `ConnectionCoordinator._tryStartServer` should skip a silent connect
 * attempt and proceed directly to interactive authorization.
 */
export function shouldSkipInteractivePreStart(params: {
  reset: boolean;
  hasUI: boolean;
  hasAuth: boolean;
  serverUrl: string | undefined;
  pending: PendingAuthChallenge | undefined;
}): boolean {
  if (params.reset) return true;
  if (!params.hasUI || !params.hasAuth) return false;
  return isPendingStepUpChallenge(params.pending, params.serverUrl);
}

/**
 * Record an incoming OAuth challenge onto `target` only while `isCurrent()` holds,
 * preventing late-settling responses from a shut-down or replaced transport from
 * polluting `pendingAuthChallenge`.
 */
export function applyPendingAuthChallenge(
  target: { pendingAuthChallenge?: PendingAuthChallenge | undefined },
  incoming: CapturedAuthChallenge,
  isCurrent: () => boolean,
): void {
  if (!isCurrent()) return;
  target.pendingAuthChallenge = mergePendingAuthChallenge(target.pendingAuthChallenge, incoming);
}

/**
 * Attach a token's granted scope onto `target.pendingAuthChallenge` when present.
 */
export function attachPendingGrantedScope(
  target: { pendingAuthChallenge?: PendingAuthChallenge | undefined } | undefined,
  scope: string | undefined,
): void {
  if (!target) return;
  target.pendingAuthChallenge = withGrantedScope(target.pendingAuthChallenge, scope);
}

/**
 * Resolve the effective OAuth challenge for `authorize()`, preserving any pending
 * `403 insufficient_scope` challenge ahead of a baseline `401` probe.
 */
export function resolveAuthorizeChallenge(params: {
  configuredScope?: string | undefined;
  pending?: PendingAuthChallenge | undefined;
  discovered: ManualAuthChallenge;
  storedTokenScope?: string | undefined;
}): ManualAuthChallenge {
  const { configuredScope, pending, discovered, storedTokenScope } = params;
  if (pending?.error !== "insufficient_scope") {
    return {
      ...(discovered.resourceMetadataUrl ? { resourceMetadataUrl: discovered.resourceMetadataUrl } : {}),
      ...(discovered.scope ? { scope: discovered.scope } : {}),
    };
  }
  const resourceMetadataUrl = pending.resourceMetadataUrl ?? discovered.resourceMetadataUrl;
  const effectiveGranted =
    normalizeScopeTokens(pending.grantedScope) ??
    normalizeScopeTokens(storedTokenScope) ??
    discovered.scope;
  const scope = mergeStepUpScope(configuredScope, effectiveGranted, pending.scope);
  return {
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    ...(scope ? { scope } : {}),
  };
}

function extractRequestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function parseServerOrigin(canonicalUrl: string): string | undefined {
  try {
    return new URL(canonicalUrl).origin;
  } catch {
    // WHY: Malformed serverUrl cannot match any HTTP request origin.
    return undefined;
  }
}

function isSameOriginRequest(input: Parameters<typeof fetch>[0], expectedOrigin: string): boolean {
  try {
    return new URL(extractRequestUrl(input)).origin === expectedOrigin;
  } catch {
    // WHY: Malformed or relative request URLs cannot verify origin binding.
    return false;
  }
}

function buildCapturedChallenge(
  status: 401 | 403,
  serverUrl: string,
  params: { resourceMetadataUrl?: URL | undefined; scope?: string | undefined; error?: string | undefined },
): CapturedAuthChallenge {
  const challenge: CapturedAuthChallenge = { status, serverUrl };
  if (params.resourceMetadataUrl) challenge.resourceMetadataUrl = params.resourceMetadataUrl;
  if (params.scope) challenge.scope = params.scope;
  if (params.error) challenge.error = params.error;
  return challenge;
}

async function handleCapturedResponse(
  response: Response,
  canonicalUrl: string,
  onChallenge: (challenge: CapturedAuthChallenge) => void,
  rejectInsufficientScope: boolean,
): Promise<Response> {
  if (response.status !== 401 && response.status !== 403) {
    return response;
  }
  const params = extractWWWAuthenticateParams(response);
  if (response.status === 401) {
    if (params.resourceMetadataUrl !== undefined || params.scope !== undefined) {
      onChallenge(buildCapturedChallenge(401, canonicalUrl, params));
    }
    return response;
  }
  if (params.error !== "insufficient_scope") {
    return response;
  }
  onChallenge(buildCapturedChallenge(403, canonicalUrl, params));
  if (rejectInsufficientScope) {
    await response.body?.cancel().catch(() => {
      // WHY: Release the HTTP response body before rejecting SSE transport on 403 insufficient_scope.
    });
    throw new UnauthorizedError("HTTP 403 insufficient_scope");
  }
  return response;
}

/**
 * Wrap `fetch` to capture same-origin `401` and `403 insufficient_scope`
 * `WWW-Authenticate` challenges from an MCP resource server.
 */
export function createChallengeCaptureFetch(
  serverUrl: string,
  onChallenge: (challenge: CapturedAuthChallenge) => void,
  options?: ChallengeCaptureFetchOptions,
): typeof fetch {
  const baseFetch = options?.baseFetch ?? fetch;
  const canonicalUrl = canonicalServerUrl(serverUrl);
  const expectedOrigin = parseServerOrigin(canonicalUrl);
  if (!expectedOrigin) return baseFetch;
  const rejectInsufficientScope = options?.rejectInsufficientScope === true;

  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (!isSameOriginRequest(input, expectedOrigin)) {
      return response;
    }
    return handleCapturedResponse(response, canonicalUrl, onChallenge, rejectInsufficientScope);
  };
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
