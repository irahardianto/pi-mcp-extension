import { spawn } from "node:child_process";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  CallbackServer,
  callbackServerConfigFromRedirectUrl,
} from "./callback-server.js";
import {
  CallbackUrlValidationError,
  isSafeAuthorizationUrl,
  parseCallbackUrl,
} from "./callback-url.js";
import {
  discoverManualAuthChallenge,
  createHeadersFetch,
  type ManualAuthChallenge,
} from "./auth-challenge.js";
import {
  McpOAuthProvider,
  acquireAuthLock,
  AuthLockError,
  type AuthLockHandle,
} from "./oauth-provider.js";
import { McpError, AuthCancelledError } from "./errors.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import type { ServerConfig } from "./config.js";
import type { ServerManager } from "./server-manager.js";

export { AuthCancelledError } from "./errors.js";

export interface BrowserOpenCommand {
  command: string;
  args: string[];
}

export function browserOpenCommand(url: string): BrowserOpenCommand {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (process.platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: [url] };
}

/**
 * Open a URL in the user's default browser.
 * Works on macOS, Linux, and Windows.
 */
export function openBrowser(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const { command, args } = browserOpenCommand(url);
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });

    child.once("error", (err) => {
      console.error(`[pi-mcp] Failed to open browser: ${sanitizeTerminalText(err.message)}`);
      reject(err);
    });

    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export const authRetryOption = "Retry: open browser again";
export const authPasteOption = "Paste redirect URL";
export const authCancelOption = "Cancel authentication";

interface OAuthCallbackResult {
  type: "callback";
  code: string;
}

interface OAuthCallbackErrorResult {
  type: "callbackError";
  error: unknown;
}

interface OAuthUserChoiceResult {
  type: "choice";
  choice: string | undefined;
}

interface OAuthDialogAbortedResult {
  type: "dialogAborted";
}

interface OAuthUserInputResult {
  type: "input";
  value: string | undefined;
}

type OAuthWaitResult = OAuthCallbackResult | OAuthCallbackErrorResult | OAuthUserChoiceResult | OAuthDialogAbortedResult;
type OAuthInputWaitResult = OAuthCallbackResult | OAuthCallbackErrorResult | OAuthUserInputResult | OAuthDialogAbortedResult;

export interface OAuthPasteOptions {
  redirectUrl?: string | URL | undefined;
  expectedState?: string | undefined;
  onPasteResolved?: (() => void) | undefined;
}

export async function waitForOAuthCallback(
  serverName: string,
  callbackPromise: Promise<string>,
  reopenBrowser: () => void | Promise<void>,
  context: {
    hasUI: boolean;
    ui: Pick<ExtensionUIContext, "select"> & Partial<Pick<ExtensionUIContext, "input" | "notify">>;
  },
  pasteOptions?: OAuthPasteOptions,
): Promise<string> {
  if (!context.hasUI) {
    throw new Error(`Authorization for ${serverName} requires an interactive Pi session`);
  }

  const callbackResultPromise: Promise<OAuthCallbackResult | OAuthCallbackErrorResult> = callbackPromise
    .then((code): OAuthCallbackResult => ({ type: "callback", code }))
    .catch((error): OAuthCallbackErrorResult => ({ type: "callbackError", error }));

  while (true) {
    const dialogAbortController = new AbortController();
    const choicePromise: Promise<OAuthWaitResult> = context.ui
      .select(
        `OAuth pending for ${serverName}`,
        [authRetryOption, authPasteOption, authCancelOption],
        { signal: dialogAbortController.signal },
      )
      .then((choice): OAuthUserChoiceResult => ({ type: "choice", choice }))
      .catch((error): OAuthDialogAbortedResult => {
        if (dialogAbortController.signal.aborted) {
          return { type: "dialogAborted" };
        }
        throw error;
      });

    const result = await Promise.race([callbackResultPromise, choicePromise]);

    if (result.type === "callback") {
      dialogAbortController.abort();
      return result.code;
    }

    if (result.type === "callbackError") {
      dialogAbortController.abort();
      throw result.error;
    }

    if (result.type === "dialogAborted") {
      continue;
    }

    if (result.choice === authRetryOption) {
      await reopenBrowser();
      continue;
    }

    if (result.choice === authPasteOption) {
      if (!context.ui.input) {
        continue;
      }
      const inputAbortController = new AbortController();
      const inputPromise: Promise<OAuthInputWaitResult> = context.ui
        .input(
          `Paste redirect URL for ${serverName}`,
          "http://127.0.0.1:19876/callback?code=...&state=...",
          { signal: inputAbortController.signal },
        )
        .then((value): OAuthUserInputResult => ({ type: "input", value }))
        .catch((error): OAuthDialogAbortedResult => {
          if (inputAbortController.signal.aborted) {
            return { type: "dialogAborted" };
          }
          throw error;
        });

      const inputResult = await Promise.race([callbackResultPromise, inputPromise]);

      if (inputResult.type === "callback") {
        inputAbortController.abort();
        return inputResult.code;
      }

      if (inputResult.type === "callbackError") {
        inputAbortController.abort();
        throw inputResult.error;
      }

      if (inputResult.type === "dialogAborted" || !inputResult.value?.trim()) {
        continue;
      }

      let parsed: ReturnType<typeof parseCallbackUrl>;
      try {
        parsed = parseCallbackUrl(inputResult.value, {
          redirectUrl: pasteOptions?.redirectUrl,
          expectedState: pasteOptions?.expectedState,
        });
      } catch (err) {
        if (err instanceof CallbackUrlValidationError) {
          context.ui.notify?.(`pi-mcp: Invalid redirect URL — ${sanitizeTerminalText(err.message)}`, "error");
          continue;
        }
        throw err;
      }

      pasteOptions?.onPasteResolved?.();
      if ("error" in parsed) {
        throw new Error(parsed.error);
      }
      return parsed.code;
    }

    dialogAbortController.abort();
    throw new AuthCancelledError(serverName);
  }
}

export interface AuthorizeDeps {
  manager: ServerManager;
  getServerConfig?: ((name: string) => ServerConfig | undefined) | undefined;
  authStorageDir?: string | undefined;
  openBrowser?: ((url: string) => void | Promise<void>) | undefined;
  callbackServer?: CallbackServer | undefined;
}

export async function authorize(
  deps: AuthorizeDeps,
  serverName: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
  reset: boolean,
): Promise<void> {
  const server = deps.manager.getServer(serverName);
  const config = deps.getServerConfig ? deps.getServerConfig(serverName) : server?.config;
  if (!config) {
    throw new McpError(`Unknown server "${serverName}"`, serverName, "config");
  }

  const callbackServer = deps.callbackServer ?? new CallbackServer();
  const browserOpener = deps.openBrowser ?? openBrowser;
  let oauthState: string | undefined;
  let latestAuthorizationUrl: URL | undefined;
  let lockLost = false;
  const cancel = () => { if (oauthState) callbackServer.cancel(oauthState); };
  signal.addEventListener("abort", cancel, { once: true });
  let unlock: AuthLockHandle | undefined;
  try {
    if (signal.aborted) throw new AuthCancelledError(serverName);
    unlock = await acquireAuthLock(serverName, deps.authStorageDir, {
      onLost: () => {
        lockLost = true;
        cancel();
      },
    });
    if (signal.aborted) throw new AuthCancelledError(serverName);
    if (reset) {
      await unlock.assertHeld();
      await deps.manager.resetServerAuth(serverName);
    }
    // Validate that we have a server URL (required for OAuth)
    if (!config.url) {
      throw new McpError(
        `Server "${serverName}" has OAuth configured but no URL. OAuth requires a URL-based server transport.`,
        serverName,
        "config",
      );
    }

    ctx.ui.notify(
      `pi-mcp: Starting OAuth flow for ${serverName}...`,
      "info",
    );

    if (!ctx.hasUI) throw new Error(`Authorization for ${serverName} requires an interactive Pi session`);
    if (signal.aborted) throw new AuthCancelledError(serverName);

    // 1. Start the callback server
    const callbackServerConfig = callbackServerConfigFromRedirectUrl(config.auth?.redirectUrl);
    const port = await callbackServer.ensure(callbackServerConfig.preferredPort, {
      host: callbackServerConfig.host,
      allowPortFallback: callbackServerConfig.allowPortFallback,
    });
    if (signal.aborted) throw new AuthCancelledError(serverName);
    if (lockLost) throw new AuthLockError(serverName, `Authorization lock lost for ${serverName}; retry`);
    // WHY: In interactive mode, redirectUrl must match the port that the callback server
    // actually bound (which may differ from preferredPort if port fallback was used).
    const boundRedirectUrl = config.auth?.redirectUrl ?? `http://127.0.0.1:${port}/callback`;

    // 2. Generate a cryptographically secure state parameter for CSRF protection
    oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b: number) => b.toString(16).padStart(2, "0"))
      .join("");

    // 3. Create the auth provider.
    const launchAuthorizationBrowser = async (url: URL): Promise<void> => {
      if (!isSafeAuthorizationUrl(url)) {
        throw new McpError(
          `Refusing to open unsafe authorization URL for "${serverName}": only HTTPS (or loopback HTTP) URLs are allowed`,
          serverName,
          "protocol",
        );
      }
      latestAuthorizationUrl = new URL(url.toString());
      if (signal.aborted || lockLost) return;
      try {
        await browserOpener(url.toString());
        ctx.ui.notify(
          `pi-mcp: Authorize ${serverName}: ${url.toString()} (On SSH, forward the callback with ssh -L ${port}:127.0.0.1:${port}, or choose "${authPasteOption}".)`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `pi-mcp: Failed to open browser for ${serverName} (${sanitizeTerminalText(err instanceof Error ? err.message : String(err))}). Open ${url.toString()} manually or choose "${authPasteOption}".`,
          "error",
        );
      }
    };

    const authProvider = new McpOAuthProvider({
      serverName,
      authConfig: config.auth || { type: "oauth" },
      onAuthRequired: launchAuthorizationBrowser,
      storageDir: deps.authStorageDir,
      mode: "interactive",
      isCancelled: () => signal.aborted,
      assertLockHeld: () => unlock!.assertHeld(),
      serverUrl: config.url,
      redirectUrl: boundRedirectUrl,
    });

    if (!reset) {
      // WHY: authorize() is only entered after silent connect failed with AuthRequiredError.
      // If a refresh_token remained on disk (e.g. accepted by the Authorization Server
      // while the Resource Server rejects the refreshed access token), the SDK's auth()
      // would silently refresh and return "AUTHORIZED" without opening the browser.
      // Clear stored tokens while preserving clientInfo and discoveryState.
      try {
        await authProvider.invalidateCredentials("tokens");
      } catch (err) {
        if (err instanceof McpError && err.code === "config" && /Corrupt OAuth state file/i.test(err.message)) {
          console.error(`[pi-mcp] ${sanitizeTerminalText(err.message)}`);
        } else {
          throw err;
        }
      }
      if (signal.aborted) throw new AuthCancelledError(serverName);
      if (lockLost) throw new AuthLockError(serverName, `Authorization lock lost for ${serverName}; retry`);
    }

    // Why set state before calling auth(): the SDK reads provider.state() while
    // building the authorization URL inside auth(), and omits the state parameter
    // if empty, which the callback server then rejects as a CSRF error.
    authProvider.setState(oauthState);

    // 4. Discover protected-resource challenge metadata from the server.
    const authChallenge: ManualAuthChallenge = await discoverManualAuthChallenge(config.url, {
      headers: config.headers,
      signal,
    }).catch((): ManualAuthChallenge => {
      if (signal.aborted) {
        throw new AuthCancelledError(serverName);
      }
      console.error(
        `[pi-mcp] Failed to discover OAuth challenge for "${serverName}"; falling back to standard discovery`,
      );
      return {};
    });
    if (signal.aborted) throw new AuthCancelledError(serverName);
    if (lockLost) throw new AuthLockError(serverName, `Authorization lock lost for ${serverName}; retry`);

    // 5. Register the callback immediately before auth() can open the browser.
    // Attach a catch handler so cancellation after immediate authorization
    // does not produce an unhandled rejection.
    const callbackPromise = callbackServer.waitForCallback(oauthState);
    callbackPromise.catch(() => {
      // WHY: Suppress unhandled rejection when callbackPromise is cancelled after immediate authorization.
    });

    const customFetch = config.headers ? createHeadersFetch(config.headers) : undefined;
    const authOptions: {
      serverUrl: string;
      resourceMetadataUrl?: URL;
      scope?: string;
      fetchFn?: typeof fetch;
    } = { serverUrl: config.url };
    if (authChallenge.resourceMetadataUrl) {
      authOptions.resourceMetadataUrl = authChallenge.resourceMetadataUrl;
    }
    if (authChallenge.scope) {
      authOptions.scope = authChallenge.scope;
    }
    if (customFetch) {
      authOptions.fetchFn = customFetch;
    }

    // 6. Start the auth flow.
    // Why branch on the return value: the SDK auth() call returns "AUTHORIZED" when
    // stored or refreshed tokens already succeeded without opening a browser, or
    // "REDIRECT" after invoking redirectToAuthorization(), in which case we must
    // wait for the callback code and call auth() a second time with authorizationCode.
    let authResult: "AUTHORIZED" | "REDIRECT";
    try {
      authResult = await auth(authProvider, authOptions);
    } catch (err) {
      if (err instanceof McpError && err.code === "config" && /Corrupt OAuth state file/i.test(err.message)) {
        // WHY: McpOAuthProvider._loadState() backed up and removed the corrupt state file.
        // Retry auth() once so interactive authorization proceeds cleanly.
        console.error(`[pi-mcp] ${sanitizeTerminalText(err.message)}`);
        authResult = await auth(authProvider, authOptions);
      } else {
        throw err;
      }
    }
    if (signal.aborted) throw new AuthCancelledError(serverName);
    if (lockLost) throw new AuthLockError(serverName, `Authorization lock lost for ${serverName}; retry`);

    if (authResult === "AUTHORIZED") {
      // Auth succeeded without needing browser interaction (e.g., had valid tokens).
      ctx.ui.notify(`pi-mcp: ${serverName} authenticated successfully. Starting MCP server...`, "info");
    } else if (authResult === "REDIRECT") {
      // 7. Wait for the callback while giving the user an escape hatch.
      const code = await waitForOAuthCallback(
        serverName,
        callbackPromise,
        () => {
          if (!latestAuthorizationUrl) {
            throw new McpError(
              `Authorization URL is not available for ${serverName}`,
              serverName,
              "protocol",
            );
          }
          return launchAuthorizationBrowser(latestAuthorizationUrl);
        },
        ctx,
        {
          redirectUrl: authProvider.redirectUrl,
          expectedState: oauthState,
          onPasteResolved: cancel,
        },
      );
      if (signal.aborted) throw new AuthCancelledError(serverName);
      if (lockLost) throw new AuthLockError(serverName, `Authorization lock lost for ${serverName}; retry`);
      ctx.ui.notify(
        `pi-mcp: Authorization callback received for ${serverName}. Exchanging token...`,
        "info",
      );
      // 8. Complete the OAuth flow with the authorization code
      const finishAuthOptions: {
        serverUrl: string;
        authorizationCode: string;
        resourceMetadataUrl?: URL;
        scope?: string;
        fetchFn?: typeof fetch;
      } = {
        serverUrl: config.url,
        authorizationCode: code,
      };
      if (authChallenge.resourceMetadataUrl) {
        finishAuthOptions.resourceMetadataUrl = authChallenge.resourceMetadataUrl;
      }
      if (authChallenge.scope) {
        finishAuthOptions.scope = authChallenge.scope;
      }
      if (customFetch) {
        finishAuthOptions.fetchFn = customFetch;
      }

      const finishAuthResult = await auth(authProvider, finishAuthOptions);
      if (signal.aborted) throw new AuthCancelledError(serverName);
      if (lockLost) throw new AuthLockError(serverName, `Authorization lock lost for ${serverName}; retry`);

      if (finishAuthResult !== "AUTHORIZED") {
        throw new McpError(
          `Unexpected auth completion result: ${finishAuthResult}`,
          serverName,
          "protocol",
        );
      }

      ctx.ui.notify(`pi-mcp: ${serverName} authenticated successfully. Starting MCP server...`, "info");
    } else {
      throw new McpError(
        `Unexpected auth result: ${authResult}`,
        serverName,
        "protocol",
      );
    }

    if (signal.aborted) throw new AuthCancelledError(serverName);
    if (lockLost) throw new AuthLockError(serverName, `Authorization lock lost for ${serverName}; retry`);
  } catch (err) {
    if (lockLost && !signal.aborted) {
      throw new AuthLockError(serverName, `Authorization lock lost for ${serverName}; retry`);
    }
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
