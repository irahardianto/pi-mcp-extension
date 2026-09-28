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
import { readFile, writeFile, mkdir, unlink, chmod, open, stat } from "node:fs/promises";
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

function authDir(storageDir?: string): string {
  return storageDir ?? join(homedir(), ".pi", "agent", "mcp-auth");
}

function statePath(serverName: string, storageDir?: string): string {
  // Hash the server name to avoid filesystem issues with special chars
  const hash = createHash("sha256").update(serverName).digest("hex").slice(0, 16);
  return join(authDir(storageDir), `${hash}.json`);
}

// Exclusive per-server authorization lock shared by independent Pi processes.
export async function acquireAuthLock(serverName: string, storageDir?: string): Promise<() => Promise<void>> {
  const directory = authDir(storageDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = `${statePath(serverName, storageDir)}.lock`;
  try {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(String(process.pid)); }
    catch (err) { await unlink(path).catch(() => {}); throw err; }
    finally { await file.close(); }
    return async () => { await unlink(path).catch(() => {}); };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    throw new AuthLockError(serverName);
  }
}

async function loadState(serverName: string, storageDir?: string): Promise<StoredState> {
  try {
    const raw = await readFile(statePath(serverName, storageDir), "utf8");
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

async function saveState(serverName: string, state: StoredState, storageDir?: string, isCancelled: () => boolean = () => false): Promise<void> {
  const directory = authDir(storageDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  // Only write defined fields
  const toWrite: Record<string, unknown> = {};
  if (state.clientInfo !== undefined) toWrite.clientInfo = state.clientInfo;
  if (state.tokens !== undefined) toWrite.tokens = state.tokens;
  if (state.codeVerifier !== undefined) toWrite.codeVerifier = state.codeVerifier;
  if (state.discoveryState !== undefined) toWrite.discoveryState = state.discoveryState;
  if (isCancelled()) throw new AuthRequiredError(serverName, "Authorization cancelled");
  const path = statePath(serverName, storageDir);
  await writeFile(path, JSON.stringify(toWrite, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
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
    private readonly storageDir?: string,
    private readonly silent = false,
    private readonly isCancelled: () => boolean = () => false,
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
      ...(this.authConfig.scope && { scope: this.authConfig.scope }),
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
    const state = await loadState(this.serverName, this.storageDir);
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
    if (this.silent) throw new AuthRequiredError(this.serverName);
    const state = await loadState(this.serverName, this.storageDir);
    state.clientInfo = {
      client_id: clientInformation.client_id,
      client_secret: clientInformation.client_secret,
    };
    await saveState(this.serverName, state, this.storageDir, this.isCancelled);
  }

  // --- tokens ---

  async tokens(): Promise<OAuthTokens | undefined> {
    const state = await loadState(this.serverName, this.storageDir);
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
    if (this.silent) await this.checkInteractiveLock();
    const state = await loadState(this.serverName, this.storageDir);
    state.tokens = {
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
      saved_at: new Date().toISOString(),
    };
    if (this.isCancelled()) throw new AuthRequiredError(this.serverName, "Authorization cancelled");
    await saveState(this.serverName, state, this.storageDir, this.isCancelled);
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
    // The SDK saves PKCE before redirecting. Silent attempts must not overwrite an active flow.
    if (this.silent) throw new AuthRequiredError(this.serverName);
    const state = await loadState(this.serverName, this.storageDir);
    state.codeVerifier = codeVerifier;
    await saveState(this.serverName, state, this.storageDir, this.isCancelled);
  }

  async codeVerifier(): Promise<string> {
    const state = await loadState(this.serverName, this.storageDir);
    if (!state.codeVerifier) {
      throw new Error(`[pi-mcp] No PKCE code verifier found for "${this.serverName}"`);
    }
    return state.codeVerifier;
  }

  // --- Discovery state caching ---

  async saveDiscoveryState(discState: OAuthDiscoveryState): Promise<void> {
    if (this.silent) return; // No shared state writes from background discovery.
    const state = await loadState(this.serverName, this.storageDir);
    state.discoveryState = discState;
    await saveState(this.serverName, state, this.storageDir, this.isCancelled);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const state = await loadState(this.serverName, this.storageDir);
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

  private async checkInteractiveLock(): Promise<void> {
    try { await stat(`${statePath(this.serverName, this.storageDir)}.lock`); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
    throw new AuthRequiredError(this.serverName);
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (this.silent) throw new AuthRequiredError(this.serverName);
    const state = await loadState(this.serverName, this.storageDir);
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
    await saveState(this.serverName, state, this.storageDir, this.isCancelled);
  }
}

// ─── Public Helpers ────────────────────────────────────────────────────────────

/**
 * Get auth status info for a server — whether tokens exist, when they were saved, etc.
 * Returns null if no auth state file exists at all.
 */
export async function getAuthStatus(serverName: string, storageDir?: string): Promise<{
  hasTokens: boolean;
  hasClientInfo: boolean;
  savedAt: string | undefined;
  scope: string | undefined;
} | null> {
  const state = await loadState(serverName, storageDir);
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
export async function resetAuth(serverName: string, storageDir?: string): Promise<void> {
  await unlink(statePath(serverName, storageDir)).catch(() => {});
}

export class AuthRequiredError extends Error {
  constructor(serverName: string, message = `Authorization required for ${serverName}. Connect in an interactive Pi session or use /mcp:auth ${serverName}.`) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export class AuthLockError extends AuthRequiredError {
  constructor(serverName: string) {
    super(serverName, `Another Pi process is authorizing ${serverName}; if it exited, remove its stale auth lock before retrying`);
    this.name = "AuthLockError";
  }
}
