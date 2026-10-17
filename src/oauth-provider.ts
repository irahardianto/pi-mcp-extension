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
import { readFile, writeFile, mkdir, unlink, chmod, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpError } from "./errors.js";
import {
  acquireAuthLock,
  AuthLockError,
  AuthRequiredError,
  authDir,
  statePath,
  type AcquireAuthLockOptions,
  type AuthLockHandle,
} from "./auth-lock.js";

export { acquireAuthLock, AuthLockError, AuthRequiredError, type AcquireAuthLockOptions, type AuthLockHandle };

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

// ─── URL Canonicalization & Origin-Binding Helpers ────────────────────────────

export function canonicalServerUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${u.origin}${path}${u.search}`;
  } catch {
    return rawUrl.trim();
  }
}

export function urlsMatch(storedUrl: string, expectedUrl: string): boolean {
  return canonicalServerUrl(storedUrl) === canonicalServerUrl(expectedUrl);
}

function isResourceCompatibleWithServerUrl(resource: string, expectedServerUrl: string): boolean {
  if (urlsMatch(resource, expectedServerUrl)) return true;
  try {
    const req = new URL(canonicalServerUrl(expectedServerUrl));
    const cfg = new URL(canonicalServerUrl(resource));
    if (req.origin !== cfg.origin) return false;
    if (req.pathname.length < cfg.pathname.length) return false;
    const reqPath = req.pathname.endsWith("/") ? req.pathname : `${req.pathname}/`;
    const cfgPath = cfg.pathname.endsWith("/") ? cfg.pathname : `${cfg.pathname}/`;
    return reqPath.startsWith(cfgPath);
  } catch {
    return false;
  }
}

// ─── Persistent State Types & Schema ──────────────────────────────────────────

interface StoredClientInfo {
  client_id: string;
  client_secret: string | undefined;
  client_id_issued_at: number | undefined;
  client_secret_expires_at: number | undefined;
  token_endpoint_auth_method: string | undefined;
  redirect_uris: string[] | undefined;
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
  serverUrl?: string | undefined;
  clientInfo: StoredClientInfo | undefined;
  tokens: StoredTokens | undefined;
  discoveryState: OAuthDiscoveryState | undefined;
}

const StoredClientInfoSchema = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
  token_endpoint_auth_method: z.string().optional(),
  redirect_uris: z.array(z.string()).optional(),
});

const StoredTokensSchema = z.object({
  access_token: z.string(),
  token_type: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  saved_at: z.string().optional(),
});

export const StoredStateSchema = z.object({
  serverUrl: z.string().optional(),
  clientInfo: StoredClientInfoSchema.optional(),
  tokens: StoredTokensSchema.optional(),
  discoveryState: z.record(z.unknown()).optional(),
});

// ─── File helpers ─────────────────────────────────────────────────────────────

async function loadState(
  serverName: string,
  storageDir?: string,
  expectedServerUrl?: string,
): Promise<StoredState> {
  const path = statePath(serverName, storageDir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        serverUrl: expectedServerUrl ? canonicalServerUrl(expectedServerUrl) : undefined,
        clientInfo: undefined,
        tokens: undefined,
        discoveryState: undefined,
      };
    }
    throw err;
  }

  let parsed: z.output<typeof StoredStateSchema>;
  try {
    const json: unknown = JSON.parse(raw);
    parsed = StoredStateSchema.parse(json);
  } catch (err) {
    const backupPath = `${path}.corrupt-${Date.now()}`;
    await rename(path, backupPath);
    throw new McpError(
      `Corrupt OAuth state file for "${serverName}" backed up to ${backupPath}`,
      serverName,
      "config",
      err,
    );
  }

  let discoveryState = parsed.discoveryState as OAuthDiscoveryState | undefined;

  if (expectedServerUrl !== undefined) {
    // WHY: Bind OAuth state to the canonical server URL so a project config with the same
    // server name cannot inherit global Bearer tokens for a different origin/path.
    if (parsed.serverUrl !== undefined && !urlsMatch(parsed.serverUrl, expectedServerUrl)) {
      return {
        serverUrl: canonicalServerUrl(expectedServerUrl),
        clientInfo: undefined,
        tokens: undefined,
        discoveryState: undefined,
      };
    }

    const resource = (discoveryState?.resourceMetadata as { resource?: unknown } | undefined)?.resource;
    if (typeof resource === "string" && !isResourceCompatibleWithServerUrl(resource, expectedServerUrl)) {
      if (parsed.serverUrl === undefined) {
        // Legacy state file without top-level serverUrl whose cached resourceMetadata belongs to another server URL
        return {
          serverUrl: canonicalServerUrl(expectedServerUrl),
          clientInfo: undefined,
          tokens: undefined,
          discoveryState: undefined,
        };
      }
      // WHY: Discard mismatched discoveryState so the MCP SDK's selectResourceURL()
      // never throws "Protected resource ... does not match expected".
      discoveryState = undefined;
    }
  }

  return {
    serverUrl: parsed.serverUrl ?? (expectedServerUrl ? canonicalServerUrl(expectedServerUrl) : undefined),
    clientInfo: parsed.clientInfo
      ? {
          client_id: parsed.clientInfo.client_id,
          client_secret: parsed.clientInfo.client_secret,
          client_id_issued_at: parsed.clientInfo.client_id_issued_at,
          client_secret_expires_at: parsed.clientInfo.client_secret_expires_at,
          token_endpoint_auth_method: parsed.clientInfo.token_endpoint_auth_method,
          redirect_uris: parsed.clientInfo.redirect_uris,
        }
      : undefined,
    tokens: parsed.tokens
      ? {
          access_token: parsed.tokens.access_token,
          token_type: parsed.tokens.token_type,
          refresh_token: parsed.tokens.refresh_token,
          expires_in: parsed.tokens.expires_in,
          scope: parsed.tokens.scope,
          saved_at: parsed.tokens.saved_at,
        }
      : undefined,
    discoveryState,
  };
}

async function saveState(
  serverName: string,
  state: StoredState,
  storageDir?: string,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  const directory = authDir(storageDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  // Only write defined fields (never write codeVerifier to shared state)
  const toWrite: Record<string, unknown> = {};
  if (state.serverUrl !== undefined) toWrite.serverUrl = state.serverUrl;
  if (state.clientInfo !== undefined) toWrite.clientInfo = state.clientInfo;
  if (state.tokens !== undefined) toWrite.tokens = state.tokens;
  if (state.discoveryState !== undefined) toWrite.discoveryState = state.discoveryState;
  if (isCancelled()) throw new AuthRequiredError(serverName, "Authorization cancelled");
  const path = statePath(serverName, storageDir);
  const tmpPath = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(tmpPath, JSON.stringify(toWrite, null, 2), { encoding: "utf8", mode: 0o600 });
    await chmod(tmpPath, 0o600);
    if (isCancelled()) {
      await unlink(tmpPath).catch(() => {
        // WHY: Best-effort cleanup of temporary state file when cancelled before rename.
      });
      throw new AuthRequiredError(serverName, "Authorization cancelled");
    }
    await rename(tmpPath, path);
    await chmod(path, 0o600);
  } catch (err) {
    await unlink(tmpPath).catch(() => {
      // WHY: Best-effort cleanup of temporary state file after write or rename failure.
    });
    throw err;
  }
}

// ─── OAuthClientProvider Implementation ────────────────────────────────────────

export class McpOAuthProvider implements OAuthClientProvider {
  private serverName: string;
  private authConfig: AuthConfig;
  private _redirectUrl: string | undefined;
  private _onAuthRequired: ((url: URL) => void | Promise<void>) | undefined;
  private _oauthState: string | undefined;
  private _codeVerifier: string | undefined;
  private _cachedTokens: StoredTokens | undefined;
  private _lastReadTokens: StoredTokens | undefined;
  private _reloadedPeerTokens = false;

  constructor(
    serverName: string,
    authConfig: AuthConfig,
    onAuthRequired?: (url: URL) => void | Promise<void>,
    private readonly storageDir?: string,
    private readonly silent = false,
    private readonly isCancelled: () => boolean = () => false,
    private readonly assertLockHeld?: (() => Promise<void>) | undefined,
    private readonly serverUrl?: string | undefined,
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
    const state = await loadState(this.serverName, this.storageDir, this.serverUrl);
    const info = state.clientInfo;
    if (info) {
      if (
        info.client_secret !== undefined &&
        typeof info.client_secret_expires_at === "number" &&
        info.client_secret_expires_at > 0 &&
        info.client_secret_expires_at * 1000 <= Date.now()
      ) {
        if (this.silent) {
          throw new AuthRequiredError(
            this.serverName,
            "Stored OAuth client secret has expired; interactive re-authentication required",
          );
        }
        return undefined;
      }
      if (
        !this.silent &&
        Array.isArray(info.redirect_uris) &&
        info.redirect_uris.length > 0 &&
        !info.redirect_uris.includes(String(this.redirectUrl))
      ) {
        // WHY: If the callback port or configured redirectUrl changed since DCR,
        // return undefined in interactive mode so the SDK re-registers with the new redirect_uri.
        return undefined;
      }
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
      } as OAuthClientInformationMixed;
    }
    if (this.silent) throw new AuthRequiredError(this.serverName);
    return undefined;
  }

  // --- saveClientInformation (DCR) ---

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    if (this.silent) throw new AuthRequiredError(this.serverName);
    await this.assertLockHeld?.();
    const state = await loadState(this.serverName, this.storageDir, this.serverUrl);
    if (this.serverUrl) {
      state.serverUrl = canonicalServerUrl(this.serverUrl);
    }
    const fullInfo = clientInformation as Partial<{
      client_id_issued_at: number;
      client_secret_expires_at: number;
      token_endpoint_auth_method: string;
      redirect_uris: Array<string | URL>;
    }>;
    state.clientInfo = {
      client_id: clientInformation.client_id,
      client_secret: clientInformation.client_secret,
      client_id_issued_at:
        typeof fullInfo.client_id_issued_at === "number" ? fullInfo.client_id_issued_at : undefined,
      client_secret_expires_at:
        typeof fullInfo.client_secret_expires_at === "number" ? fullInfo.client_secret_expires_at : undefined,
      token_endpoint_auth_method:
        typeof fullInfo.token_endpoint_auth_method === "string"
          ? fullInfo.token_endpoint_auth_method
          : undefined,
      redirect_uris: Array.isArray(fullInfo.redirect_uris)
        ? fullInfo.redirect_uris.map((u) => String(u))
        : undefined,
    };
    await this.assertLockHeld?.();
    await saveState(this.serverName, state, this.storageDir, this.isCancelled);
  }

  // --- tokens ---

  async tokens(): Promise<OAuthTokens | undefined> {
    const storedTokens =
      this._cachedTokens ?? (await loadState(this.serverName, this.storageDir, this.serverUrl)).tokens;
    if (!storedTokens) return undefined;
    this._lastReadTokens = storedTokens;

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
    const tokens: Record<string, unknown> = {
      access_token: storedTokens.access_token,
    };
    if (storedTokens.token_type !== undefined) tokens.token_type = storedTokens.token_type;
    if (storedTokens.refresh_token !== undefined) tokens.refresh_token = storedTokens.refresh_token;
    if (storedTokens.expires_in !== undefined) tokens.expires_in = storedTokens.expires_in;
    if (storedTokens.scope !== undefined) tokens.scope = storedTokens.scope;
    return tokens as unknown as OAuthTokens;
  }

  // --- saveTokens ---

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const storedTokens: StoredTokens = {
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
      saved_at: new Date().toISOString(),
    };

    if (this.silent) {
      let handle: AuthLockHandle | undefined;
      try {
        handle = await acquireAuthLock(this.serverName, this.storageDir);
        const state = await loadState(this.serverName, this.storageDir, this.serverUrl);
        if (this.serverUrl) {
          state.serverUrl = canonicalServerUrl(this.serverUrl);
        }
        state.tokens = storedTokens;
        await saveState(this.serverName, state, this.storageDir, this.isCancelled);
        this._cachedTokens = undefined;
        this._lastReadTokens = storedTokens;
        this._reloadedPeerTokens = false;
      } catch (err) {
        // WHY: When another process holds the interactive auth lock (e.g. during --reset),
        // keep the refreshed tokens in memory for this session without clobbering disk state.
        this._cachedTokens = storedTokens;
        this._lastReadTokens = storedTokens;
        this._reloadedPeerTokens = false;
        if (!(err instanceof AuthLockError)) {
          console.error(`[pi-mcp] Failed to persist refreshed OAuth tokens for "${this.serverName}":`, err);
        }
      } finally {
        await handle?.();
      }
      return;
    }

    if (this.isCancelled()) throw new AuthRequiredError(this.serverName, "Authorization cancelled");
    await this.assertLockHeld?.();
    const state = await loadState(this.serverName, this.storageDir, this.serverUrl);
    if (this.serverUrl) {
      state.serverUrl = canonicalServerUrl(this.serverUrl);
    }
    state.tokens = storedTokens;
    if (this.isCancelled()) throw new AuthRequiredError(this.serverName, "Authorization cancelled");
    await this.assertLockHeld?.();
    await saveState(this.serverName, state, this.storageDir, this.isCancelled);
    this._cachedTokens = undefined;
    this._lastReadTokens = storedTokens;
    this._reloadedPeerTokens = false;
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

  // --- PKCE code verifier (in-memory per provider instance) ---

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    // The SDK saves PKCE before redirecting. Silent attempts must not start a browser flow.
    if (this.silent) throw new AuthRequiredError(this.serverName);
    if (this.isCancelled()) throw new AuthRequiredError(this.serverName, "Authorization cancelled");
    this._codeVerifier = codeVerifier;
  }

  async codeVerifier(): Promise<string> {
    if (!this._codeVerifier) {
      throw new Error(`[pi-mcp] No PKCE code verifier found for "${this.serverName}"`);
    }
    return this._codeVerifier;
  }

  // --- Discovery state caching ---

  async saveDiscoveryState(discState: OAuthDiscoveryState): Promise<void> {
    if (this.silent) return; // No shared state writes from background discovery.
    await this.assertLockHeld?.();
    const state = await loadState(this.serverName, this.storageDir, this.serverUrl);
    if (this.serverUrl) {
      state.serverUrl = canonicalServerUrl(this.serverUrl);
    }
    state.discoveryState = discState;
    await this.assertLockHeld?.();
    await saveState(this.serverName, state, this.storageDir, this.isCancelled);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const state = await loadState(this.serverName, this.storageDir, this.serverUrl);
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

  private _applyInvalidation(
    state: StoredState,
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
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
        this._codeVerifier = undefined;
        this._cachedTokens = undefined;
        break;
      case "client":
        changedDisk = state.clientInfo !== undefined;
        state.clientInfo = undefined;
        break;
      case "tokens":
        changedDisk = state.tokens !== undefined;
        state.tokens = undefined;
        this._cachedTokens = undefined;
        break;
      case "verifier":
        this._codeVerifier = undefined;
        break;
      case "discovery":
        changedDisk = state.discoveryState !== undefined;
        state.discoveryState = undefined;
        break;
    }
    return changedDisk;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (this.silent) {
      if (scope === "tokens" && !this._reloadedPeerTokens) {
        let diskState: StoredState | undefined;
        try {
          diskState = await loadState(this.serverName, this.storageDir, this.serverUrl);
        } catch {
          // WHY: If disk state is unreadable, fall through to invalidation and AuthRequiredError.
          diskState = undefined;
        }
        if (
          diskState?.tokens &&
          (diskState.tokens.refresh_token !== this._lastReadTokens?.refresh_token ||
            diskState.tokens.access_token !== this._lastReadTokens?.access_token)
        ) {
          // WHY: Another Pi process rotated the single-use refresh token on disk while
          // our refresh request was in flight. Reload the peer's tokens instead of deleting
          // them or throwing AuthRequiredError so the SDK's auth() retry succeeds.
          this._cachedTokens = diskState.tokens;
          this._lastReadTokens = diskState.tokens;
          this._reloadedPeerTokens = true;
          return;
        }
      }

      this._cachedTokens = undefined;
      this._reloadedPeerTokens = false;
      if (scope === "verifier") {
        this._codeVerifier = undefined;
        throw new AuthRequiredError(this.serverName);
      }
      let handle: AuthLockHandle | undefined;
      try {
        handle = await acquireAuthLock(this.serverName, this.storageDir);
        const state = await loadState(this.serverName, this.storageDir, this.serverUrl);
        const changedDisk = this._applyInvalidation(state, scope);
        if (changedDisk) {
          if (this.serverUrl) {
            state.serverUrl = canonicalServerUrl(this.serverUrl);
          }
          await saveState(this.serverName, state, this.storageDir, this.isCancelled);
        }
      } catch {
        // WHY: Best-effort cleanup of rejected credentials on disk; if another process
        // holds the lock or disk is unavailable, still throw AuthRequiredError.
      } finally {
        await handle?.();
      }
      throw new AuthRequiredError(this.serverName);
    }

    await this.assertLockHeld?.();
    if (this.isCancelled()) throw new AuthRequiredError(this.serverName, "Authorization cancelled");
    const state = await loadState(this.serverName, this.storageDir, this.serverUrl);
    const changedDisk = this._applyInvalidation(state, scope);
    await this.assertLockHeld?.();
    if (this.isCancelled()) throw new AuthRequiredError(this.serverName, "Authorization cancelled");
    if (changedDisk) {
      // WHY: Only write back to disk when stored state for this serverUrl actually had
      // credentials to clear, preventing a cancelled or unauthenticated project override
      // from overwriting another server URL's state file before new credentials are saved.
      if (this.serverUrl) {
        state.serverUrl = canonicalServerUrl(this.serverUrl);
      }
      await saveState(this.serverName, state, this.storageDir, this.isCancelled);
    }
  }
}

// ─── Public Helpers ────────────────────────────────────────────────────────────

/**
 * Best-effort invalidation of stored tokens on disk when a resource server
 * rejects an access token with HTTP 401/403. Preserves clientInfo and discoveryState.
 */
export async function invalidateStoredTokens(
  serverName: string,
  storageDir?: string,
  serverUrl?: string,
): Promise<void> {
  let handle: AuthLockHandle | undefined;
  try {
    handle = await acquireAuthLock(serverName, storageDir);
    const state = await loadState(serverName, storageDir, serverUrl);
    if (state.tokens !== undefined) {
      state.tokens = undefined;
      if (serverUrl) {
        state.serverUrl = canonicalServerUrl(serverUrl);
      }
      await saveState(serverName, state, storageDir);
    }
  } catch {
    // WHY: Best-effort token cleanup when a server rejects credentials; ignore lock contention or I/O errors.
  } finally {
    await handle?.();
  }
}

/**
 * Get auth status info for a server — whether tokens exist, when they were saved, etc.
 * Returns null if no auth state file exists at all.
 */
export async function getAuthStatus(
  serverName: string,
  storageDir?: string,
  serverUrl?: string,
): Promise<{
  hasTokens: boolean;
  hasClientInfo: boolean;
  savedAt: string | undefined;
  scope: string | undefined;
} | null> {
  const state = await loadState(serverName, storageDir, serverUrl);
  if (
    state.clientInfo === undefined &&
    state.tokens === undefined &&
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
  try {
    await unlink(statePath(serverName, storageDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

