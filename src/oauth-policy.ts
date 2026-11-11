/**
 * Pure OAuth 2.1 client-information, issuer-binding, token, and state-invalidation policy.
 *
 * Keeps deterministic OAuth rules (DCR metadata construction, redirect URI fallback
 * and mismatch detection, client_secret expiry, static vs. DCR credential shaping,
 * GHSA-6qxp-vccf-f47h authorization-server issuer binding, OAuthTokens <-> StoredTokens
 * mapping, single-use refresh peer-rotation detection, and StoredState invalidation)
 * separate from lock and filesystem I/O in oauth-provider.ts.
 */

import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { McpError } from "./errors.js";
import {
  canonicalServerUrl,
  type StoredClientInfo,
  type StoredState,
  type StoredTokens,
} from "./oauth-state-store.js";

// ─── Types & Constants ────────────────────────────────────────────────────────

/** Auth config in mcp.json server entry. Matches the Zod AuthConfigSchema in config.ts. */
export interface AuthConfig {
  /** Auth type. Currently only "oauth" is supported. */
  type?: "oauth" | undefined;
  /**
   * Callback URL the OAuth server redirects to after authorization.
   * Default: auto-detected local callback server.
   */
  redirectUrl?: string | undefined;
  /**
   * Optional scope to request during authorization.
   */
  scope?: string | undefined;
  /**
   * Pre-registered client_id (skip dynamic client registration).
   */
  clientId?: string | undefined;
  /**
   * Pre-registered client_secret.
   */
  clientSecret?: string | undefined;
  /** `client_name` sent with Dynamic Client Registration. Default: `pi-mcp/<server name>`. */
  clientName?: string | undefined;
}

export const DEFAULT_CALLBACK_PORT = 19876;
export const DEFAULT_REDIRECT_URL = `http://127.0.0.1:${DEFAULT_CALLBACK_PORT}/callback`;

export interface ClientInformationExtras {
  client_id_issued_at: number;
  client_secret_expires_at: number;
  token_endpoint_auth_method: string;
  redirect_uris: Array<string | URL>;
}

export type InvalidationScope = "all" | "client" | "tokens" | "verifier" | "discovery";

// ─── Pure Client-Information & Redirect Helpers ───────────────────────────────

export function isClientSecretExpired(info: StoredClientInfo, nowMs: number = Date.now()): boolean {
  if (info.client_secret === undefined) return false;
  if (typeof info.client_secret_expires_at !== "number") return false;
  if (info.client_secret_expires_at <= 0) return false;
  return info.client_secret_expires_at * 1000 <= nowMs;
}

export function hasRedirectUriMismatch(info: StoredClientInfo, redirectUrl: string): boolean {
  if (!Array.isArray(info.redirect_uris) || info.redirect_uris.length === 0) return false;
  return !info.redirect_uris.includes(redirectUrl);
}

export function toOAuthClientInformation(info: StoredClientInfo): OAuthClientInformationMixed {
  return {
    client_id: info.client_id,
    ...(info.client_secret !== undefined && { client_secret: info.client_secret }),
    ...(info.client_id_issued_at !== undefined && { client_id_issued_at: info.client_id_issued_at }),
    ...(info.client_secret_expires_at !== undefined && {
      client_secret_expires_at: info.client_secret_expires_at,
    }),
    ...(info.token_endpoint_auth_method !== undefined && {
      token_endpoint_auth_method: info.token_endpoint_auth_method,
    }),
    ...(info.redirect_uris !== undefined && { redirect_uris: info.redirect_uris }),
    ...(info.issuer !== undefined && { issuer: info.issuer }),
  };
}

export function withoutStaticClientId<T>(
  hasStaticClientId: boolean,
  value: T | undefined,
): T | undefined {
  return hasStaticClientId ? undefined : value;
}

export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function redirectUrisOrUndefined(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((uri) => String(uri)) : undefined;
}

export function buildInteractiveStoredClientInfo(
  clientInformation: OAuthClientInformationMixed,
  hasStaticClientId: boolean,
  issuerToBind: string | undefined,
): StoredClientInfo {
  const fullInfo = clientInformation as Partial<ClientInformationExtras>;
  return {
    client_id: clientInformation.client_id,
    client_secret: withoutStaticClientId(hasStaticClientId, clientInformation.client_secret),
    client_id_issued_at: withoutStaticClientId(
      hasStaticClientId,
      numberOrUndefined(fullInfo.client_id_issued_at),
    ),
    client_secret_expires_at: withoutStaticClientId(
      hasStaticClientId,
      numberOrUndefined(fullInfo.client_secret_expires_at),
    ),
    token_endpoint_auth_method: withoutStaticClientId(
      hasStaticClientId,
      stringOrUndefined(fullInfo.token_endpoint_auth_method),
    ),
    redirect_uris: withoutStaticClientId(
      hasStaticClientId,
      redirectUrisOrUndefined(fullInfo.redirect_uris),
    ),
    issuer: issuerToBind,
  };
}

export function resolveProviderRedirectUrl(
  mode: "silent" | "interactive",
  explicitRedirectUrl: string | URL | undefined,
  authConfig: AuthConfig,
  storedRedirectUris?: string[],
): string | URL {
  if (mode === "silent" && storedRedirectUris?.[0] !== undefined) {
    // WHY: A silent provider never starts an authorization flow, but clientMetadata.redirect_uris
    // must still match what the client was registered with. Prefer the stored DCR redirect_uris
    // (preserved per AGENTS.md), then the configured auth.redirectUrl, then the default 127.0.0.1:19876 callback.
    return storedRedirectUris[0];
  }
  // WHY: In interactive mode, redirectUrl is the URL the callback server actually bound
  // (passed in by authorize()), falling back to configured auth.redirectUrl, then the default
  // 127.0.0.1:19876 callback URL.
  return explicitRedirectUrl ?? authConfig.redirectUrl ?? DEFAULT_REDIRECT_URL;
}

export function buildOAuthClientMetadata(
  serverName: string,
  authConfig: AuthConfig,
  mode: "silent" | "interactive",
  explicitRedirectUrl: string | URL | undefined,
  storedRedirectUris?: string[],
): OAuthClientMetadata {
  // WHY: A silent provider never starts an authorization flow, but clientMetadata.redirect_uris
  // must still match what the client was registered with. Prefer the stored DCR redirect_uris
  // (preserved per AGENTS.md), then the configured auth.redirectUrl, then the default 127.0.0.1:19876 callback.
  const redirectUris =
    mode === "silent" && storedRedirectUris && storedRedirectUris.length > 0
      ? storedRedirectUris
      : [String(resolveProviderRedirectUrl(mode, explicitRedirectUrl, authConfig))];
  return {
    client_name: authConfig.clientName ?? `pi-mcp/${serverName}`,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: authConfig.clientSecret ? "client_secret_basic" : "none",
    ...(authConfig.scope && { scope: authConfig.scope }),
  };
}

export function buildStaticClientInformation(
  authConfig: AuthConfig,
  storedClient: StoredClientInfo | undefined,
): OAuthClientInformationMixed {
  const boundIssuer =
    authConfig.clientId !== undefined && storedClient?.client_id === authConfig.clientId
      ? storedClient.issuer
      : undefined;
  return {
    client_id: authConfig.clientId ?? "",
    ...(authConfig.clientSecret && { client_secret: authConfig.clientSecret }),
    ...(boundIssuer !== undefined && { issuer: boundIssuer }),
  };
}

// ─── Pure Issuer-Binding & Silent Client-Information Helpers ──────────────────

export function assertIssuerBindingCompatible(
  serverName: string,
  existingIssuer: string | undefined,
  nextIssuer: string | undefined,
): void {
  if (existingIssuer === undefined || nextIssuer === undefined || existingIssuer === nextIssuer) {
    return;
  }
  // WHY: A stored client already bound to an authorization server issuer must never be
  // re-bound to a different issuer. Switching authorization servers requires an explicit reset.
  throw new McpError(
    `OAuth client for "${serverName}" is already bound to authorization server ${existingIssuer} and cannot be bound to ${nextIssuer}. Run /mcp:auth ${serverName} --reset to re-authorize.`,
    serverName,
    "auth",
  );
}

export function mergeSilentStoredClientInfo(
  storedClient: StoredClientInfo,
  authConfig: AuthConfig,
  issuerToBind: string | undefined,
): StoredClientInfo {
  // WHY: Mirror silent saveTokens: pure issuer binding of the already-known client
  // preserves all stored credentials and DCR metadata on disk while stamping issuer.
  return {
    ...storedClient,
    client_secret: authConfig.clientId ? undefined : storedClient.client_secret,
    issuer: issuerToBind ?? storedClient.issuer,
  };
}

export function buildNewSilentStoredClientInfo(
  clientInformation: OAuthClientInformationMixed,
  authConfig: AuthConfig,
  issuerToBind: string | undefined,
): StoredClientInfo {
  return {
    client_id: clientInformation.client_id,
    client_secret: authConfig.clientId
      ? undefined
      : (authConfig.clientSecret ?? clientInformation.client_secret),
    client_id_issued_at: undefined,
    client_secret_expires_at: undefined,
    token_endpoint_auth_method: undefined,
    redirect_uris: undefined,
    issuer: issuerToBind,
  };
}

// ─── Pure Token & State-Invalidation Helpers ──────────────────────────────────

export function isPeerRotatedTokens(
  diskTokens: StoredTokens | undefined,
  lastReadTokens: StoredTokens | undefined,
): diskTokens is StoredTokens {
  if (!diskTokens) return false;
  return (
    diskTokens.refresh_token !== lastReadTokens?.refresh_token ||
    diskTokens.access_token !== lastReadTokens?.access_token
  );
}

export function toOAuthTokens(storedTokens: StoredTokens): OAuthTokens {
  // Build OAuthTokens — only include defined fields
  const tokens: Record<string, unknown> = {
    access_token: storedTokens.access_token,
  };
  if (storedTokens.token_type !== undefined) tokens.token_type = storedTokens.token_type;
  if (storedTokens.refresh_token !== undefined) tokens.refresh_token = storedTokens.refresh_token;
  if (storedTokens.expires_in !== undefined) tokens.expires_in = storedTokens.expires_in;
  if (storedTokens.scope !== undefined) tokens.scope = storedTokens.scope;
  if (storedTokens.issuer !== undefined) tokens.issuer = storedTokens.issuer;
  return tokens as unknown as OAuthTokens;
}

export function toStoredTokens(
  tokens: OAuthTokens,
  savedAt: string = new Date().toISOString(),
): StoredTokens {
  return {
    access_token: tokens.access_token,
    token_type: tokens.token_type,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
    scope: tokens.scope,
    saved_at: savedAt,
    issuer: typeof tokens.issuer === "string" ? tokens.issuer : undefined,
  };
}

export function stampStateServerUrl(state: StoredState, serverUrl: string | undefined): void {
  if (serverUrl) {
    state.serverUrl = canonicalServerUrl(serverUrl);
  }
}

export function applyStoredStateInvalidation(
  state: StoredState,
  scope: InvalidationScope,
): boolean {
  let changedDisk = false;
  switch (scope) {
    case "all":
      changedDisk =
        state.clientInfo !== undefined ||
        state.tokens !== undefined ||
        state.discoveryState !== undefined;
      state.clientInfo = undefined;
      state.tokens = undefined;
      state.discoveryState = undefined;
      break;
    case "client":
      changedDisk = state.clientInfo !== undefined;
      state.clientInfo = undefined;
      break;
    case "tokens":
      changedDisk = state.tokens !== undefined;
      state.tokens = undefined;
      break;
    case "discovery":
      changedDisk = state.discoveryState !== undefined;
      state.discoveryState = undefined;
      break;
    case "verifier":
      break;
  }
  return changedDisk;
}
