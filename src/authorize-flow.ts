import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { CallbackServer } from "./callback-server.js";
import { callbackServerConfigFromRedirectUrl } from "./callback-url.js";
import {
  discoverManualAuthChallenge,
  createHeadersFetch,
  stripAuthorizationHeader,
  type ManualAuthChallenge,
} from "./auth-challenge.js";
import { acquireAuthLock, type AuthLockHandle } from "./auth-lock.js";
import { McpOAuthProvider } from "./oauth-provider.js";
import {
  buildTokenClientRejectionError,
  parseTokenClientRejectionError,
  type TokenClientRejectionErrorCode,
} from "./oauth-policy.js";
import { McpError, AuthCancelledError, AuthLockError } from "./errors.js";
import { describeError } from "./debug-log-format.js";
import { reportDiagnostic } from "./debug-log.js";
import {
  createAuthorizationBrowserLauncher,
  openBrowser,
  reopenAuthorizationBrowser,
} from "./authorize-browser.js";
import { waitForOAuthCallback } from "./authorize-dialog.js";
import type { ServerConfig } from "./config.js";
import type { ServerManager } from "./server-manager.js";

export { AuthCancelledError } from "./errors.js";
export {
  browserOpenCommand,
  openBrowser,
  type BrowserOpenCommand,
} from "./authorize-browser.js";
export {
  authCancelOption,
  authPasteOption,
  authRetryOption,
  waitForOAuthCallback,
  type OAuthPasteOptions,
} from "./authorize-dialog.js";

export interface AuthorizeDeps {
  manager: ServerManager;
  getServerConfig?: ((name: string) => ServerConfig | undefined) | undefined;
  authStorageDir?: string | undefined;
  openBrowser?: ((url: string) => void | Promise<void>) | undefined;
  callbackServer?: CallbackServer | undefined;
}

// ─── Authorize Helpers ────────────────────────────────────────────────────────

/** Mutable per-run state shared across the authorize helpers. */
interface AuthorizeRunState {
  /** CSRF state parameter; undefined until the callback server is listening. */
  oauthState: string | undefined;
  /** Last authorization URL handed to the browser, replayed by the "Retry" option. */
  latestAuthorizationUrl: URL | undefined;
  /** Set by the auth lock's `onLost` callback; re-checked after every await boundary. */
  lockLost: boolean;
}

type SdkAuthResult = "AUTHORIZED" | "REDIRECT";

interface AuthOptionsBase {
  serverUrl: string;
  resourceMetadataUrl?: URL;
  scope?: string;
  fetchFn?: typeof fetch;
}

interface AcquireAuthorizeLockParams {
  deps: AuthorizeDeps;
  serverName: string;
  signal: AbortSignal;
  reset: boolean;
  onLockLost: () => void;
}

interface StartCallbackServerParams {
  serverName: string;
  config: ServerConfig;
  callbackServer: CallbackServer;
  ctx: ExtensionContext;
  signal: AbortSignal;
  isLockLost: () => boolean;
}

interface InteractiveAuthProviderParams {
  serverName: string;
  config: ServerConfig;
  serverUrl: string;
  redirectUrl: string;
  deps: AuthorizeDeps;
  signal: AbortSignal;
  unlock: AuthLockHandle;
  onAuthRequired: (url: URL) => Promise<void>;
}

interface ChallengeDiscoveryParams {
  serverName: string;
  serverUrl: string;
  headers: Record<string, string> | undefined;
  signal: AbortSignal;
}

interface RedirectAuthFlowParams {
  serverName: string;
  serverUrl: string;
  hasStaticClientId: boolean;
  ctx: ExtensionContext;
  authProvider: McpOAuthProvider;
  authChallenge: ManualAuthChallenge;
  customFetch: typeof fetch | undefined;
  callbackPromise: Promise<string>;
  oauthState: string;
  reopenBrowser: () => Promise<void>;
  onPasteResolved: () => void;
  assertActive: () => void;
}

interface ExchangeAuthorizationCodeParams {
  serverName: string;
  serverUrl: string;
  hasStaticClientId: boolean;
  authProvider: McpOAuthProvider;
  authChallenge: ManualAuthChallenge;
  customFetch: typeof fetch | undefined;
  code: string;
  assertActive: () => void;
}

function resolveAuthorizeConfig(deps: AuthorizeDeps, serverName: string): ServerConfig {
  const server = deps.manager.getServer(serverName);
  const config = deps.getServerConfig ? deps.getServerConfig(serverName) : server?.config;
  if (!config) {
    throw new McpError(`Unknown server "${serverName}"`, serverName, "config");
  }
  return config;
}

function requireServerUrl(config: ServerConfig, serverName: string): string {
  // Validate that we have a server URL (required for OAuth)
  if (!config.url) {
    throw new McpError(
      `Server "${serverName}" has OAuth configured but no URL. OAuth requires a URL-based server transport.`,
      serverName,
      "config",
    );
  }
  return config.url;
}

/**
 * Fail fast at every await boundary once the caller aborted or the auth lock was
 * taken over by another process.
 */
function assertAuthorizeActive(serverName: string, signal: AbortSignal, lockLost: boolean): void {
  if (signal.aborted) throw new AuthCancelledError(serverName);
  if (lockLost) throw new AuthLockError(serverName, `Authorization lock lost for ${serverName}; retry`);
}

function generateOAuthState(): string {
  // 2. Generate a cryptographically secure state parameter for CSRF protection
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b: number) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isCorruptOAuthStateError(err: unknown): err is McpError {
  return err instanceof McpError && err.code === "config" && /Corrupt OAuth state file/i.test(err.message);
}

function reportCorruptOAuthState(serverName: string, err: McpError): void {
  const { kind, message } = describeError(err);
  reportDiagnostic({
    level: "warn",
    event: "oauth.state_corrupt",
    server: serverName,
    message,
    fields: { kind },
  });
}

function notifyAuthorizationSucceeded(ctx: ExtensionContext, serverName: string): void {
  ctx.ui.notify(`pi-mcp: ${serverName} authenticated successfully. Starting MCP server...`, "info");
}

/**
 * Report a failed authorize run, and surface a lost lock as `AuthLockError` so
 * callers retry instead of seeing an unrelated downstream error.
 */
function reportAuthorizeFailure(
  serverName: string,
  err: unknown,
  signal: AbortSignal,
  lockLost: boolean,
): void {
  const { kind, message } = describeError(err);
  reportDiagnostic({
    level: err instanceof AuthCancelledError ? "info" : "error",
    event: "auth.failed",
    server: serverName,
    message: `OAuth authorization failed for "${serverName}": ${message}`,
    fields: { kind },
  });
  if (lockLost && !signal.aborted) {
    throw new AuthLockError(serverName, `Authorization lock lost for ${serverName}; retry`);
  }
}

/**
 * Take the authorization lock, then clear stored auth when the caller requested
 * a reset. Fails fast if the run was aborted before or during acquisition, and
 * releases the lock if post-acquisition setup fails before returning the handle.
 */
async function acquireAuthorizeLock(params: AcquireAuthorizeLockParams): Promise<AuthLockHandle> {
  const { deps, serverName, signal, reset, onLockLost } = params;
  assertAuthorizeActive(serverName, signal, false);
  const unlock = await acquireAuthLock(serverName, deps.authStorageDir, { onLost: onLockLost });
  try {
    assertAuthorizeActive(serverName, signal, false);
    if (reset) {
      await unlock.assertHeld();
      await deps.manager.resetServerAuth(serverName);
    }
    return unlock;
  } catch (err) {
    await unlock();
    throw err;
  }
}

/**
 * Require an interactive UI, then bind (or reuse) the loopback callback server.
 * Returns the port that is actually listening.
 */
async function startAuthorizationCallbackServer(params: StartCallbackServerParams): Promise<number> {
  const { serverName, config, callbackServer, ctx, signal, isLockLost } = params;
  if (!ctx.hasUI) throw new Error(`Authorization for ${serverName} requires an interactive Pi session`);
  assertAuthorizeActive(serverName, signal, isLockLost());

  // 1. Start the callback server
  const callbackServerConfig = callbackServerConfigFromRedirectUrl(config.auth?.redirectUrl);
  const port = await callbackServer.ensure(callbackServerConfig.preferredPort, {
    host: callbackServerConfig.host,
    allowPortFallback: callbackServerConfig.allowPortFallback,
  });
  assertAuthorizeActive(serverName, signal, isLockLost());
  return port;
}

/** Create the interactive-mode OAuth provider wired to the run's lock and signal. */
function createInteractiveAuthProvider(params: InteractiveAuthProviderParams): McpOAuthProvider {
  const { serverName, config, serverUrl, redirectUrl, deps, signal, unlock, onAuthRequired } = params;
  return new McpOAuthProvider({
    serverName,
    authConfig: config.auth || { type: "oauth" },
    onAuthRequired,
    storageDir: deps.authStorageDir,
    mode: "interactive",
    isCancelled: () => signal.aborted,
    assertLockHeld: () => unlock.assertHeld(),
    serverUrl,
    redirectUrl,
  });
}

/**
 * Drop stored tokens before an interactive run so the SDK cannot silently refresh
 * and return "AUTHORIZED" without opening the browser. A corrupt state file is
 * reported and tolerated, because `_loadState()` already removed it.
 */
async function clearStoredTokensBeforeInteractiveAuth(
  authProvider: McpOAuthProvider,
  serverName: string,
): Promise<void> {
  // WHY: authorize() is only entered after silent connect failed with AuthRequiredError.
  // If a refresh_token remained on disk (e.g. accepted by the Authorization Server
  // while the Resource Server rejects the refreshed access token), the SDK's auth()
  // would silently refresh and return "AUTHORIZED" without opening the browser.
  // Clear stored tokens while preserving clientInfo and discoveryState.
  try {
    await authProvider.invalidateCredentials("tokens");
  } catch (err) {
    if (!isCorruptOAuthStateError(err)) throw err;
    reportCorruptOAuthState(serverName, err);
  }
}

/**
 * Discover protected-resource challenge metadata, falling back to standard
 * discovery when the resource server does not advertise it.
 */
function discoverChallengeWithFallback(params: ChallengeDiscoveryParams): Promise<ManualAuthChallenge> {
  const { serverName, serverUrl, headers, signal } = params;
  // 4. Discover protected-resource challenge metadata from the server.
  return discoverManualAuthChallenge(serverUrl, { headers, signal }).catch((): ManualAuthChallenge => {
    if (signal.aborted) {
      throw new AuthCancelledError(serverName);
    }
    reportDiagnostic({
      level: "warn",
      event: "auth.challenge_discovery_failed",
      server: serverName,
      message: `Failed to discover OAuth challenge for "${serverName}"; falling back to standard discovery`,
    });
    return {};
  });
}

/**
 * Register the callback waiter before `auth()` can open the browser. Attach a
 * catch handler so cancellation after immediate authorization does not produce an
 * unhandled rejection.
 */
function registerCallbackPromise(callbackServer: CallbackServer, oauthState: string): Promise<string> {
  // 5. Register the callback immediately before auth() can open the browser.
  const callbackPromise = callbackServer.waitForCallback(oauthState);
  callbackPromise.catch(() => {
    // WHY: Suppress unhandled rejection when callbackPromise is cancelled after immediate authorization.
  });
  return callbackPromise;
}

/** Apply the discovered challenge values and static headers to SDK auth options. */
function withChallengeOptions<T extends AuthOptionsBase>(
  base: T,
  authChallenge: ManualAuthChallenge,
  customFetch: typeof fetch | undefined,
): T {
  if (authChallenge.resourceMetadataUrl) {
    base.resourceMetadataUrl = authChallenge.resourceMetadataUrl;
  }
  if (authChallenge.scope) {
    base.scope = authChallenge.scope;
  }
  if (customFetch) {
    base.fetchFn = customFetch;
  }
  return base;
}

function buildSdkAuthOptions(
  serverUrl: string,
  authChallenge: ManualAuthChallenge,
  customFetch: typeof fetch | undefined,
): AuthOptionsBase {
  return withChallengeOptions({ serverUrl }, authChallenge, customFetch);
}

function buildFinishAuthOptions(
  serverUrl: string,
  authChallenge: ManualAuthChallenge,
  customFetch: typeof fetch | undefined,
  authorizationCode: string,
): AuthOptionsBase & { authorizationCode: string } {
  return withChallengeOptions({ serverUrl, authorizationCode }, authChallenge, customFetch);
}

/**
 * Run the initial SDK auth call, retrying once when a corrupt state file was
 * backed up and removed by `McpOAuthProvider._loadState()`.
 */
async function runInitialSdkAuth(
  authProvider: McpOAuthProvider,
  authOptions: AuthOptionsBase,
  serverName: string,
): Promise<SdkAuthResult> {
  // 6. Start the auth flow.
  // Why branch on the return value: the SDK auth() call returns "AUTHORIZED" when
  // stored or refreshed tokens already succeeded without opening a browser, or
  // "REDIRECT" after invoking redirectToAuthorization(), in which case we must
  // wait for the callback code and call auth() a second time with authorizationCode.
  try {
    return await auth(authProvider, authOptions);
  } catch (err) {
    if (!isCorruptOAuthStateError(err)) throw err;
    // WHY: McpOAuthProvider._loadState() backed up and removed the corrupt state file.
    // Retry auth() once so interactive authorization proceeds cleanly.
    reportCorruptOAuthState(serverName, err);
    return auth(authProvider, authOptions);
  }
}

function isPostRequest(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): boolean {
  const method = init?.method ?? (input instanceof Request ? input.method : undefined);
  return method?.toUpperCase() === "POST";
}

async function readTokenClientRejection(
  response: Response,
): Promise<TokenClientRejectionErrorCode | undefined> {
  try {
    return parseTokenClientRejectionError(await response.clone().text());
  } catch {
    // WHY: Non-cloneable or unreadable response bodies fall back to the default client-rejection
    // code; the SDK still parses the original response body and drives credential invalidation.
    return undefined;
  }
}

/**
 * Wrap `fetch` during authorization-code exchange so an `invalid_client` or
 * `unauthorized_client` body from `/token` is recorded before the MCP SDK
 * swallows the error and invokes `invalidateCredentials("all")`.
 */
function createTokenExchangeFetch(
  baseFetch: typeof fetch | undefined,
  onClientRejection: (code: TokenClientRejectionErrorCode) => void,
): typeof fetch {
  return async (input, init) => {
    const response = await (baseFetch ?? globalThis.fetch)(input, init);
    if (!response.ok && isPostRequest(input, init)) {
      const code = await readTokenClientRejection(response);
      if (code) onClientRejection(code);
    }
    return response;
  };
}

/**
 * Exchange the authorization code for tokens while guarding against the MCP SDK's
 * `InvalidClientError` / `UnauthorizedClientError` retry loop: after `auth()` runs
 * `invalidateCredentials("all")` to wipe stored client info and the PKCE verifier,
 * it immediately re-enters `authInternal()` with `authorizationCode` still set, which
 * would run redundant discovery, re-write discoveryState to disk, and fail with a
 * cryptic missing-client or missing-PKCE error. Throwing an actionable `McpError`
 * right after cleanup completes stops that futile retry and surfaces the real cause.
 */
async function exchangeAuthorizationCode(
  params: ExchangeAuthorizationCodeParams,
): Promise<SdkAuthResult> {
  const {
    serverName,
    serverUrl,
    hasStaticClientId,
    authProvider,
    authChallenge,
    customFetch,
    code,
    assertActive,
  } = params;
  let clientRejectionError: TokenClientRejectionErrorCode | undefined;
  const exchangeFetch = createTokenExchangeFetch(customFetch, (errorCode) => {
    clientRejectionError = errorCode;
  });
  const originalInvalidate = authProvider.invalidateCredentials.bind(authProvider);
  authProvider.invalidateCredentials = async (scope) => {
    await originalInvalidate(scope);
    if (scope === "all") {
      assertActive();
      throw buildTokenClientRejectionError(serverName, hasStaticClientId, clientRejectionError);
    }
  };
  try {
    return await auth(
      authProvider,
      buildFinishAuthOptions(serverUrl, authChallenge, exchangeFetch, code),
    );
  } finally {
    authProvider.invalidateCredentials = originalInvalidate;
  }
}

/**
 * Drive the REDIRECT half of the flow: wait for the loopback callback (or a
 * pasted redirect URL), then exchange the authorization code for tokens.
 */
async function completeRedirectAuthFlow(params: RedirectAuthFlowParams): Promise<void> {
  const {
    serverName,
    serverUrl,
    hasStaticClientId,
    ctx,
    authProvider,
    authChallenge,
    customFetch,
    callbackPromise,
    oauthState,
    reopenBrowser,
    onPasteResolved,
    assertActive,
  } = params;

  // 7. Wait for the callback while giving the user an escape hatch.
  const code = await waitForOAuthCallback(
    serverName,
    callbackPromise,
    reopenBrowser,
    ctx,
    {
      redirectUrl: authProvider.redirectUrl,
      expectedState: oauthState,
      onPasteResolved,
    },
  );
  assertActive();
  ctx.ui.notify(
    `pi-mcp: Authorization callback received for ${serverName}. Exchanging token...`,
    "info",
  );

  // 8. Complete the OAuth flow with the authorization code
  const finishAuthResult = await exchangeAuthorizationCode({
    serverName,
    serverUrl,
    hasStaticClientId,
    authProvider,
    authChallenge,
    customFetch,
    code,
    assertActive,
  });
  assertActive();

  if (finishAuthResult !== "AUTHORIZED") {
    throw new McpError(
      `Unexpected auth completion result: ${finishAuthResult}`,
      serverName,
      "protocol",
    );
  }

  notifyAuthorizationSucceeded(ctx, serverName);
}

export async function authorize(
  deps: AuthorizeDeps,
  serverName: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
  reset: boolean,
): Promise<void> {
  const config = resolveAuthorizeConfig(deps, serverName);
  const callbackServer = deps.callbackServer ?? new CallbackServer();
  const browserOpener = deps.openBrowser ?? openBrowser;
  const state: AuthorizeRunState = {
    oauthState: undefined,
    latestAuthorizationUrl: undefined,
    lockLost: false,
  };
  const assertActive = (): void => assertAuthorizeActive(serverName, signal, state.lockLost);
  const cancel = (): void => {
    if (state.oauthState) callbackServer.cancel(state.oauthState);
  };
  signal.addEventListener("abort", cancel, { once: true });
  let unlock: AuthLockHandle | undefined;
  reportDiagnostic({
    level: "info",
    event: "auth.started",
    server: serverName,
    message: `Starting OAuth authorization for "${serverName}"`,
    fields: { outcome: reset ? "reset" : "authorize" },
  });
  try {
    const authLock = await acquireAuthorizeLock({
      deps,
      serverName,
      signal,
      reset,
      onLockLost: () => {
        state.lockLost = true;
        reportDiagnostic({
          level: "warn",
          event: "auth.lock_lost",
          server: serverName,
          message: `Authorization lock lost for "${serverName}"`,
          fields: { outcome: "contended" },
        });
        cancel();
      },
    });
    unlock = authLock;

    const serverUrl = requireServerUrl(config, serverName);

    ctx.ui.notify(
      `pi-mcp: Starting OAuth flow for ${serverName}...`,
      "info",
    );

    const port = await startAuthorizationCallbackServer({
      serverName,
      config,
      callbackServer,
      ctx,
      signal,
      isLockLost: () => state.lockLost,
    });

    // WHY: In interactive mode, redirectUrl must match the port that the callback server
    // actually bound (which may differ from preferredPort if port fallback was used).
    const boundRedirectUrl = config.auth?.redirectUrl ?? `http://127.0.0.1:${port}/callback`;

    const oauthState = generateOAuthState();
    state.oauthState = oauthState;

    // 3. Create the auth provider.
    const launchAuthorizationBrowser = createAuthorizationBrowserLauncher({
      serverName,
      port,
      ctx,
      browserOpener,
      isInactive: () => signal.aborted || state.lockLost,
      onUrlRecorded: (url) => {
        state.latestAuthorizationUrl = url;
      },
    });

    const authProvider = createInteractiveAuthProvider({
      serverName,
      config,
      serverUrl,
      redirectUrl: boundRedirectUrl,
      deps,
      signal,
      unlock: authLock,
      onAuthRequired: launchAuthorizationBrowser,
    });

    if (!reset) {
      await clearStoredTokensBeforeInteractiveAuth(authProvider, serverName);
      assertActive();
    }

    // Why set state before calling auth(): the SDK reads provider.state() while
    // building the authorization URL inside auth(), and omits the state parameter
    // if empty, which the callback server then rejects as a CSRF error.
    authProvider.setState(oauthState);

    // WHY: `Authorization` belongs to the OAuth flow here. Filter the same set the transport
    // uses, so this flow's own challenge probe and its SDK `fetchFn` (metadata, registration,
    // token) never carry a static credential that was configured for the MCP server — the
    // authorization server is usually a different origin.
    const staticHeaders = stripAuthorizationHeader(config.headers);

    const authChallenge = await discoverChallengeWithFallback({
      serverName,
      serverUrl,
      headers: staticHeaders,
      signal,
    });
    assertActive();

    const callbackPromise = registerCallbackPromise(callbackServer, oauthState);
    const customFetch = staticHeaders ? createHeadersFetch(staticHeaders) : undefined;

    const authResult = await runInitialSdkAuth(
      authProvider,
      buildSdkAuthOptions(serverUrl, authChallenge, customFetch),
      serverName,
    );
    assertActive();

    if (authResult === "AUTHORIZED") {
      // Auth succeeded without needing browser interaction (e.g., had valid tokens).
      notifyAuthorizationSucceeded(ctx, serverName);
    } else if (authResult === "REDIRECT") {
      await completeRedirectAuthFlow({
        serverName,
        serverUrl,
        hasStaticClientId: Boolean(config.auth?.clientId),
        ctx,
        authProvider,
        authChallenge,
        customFetch,
        callbackPromise,
        oauthState,
        reopenBrowser: () =>
          reopenAuthorizationBrowser(
            launchAuthorizationBrowser,
            () => state.latestAuthorizationUrl,
            serverName,
          ),
        onPasteResolved: cancel,
        assertActive,
      });
    } else {
      throw new McpError(
        `Unexpected auth result: ${authResult}`,
        serverName,
        "protocol",
      );
    }

    assertActive();
    reportDiagnostic({
      level: "info",
      event: "auth.completed",
      server: serverName,
      message: `OAuth authorization completed for "${serverName}"`,
      fields: { outcome: "authorized" },
    });
  } catch (err) {
    reportAuthorizeFailure(serverName, err, signal, state.lockLost);
    throw err;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    await callbackServer.stop().catch(() => {
      // WHY: Ignore callback server stop errors during authorize cleanup.
    });
    await unlock?.();
  }
}
