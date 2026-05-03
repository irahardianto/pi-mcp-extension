/**
 * File-based OAuthClientProvider for MCP servers.
 *
 * Implements the full OAuth2 Authorization Code flow with PKCE and
 * Dynamic Client Registration (RFC 7591) as required by the MCP spec.
 *
 * Token and client state are persisted per-server under ~/.pi/agent/mcp-auth/
 * so they survive pi restarts without requiring re-authorization.
 *
 * Usage: config adds `auth: { ... }` to a server config. This module
 * constructs an OAuthClientProvider and the transport factory wires it in.
 */

import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

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
}

// ─── Callback Server Port ───────────────────────────────────────────────────────

let callbackPort = 19876;

/** Set the callback server port. Called by the auth flow when the server starts. */
export function setCallbackPort(port: number): void {
  callbackPort = port;
}

/** Get the current callback server port. */
export function getCallbackPort(): number {
  return callbackPort;
}

// ─── Persistent State Types ───────────────────────────────────────────────────

interface StoredClientInfo {
  client_id: string;
  client_secret: string | undefined;
}

interface StoredTokens {
  access_token: string;
  token_type: string | undefined;
  refresh_token: string | undefined;
  expires_in: number | undefined;
  scope: string | undefined;
  /** ISO timestamp when tokens were saved (for expiry estimation). */
  saved_at: string | undefined;
}

interface StoredState {
  clientInfo: StoredClientInfo | undefined;
  tokens: StoredTokens | undefined;
  codeVerifier: string | undefined;
  discoveryState: OAuthDiscoveryState | undefined;
}

// ─── File helpers ─────────────────────────────────────────────────────────────

const AUTH_DIR = join(homedir(), ".pi", "agent", "mcp-auth");

function statePath(serverName: string): string {
  // Hash the server name to avoid filesystem issues with special chars
  const hash = createHash("sha256").update(serverName).digest("hex").slice(0, 16);
  return join(AUTH_DIR, `${hash}.json`);
}

async function loadState(serverName: string): Promise<StoredState> {
  try {
    const raw = await readFile(statePath(serverName), "utf8");
    const parsed = JSON.parse(raw) as StoredState;
    return {
      clientInfo: parsed.clientInfo ?? undefined,
      tokens: parsed.tokens ?? undefined,
      codeVerifier: parsed.codeVerifier ?? undefined,
      discoveryState: parsed.discoveryState ?? undefined,
    };
  } catch {
    return {
      clientInfo: undefined,
      tokens: undefined,
      codeVerifier: undefined,
      discoveryState: undefined,
    };
  }
}

async function saveState(serverName: string, state: StoredState): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true });
  // Only write defined fields
  const toWrite: Record<string, unknown> = {};
  if (state.clientInfo !== undefined) toWrite.clientInfo = state.clientInfo;
  if (state.tokens !== undefined) toWrite.tokens = state.tokens;
  if (state.codeVerifier !== undefined) toWrite.codeVerifier = state.codeVerifier;
  if (state.discoveryState !== undefined) toWrite.discoveryState = state.discoveryState;
  await writeFile(statePath(serverName), JSON.stringify(toWrite, null, 2), "utf8");
}

// ─── OAuthClientProvider Implementation ────────────────────────────────────────

export class McpOAuthProvider implements OAuthClientProvider {
  private serverName: string;
  private authConfig: AuthConfig;
  private _redirectUrl: string | undefined;
  private _onAuthRequired: ((url: URL) => void | Promise<void>) | undefined;
  private _oauthState: string | undefined;

  constructor(
    serverName: string,
    authConfig: AuthConfig,
    onAuthRequired?: (url: URL) => void | Promise<void>,
  ) {
    this.serverName = serverName;
    this.authConfig = authConfig;
    this._redirectUrl = authConfig.redirectUrl;
    this._onAuthRequired = onAuthRequired;
  }

  // --- redirectUrl ---

  get redirectUrl(): string | URL {
    // Use configured redirect URL if provided, otherwise use the callback server
    // Use 127.0.0.1 explicitly (IPv4) to match the callback server binding
    return this._redirectUrl || `http://127.0.0.1:${callbackPort}/callback`;
  }

  // --- clientMetadata ---

  get clientMetadata(): OAuthClientMetadata {
    const redirectUrl = String(this.redirectUrl);
    return {
      client_name: `pi-mcp/${this.serverName}`,
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.authConfig.clientSecret ? "client_secret_basic" : "none",
    };
  }

  // --- clientInformation ---

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    // If static credentials provided, use those
    if (this.authConfig.clientId) {
      return {
        client_id: this.authConfig.clientId,
        ...(this.authConfig.clientSecret && { client_secret: this.authConfig.clientSecret }),
      };
    }
    // Otherwise load from persisted DCR state
    const state = await loadState(this.serverName);
    if (state.clientInfo) {
      return {
        client_id: state.clientInfo.client_id,
        ...(state.clientInfo.client_secret && { client_secret: state.clientInfo.client_secret }),
      };
    }
    return undefined;
  }

  // --- saveClientInformation (DCR) ---

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    const state = await loadState(this.serverName);
    state.clientInfo = {
      client_id: clientInformation.client_id,
      client_secret: clientInformation.client_secret,
    };
    await saveState(this.serverName, state);
  }

  // --- tokens ---

  async tokens(): Promise<OAuthTokens | undefined> {
    const state = await loadState(this.serverName);
    if (!state.tokens) return undefined;

    // Always return stored tokens — even if expired.
    // The SDK's auth() function checks tokens?.refresh_token and attempts
    // silent refresh before falling back to a new authorization flow.
    // Returning undefined for expired tokens would prevent that silent refresh
    // and force the user to re-authenticate via browser every time.
    //
    // Flow when we return expired tokens:
    //   transport sends expired access_token → 401
    //   → auth() sees refresh_token → silent refresh → success → retry
    //
    // Flow when we return undefined (WRONG):
    //   transport has no token → auth() → no refresh possible → REDIRECT
    //   → user must re-authenticate in browser

    // Build OAuthTokens — only include defined fields
    const tokens: Record<string, string> = {
      access_token: state.tokens.access_token,
    };
    if (state.tokens.token_type !== undefined) tokens.token_type = state.tokens.token_type;
    if (state.tokens.refresh_token !== undefined) tokens.refresh_token = state.tokens.refresh_token;
    return tokens as unknown as OAuthTokens;
  }

  // --- saveTokens ---

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const state = await loadState(this.serverName);
    state.tokens = {
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
      saved_at: new Date().toISOString(),
    };
    await saveState(this.serverName, state);
  }

  // --- redirectToAuthorization ---

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this._onAuthRequired) {
      await this._onAuthRequired(authorizationUrl);
    } else {
      // Fallback: just log it
      console.error(
        `[pi-mcp] OAuth authorization required for "${this.serverName}".`,
        `\n  Open this URL in your browser: ${authorizationUrl.toString()}`,
      );
    }
  }

  // --- PKCE code verifier ---

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const state = await loadState(this.serverName);
    state.codeVerifier = codeVerifier;
    await saveState(this.serverName, state);
  }

  async codeVerifier(): Promise<string> {
    const state = await loadState(this.serverName);
    if (!state.codeVerifier) {
      throw new Error(`[pi-mcp] No PKCE code verifier found for "${this.serverName}"`);
    }
    return state.codeVerifier;
  }

  // --- Discovery state caching ---

  async saveDiscoveryState(discState: OAuthDiscoveryState): Promise<void> {
    const state = await loadState(this.serverName);
    state.discoveryState = discState;
    await saveState(this.serverName, state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const state = await loadState(this.serverName);
    return state.discoveryState;
  }

  // --- OAuth state parameter (CSRF protection) ---

  /**
   * Set the OAuth state parameter before calling auth().
   * This should be called with a cryptographically random value.
   */
  setState(state: string): void {
    this._oauthState = state;
  }

  /**
   * Returns the OAuth state parameter for CSRF protection.
   * This is called by the SDK's auth() function when building the authorization URL.
   * Returns empty string if no state has been set (no CSRF protection).
   */
  async state(): Promise<string> {
    return this._oauthState || "";
  }

  // --- Credential invalidation ---

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const state = await loadState(this.serverName);
    switch (scope) {
      case "all":
        state.clientInfo = undefined;
        state.tokens = undefined;
        state.codeVerifier = undefined;
        state.discoveryState = undefined;
        break;
      case "client":
        state.clientInfo = undefined;
        break;
      case "tokens":
        state.tokens = undefined;
        break;
      case "verifier":
        state.codeVerifier = undefined;
        break;
      case "discovery":
        state.discoveryState = undefined;
        break;
    }
    await saveState(this.serverName, state);
  }
}

// ─── Public Helpers ────────────────────────────────────────────────────────────

/**
 * Get auth status info for a server — whether tokens exist, when they were saved, etc.
 * Returns null if no auth state file exists at all.
 */
export async function getAuthStatus(serverName: string): Promise<{
  hasTokens: boolean;
  hasClientInfo: boolean;
  savedAt: string | undefined;
  scope: string | undefined;
} | null> {
  const state = await loadState(serverName);
  if (
    state.clientInfo === undefined &&
    state.tokens === undefined &&
    state.codeVerifier === undefined &&
    state.discoveryState === undefined
  ) {
    return null;
  }
  return {
    hasTokens: state.tokens !== undefined,
    hasClientInfo: state.clientInfo !== undefined,
    savedAt: state.tokens?.saved_at,
    scope: state.tokens?.scope,
  };
}

/**
 * Reset all OAuth state for a server (tokens, client info, PKCE verifier, discovery).
 * Used to force re-authorization on next connection.
 */
export async function resetAuth(serverName: string): Promise<void> {
  await unlink(statePath(serverName)).catch(() => {});
}
