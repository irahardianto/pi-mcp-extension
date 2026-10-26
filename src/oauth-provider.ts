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
import { McpError } from "./errors.js";
import {
  acquireAuthLock,
  AuthLockError,
  AuthRequiredError,
  type AcquireAuthLockOptions,
  type AuthLockHandle,
} from "./auth-lock.js";
import {
  canonicalServerUrl,
  loadState,
  loadStoredRedirectUrisSync,
  saveState,
  type StoredClientInfo,
  type StoredState,
  type StoredTokens,
} from "./oauth-state-store.js";
import { describeError, reportDiagnostic } from "./debug-log.js";

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

const DEFAULT_CALLBACK_PORT = 19876;
const DEFAULT_REDIRECT_URL = `http://127.0.0.1:${DEFAULT_CALLBACK_PORT}/callback`;

// ─── Pure Client-Information Helpers ──────────────────────────────────────────

interface ClientInformationExtras {
  client_id_issued_at: number;
  client_secret_expires_at: number;
  token_endpoint_auth_method: string;
  redirect_uris: Array<string | URL>;
}

function isClientSecretExpired(info: StoredClientInfo): boolean {
  if (info.client_secret === undefined) return false;
  if (typeof info.client_secret_expires_at !== "number") return false;
  if (info.client_secret_expires_at <= 0) return false;
  return info.client_secret_expires_at * 1000 <= Date.now();
}

function hasRedirectUriMismatch(info: StoredClientInfo, redirectUrl: string): boolean {
  if (!Array.isArray(info.redirect_uris) || info.redirect_uris.length === 0) return false;
  return !info.redirect_uris.includes(redirectUrl);
}

function toOAuthClientInformation(info: StoredClientInfo): OAuthClientInformationMixed {
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

function withoutStaticClientId<T>(hasStaticClientId: boolean, value: T | undefined): T | undefined {
  return hasStaticClientId ? undefined : value;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function redirectUrisOrUndefined(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((uri) => String(uri)) : undefined;
}

function buildInteractiveStoredClientInfo(
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

function isPeerRotatedTokens(
  diskTokens: StoredTokens | undefined,
  lastReadTokens: StoredTokens | undefined,
): diskTokens is StoredTokens {
  if (!diskTokens) return false;
  return (
    diskTokens.refresh_token !== lastReadTokens?.refresh_token ||
    diskTokens.access_token !== lastReadTokens?.access_token
  );
}

export interface McpOAuthProviderOptions {
  serverName: string;
  authConfig: AuthConfig;
  serverUrl?: string | undefined;
  storageDir?: string | undefined;
  mode?: "silent" | "interactive" | undefined;
  redirectUrl?: string | URL | undefined;
  onAuthRequired?: ((url: URL) => void | Promise<void>) | undefined;
  isCancelled?: (() => boolean) | undefined;
  assertLockHeld?: (() => Promise<void>) | undefined;
}

// ─── OAuthClientProvider Implementation ────────────────────────────────────────

export class McpOAuthProvider implements OAuthClientProvider {
  private readonly serverName: string;
  private readonly authConfig: AuthConfig;
  private readonly serverUrl: string | undefined;
  private readonly storageDir: string | undefined;
  private readonly mode: "silent" | "interactive";
  private readonly explicitRedirectUrl: string | URL | undefined;
  private readonly _onAuthRequired: ((url: URL) => void | Promise<void>) | undefined;
  private readonly isCancelled: () => boolean;
  private readonly assertLockHeld: (() => Promise<void>) | undefined;

  private _oauthState: string | undefined;
  private _codeVerifier: string | undefined;
  private _cachedTokens: StoredTokens | undefined;
  private _lastReadTokens: StoredTokens | undefined;
  private _reloadedPeerTokens = false;
  private _storedRedirectUris: string[] | null | undefined;

  constructor(options: McpOAuthProviderOptions) {
    this.serverName = options.serverName;
    this.authConfig = options.authConfig;
    this.serverUrl = options.serverUrl;
    this.storageDir = options.storageDir;
    this.mode = options.mode ?? "interactive";
    this.explicitRedirectUrl = options.redirectUrl;
    this._onAuthRequired = options.onAuthRequired;
    this.isCancelled = options.isCancelled ?? (() => false);
    this.assertLockHeld = options.assertLockHeld;
  }

  private get silent(): boolean {
    return this.mode === "silent";
  }

  private getStoredRedirectUrisSync(): string[] | undefined {
    if (this._storedRedirectUris !== undefined) {
      return this._storedRedirectUris ?? undefined;
    }
    const stored = loadStoredRedirectUrisSync(this.serverName, this.storageDir, this.serverUrl);
    this._storedRedirectUris = stored ?? null;
    return stored;
  }

  // --- redirectUrl ---

  get redirectUrl(): string | URL {
    if (this.mode === "silent") {
      // WHY: A silent provider never starts an authorization flow, but clientMetadata.redirect_uris
      // must still match what the client was registered with. Prefer the stored DCR redirect_uris
      // (preserved per AGENTS.md), then the configured auth.redirectUrl, then the default 127.0.0.1:19876 callback.
      const stored = this.getStoredRedirectUrisSync();
      if (stored && stored.length > 0 && stored[0] !== undefined) {
        return stored[0];
      }
    }
    // WHY: In interactive mode, redirectUrl is the URL the callback server actually bound
    // (passed in by authorize()), falling back to configured auth.redirectUrl, then the default
    // 127.0.0.1:19876 callback URL.
    return (
      this.explicitRedirectUrl ??
      this.authConfig.redirectUrl ??
      DEFAULT_REDIRECT_URL
    );
  }

  // --- clientMetadata ---

  get clientMetadata(): OAuthClientMetadata {
    // WHY: A silent provider never starts an authorization flow, but clientMetadata.redirect_uris
    // must still match what the client was registered with. Prefer the stored DCR redirect_uris
    // (preserved per AGENTS.md), then the configured auth.redirectUrl, then the default 127.0.0.1:19876 callback.
    let redirectUris: string[];
    if (this.mode === "silent") {
      const stored = this.getStoredRedirectUrisSync();
      if (stored && stored.length > 0) {
        redirectUris = stored;
      } else {
        redirectUris = [String(this.explicitRedirectUrl ?? this.authConfig.redirectUrl ?? DEFAULT_REDIRECT_URL)];
      }
    } else {
      redirectUris = [String(this.redirectUrl)];
    }
    return {
      client_name: `pi-mcp/${this.serverName}`,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.authConfig.clientSecret ? "client_secret_basic" : "none",
      ...(this.authConfig.scope && { scope: this.authConfig.scope }),
    };
  }

  // --- clientInformation ---

  private async _staticClientInformation(): Promise<OAuthClientInformationMixed> {
    const state = await loadState(this.serverName, this.storageDir, this.serverUrl);
    const boundIssuer =
      state.clientInfo?.client_id === this.authConfig.clientId ? state.clientInfo?.issuer : undefined;
    return {
      client_id: this.authConfig.clientId!,
      ...(this.authConfig.clientSecret && { client_secret: this.authConfig.clientSecret }),
      ...(boundIssuer !== undefined && { issuer: boundIssuer }),
    };
  }

  private _cacheStoredRedirectUris(info: StoredClientInfo): void {
    if (Array.isArray(info.redirect_uris) && info.redirect_uris.length > 0) {
      this._storedRedirectUris = info.redirect_uris;
    }
  }

  private _resolveStoredClientInfo(info: StoredClientInfo): OAuthClientInformationMixed | undefined {
    this._cacheStoredRedirectUris(info);
    if (isClientSecretExpired(info)) {
      if (this.silent) {
        throw new AuthRequiredError(
          this.serverName,
          "Stored OAuth client secret has expired; interactive re-authentication required",
        );
      }
      return undefined;
    }
    if (!this.silent && hasRedirectUriMismatch(info, String(this.redirectUrl))) {
      // WHY: If the callback port or configured redirectUrl changed since DCR,
      // return undefined in interactive mode so the SDK re-registers with the new redirect_uri.
      return undefined;
    }
    return toOAuthClientInformation(info);
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    // If static credentials provided, use those
    if (this.authConfig.clientId) {
      return this._staticClientInformation();
    }
    // Otherwise load from persisted DCR state
    const state = await loadState(this.serverName, this.storageDir, this.serverUrl);
    if (state.clientInfo) {
      return this._resolveStoredClientInfo(state.clientInfo);
    }
    if (this.silent) throw new AuthRequiredError(this.serverName);
    return undefined;
  }

  // --- saveClientInformation (DCR) ---

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    const issuerToBind =
      typeof clientInformation.issuer === "string" ? clientInformation.issuer : undefined;
    if (this.silent) {
      await this._saveClientInformationSilent(clientInformation, issuerToBind);
      return;
    }
    await this._saveClientInformationInteractive(clientInformation, issuerToBind);
  }

  private _assertIssuerBindingCompatible(
    existingIssuer: string | undefined,
    nextIssuer: string | undefined,
  ): void {
    if (existingIssuer === undefined || nextIssuer === undefined || existingIssuer === nextIssuer) {
      return;
    }
    // WHY: A stored client already bound to an authorization server issuer must never be
    // re-bound to a different issuer. Switching authorization servers requires an explicit reset.
    throw new McpError(
      `OAuth client for "${this.serverName}" is already bound to authorization server ${existingIssuer} and cannot be bound to ${nextIssuer}. Run /mcp:auth ${this.serverName} --reset to re-authorize.`,
      this.serverName,
      "auth",
    );
  }

  private _mergeSilentClientInfo(
    storedClient: StoredClientInfo,
    issuerToBind: string | undefined,
  ): StoredClientInfo {
    // WHY: Mirror silent saveTokens: pure issuer binding of the already-known client
    // preserves all stored credentials and DCR metadata on disk while stamping issuer.
    return {
      ...storedClient,
      client_secret: this.authConfig.clientId ? undefined : storedClient.client_secret,
      issuer: issuerToBind ?? storedClient.issuer,
    };
  }

  private _newSilentClientInfo(
    clientInformation: OAuthClientInformationMixed,
    issuerToBind: string | undefined,
  ): StoredClientInfo {
    return {
      client_id: clientInformation.client_id,
      client_secret: this.authConfig.clientId
        ? undefined
        : (this.authConfig.clientSecret ?? clientInformation.client_secret),
      client_id_issued_at: undefined,
      client_secret_expires_at: undefined,
      token_endpoint_auth_method: undefined,
      redirect_uris: undefined,
      issuer: issuerToBind,
    };
  }

  private _reportClientInfoSaved(): void {
    reportDiagnostic({
      level: "info",
      event: "oauth.client_info_saved",
      server: this.serverName,
      message: `Stored OAuth client information for "${this.serverName}"`,
      fields: { outcome: "saved" },
    });
  }

  private _reportClientInfoPersistFailure(err: unknown): void {
    if (err instanceof AuthRequiredError || err instanceof McpError) {
      throw err;
    }
    // WHY: When another process holds the interactive auth lock (e.g. during an interactive
    // /mcp:auth or --reset), acquireAuthLock fails fast. We skip this background binding
    // without failing the refresh — the SDK will bind client information again on the next refresh.
    if (err instanceof AuthLockError) return;
    const { kind, message } = describeError(err);
    reportDiagnostic({
      level: "error",
      event: "oauth.client_info_persist_failed",
      server: this.serverName,
      message: `Failed to persist OAuth client info for "${this.serverName}": ${message}`,
      fields: { kind },
    });
  }

  private async _saveClientInformationSilent(
    clientInformation: OAuthClientInformationMixed,
    issuerToBind: string | undefined,
  ): Promise<void> {
    let handle: AuthLockHandle | undefined;
    try {
      handle = await acquireAuthLock(this.serverName, this.storageDir);
      const state = await loadState(this.serverName, this.storageDir, this.serverUrl);
      const storedClient = state.clientInfo;
      const matchingId = this.authConfig.clientId ?? storedClient?.client_id;
      if (!matchingId || clientInformation.client_id !== matchingId) {
        // WHY: Silent background connections must never execute Dynamic Client Registration
        // for a new or different client_id without interactive user consent.
        throw new AuthRequiredError(this.serverName);
      }
      this._assertIssuerBindingCompatible(storedClient?.issuer, issuerToBind);
      if (this.serverUrl) {
        state.serverUrl = canonicalServerUrl(this.serverUrl);
      }
      state.clientInfo = storedClient
        ? this._mergeSilentClientInfo(storedClient, issuerToBind)
        : this._newSilentClientInfo(clientInformation, issuerToBind);
      await saveState(this.serverName, state, this.storageDir, this.isCancelled);
      this._reportClientInfoSaved();
    } catch (err) {
      this._reportClientInfoPersistFailure(err);
    } finally {
      await handle?.();
    }
  }

  private async _saveClientInformationInteractive(
    clientInformation: OAuthClientInformationMixed,
    issuerToBind: string | undefined,
  ): Promise<void> {
    if (this.isCancelled()) throw new AuthRequiredError(this.serverName, "Authorization cancelled");
    await this.assertLockHeld?.();
    const state = await loadState(this.serverName, this.storageDir, this.serverUrl);
    const storedClient = state.clientInfo;
    if (storedClient?.client_id === clientInformation.client_id) {
      this._assertIssuerBindingCompatible(storedClient.issuer, issuerToBind);
    }
    if (this.serverUrl) {
      state.serverUrl = canonicalServerUrl(this.serverUrl);
    }
    const storedClientInfo = buildInteractiveStoredClientInfo(
      clientInformation,
      Boolean(this.authConfig.clientId),
      issuerToBind,
    );
    state.clientInfo = storedClientInfo;
    this._cacheStoredRedirectUris(storedClientInfo);
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
    if (storedTokens.issuer !== undefined) tokens.issuer = storedTokens.issuer;
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
      issuer: typeof tokens.issuer === "string" ? tokens.issuer : undefined,
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
        reportDiagnostic({
          level: "info",
          event: "oauth.refresh",
          server: this.serverName,
          message: `Refreshed OAuth tokens for "${this.serverName}"`,
          fields: { outcome: "rotated", peerReloaded: false },
        });
      } catch (err) {
        // WHY: When another process holds the interactive auth lock (e.g. during --reset),
        // keep the refreshed tokens in memory for this session without clobbering disk state.
        this._cachedTokens = storedTokens;
        this._lastReadTokens = storedTokens;
        this._reloadedPeerTokens = false;
        if (!(err instanceof AuthLockError)) {
          const { kind, message } = describeError(err);
          reportDiagnostic({
            level: "error",
            event: "oauth.tokens_persist_failed",
            server: this.serverName,
            message: `Failed to persist refreshed OAuth tokens for "${this.serverName}": ${message}`,
            fields: { kind },
          });
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
    reportDiagnostic({
      level: "info",
      event: "oauth.tokens_saved",
      server: this.serverName,
      message: `Stored OAuth tokens for "${this.serverName}"`,
      fields: { outcome: "authorized", peerReloaded: false },
    });
  }

  // --- redirectToAuthorization ---

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this._onAuthRequired) {
      await this._onAuthRequired(authorizationUrl);
    } else {
      // Fallback: no interactive handler is wired, so the authorization URL is
      // surfaced through the diagnostic sink. The URL carries no credential
      // (no authorization code, no PKCE verifier) and is redacted like any
      // other message before it is written to the log file.
      reportDiagnostic({
        level: "info",
        event: "oauth.authorization_required",
        server: this.serverName,
        message: `OAuth authorization required for "${this.serverName}". Open this URL in your browser: ${authorizationUrl.toString()}`,
        fields: { outcome: "redirect" },
        notify: true,
        // WHY: this fallback fires only headless (no interactive handler is
        // wired); the URL is the only way to proceed, so it must reach stderr.
        stderr: true,
      });
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
        this._storedRedirectUris = undefined;
        break;
      case "client":
        changedDisk = state.clientInfo !== undefined;
        state.clientInfo = undefined;
        this._storedRedirectUris = undefined;
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

  private async _readDiskStateForPeerReload(): Promise<StoredState | undefined> {
    try {
      return await loadState(this.serverName, this.storageDir, this.serverUrl);
    } catch {
      // WHY: If disk state is unreadable, fall through to invalidation and AuthRequiredError.
      return undefined;
    }
  }

  private async _tryReloadPeerRotatedTokens(): Promise<boolean> {
    if (this._reloadedPeerTokens) return false;
    const diskTokens = (await this._readDiskStateForPeerReload())?.tokens;
    if (!isPeerRotatedTokens(diskTokens, this._lastReadTokens)) return false;
    // WHY: Another Pi process rotated the single-use refresh token on disk while
    // our refresh request was in flight. Reload the peer's tokens instead of deleting
    // them or throwing AuthRequiredError so the SDK's auth() retry succeeds.
    this._cachedTokens = diskTokens;
    this._lastReadTokens = diskTokens;
    this._reloadedPeerTokens = true;
    reportDiagnostic({
      level: "info",
      event: "oauth.refresh",
      server: this.serverName,
      message: `Reloaded OAuth tokens rotated by another Pi process for "${this.serverName}"`,
      fields: { outcome: "peer_reloaded", peerReloaded: true },
    });
    return true;
  }

  private async _removeCredentialsFromDisk(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    let handle: AuthLockHandle | undefined;
    try {
      handle = await acquireAuthLock(this.serverName, this.storageDir);
      const state = await loadState(this.serverName, this.storageDir, this.serverUrl);
      const changedDisk = this._applyInvalidation(state, scope);
      if (!changedDisk) return;
      if (this.serverUrl) {
        state.serverUrl = canonicalServerUrl(this.serverUrl);
      }
      await saveState(this.serverName, state, this.storageDir, this.isCancelled);
    } catch {
      // WHY: Best-effort cleanup of rejected credentials on disk; if another process
      // holds the lock or disk is unavailable, still throw AuthRequiredError.
    } finally {
      await handle?.();
    }
  }

  private async _invalidateCredentialsSilent(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "tokens" && (await this._tryReloadPeerRotatedTokens())) return;
    this._cachedTokens = undefined;
    this._reloadedPeerTokens = false;
    if (scope === "verifier") {
      this._codeVerifier = undefined;
      throw new AuthRequiredError(this.serverName);
    }
    await this._removeCredentialsFromDisk(scope);
    throw new AuthRequiredError(this.serverName);
  }

  private async _invalidateCredentialsInteractive(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    await this.assertLockHeld?.();
    if (this.isCancelled()) throw new AuthRequiredError(this.serverName, "Authorization cancelled");
    const state = await loadState(this.serverName, this.storageDir, this.serverUrl);
    const changedDisk = this._applyInvalidation(state, scope);
    await this.assertLockHeld?.();
    if (this.isCancelled()) throw new AuthRequiredError(this.serverName, "Authorization cancelled");
    if (!changedDisk) return;
    // WHY: Only write back to disk when stored state for this serverUrl actually had
    // credentials to clear, preventing a cancelled or unauthenticated project override
    // from overwriting another server URL's state file before new credentials are saved.
    if (this.serverUrl) {
      state.serverUrl = canonicalServerUrl(this.serverUrl);
    }
    await saveState(this.serverName, state, this.storageDir, this.isCancelled);
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (this.silent) {
      await this._invalidateCredentialsSilent(scope);
      return;
    }
    await this._invalidateCredentialsInteractive(scope);
  }
}

export { getAuthStatus, invalidateStoredTokens, resetAuth } from "./oauth-status.js";

