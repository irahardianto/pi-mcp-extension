/**
 * Pure URL validation and parsing helpers for MCP OAuth authorization and callbacks.
 */

export const DEFAULT_PORT = 19876;
export const DEFAULT_HOST = "127.0.0.1";
export const CALLBACK_PATH = "/callback";

export interface CallbackServerConfig {
  preferredPort: number;
  host: string;
  allowPortFallback: boolean;
}

export type CallbackUrlValidationReason =
  | "invalid_url"
  | "wrong_origin"
  | "wrong_path"
  | "missing_state"
  | "invalid_state"
  | "missing_code";

export class CallbackUrlValidationError extends Error {
  readonly reason: CallbackUrlValidationReason;

  constructor(reason: CallbackUrlValidationReason, message: string) {
    super(message);
    this.name = "CallbackUrlValidationError";
    this.reason = reason;
  }
}

export interface ParseCallbackUrlOptions {
  redirectUrl?: string | URL | undefined;
  expectedState?: string | ((state: string) => boolean) | undefined;
}

export function isLocalCallbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/**
 * Build callback server settings from the configured OAuth redirect URL.
 *
 * Local HTTP redirect URLs must use a fixed listener port because OAuth
 * providers require exact redirect URI registration. When no local redirect URL
 * is configured, the callback server keeps the historical default behavior and
 * scans forward from the default port if needed.
 */
export function callbackServerConfigFromRedirectUrl(redirectUrl?: string): CallbackServerConfig {
  // WHY: Only treat `undefined` (omitted) as default; an explicit empty string `""`
  // must fall through to `new URL("")` and throw a validation error.
  if (redirectUrl === undefined) {
    return {
      preferredPort: DEFAULT_PORT,
      host: DEFAULT_HOST,
      allowPortFallback: true,
    };
  }

  const url = new URL(redirectUrl);
  if (url.protocol !== "http:" || !isLocalCallbackHost(url.hostname)) {
    throw new Error("Manual OAuth redirect URL must use HTTP with localhost, 127.0.0.1, or ::1");
  }

  if (url.hash) {
    throw new Error("Manual OAuth redirect URL must not include a fragment");
  }

  if (url.username || url.password) {
    throw new Error("Manual OAuth redirect URL must not include credentials");
  }

  if (url.pathname !== CALLBACK_PATH) {
    throw new Error(`Local OAuth redirect URL must use path ${CALLBACK_PATH}`);
  }

  if (!url.port) {
    throw new Error("Manual OAuth redirect URL must include an explicit port (e.g. http://127.0.0.1:19876/callback)");
  }

  const preferredPort = Number(url.port);
  if (preferredPort === 0) {
    throw new Error("Manual OAuth redirect URL must use a fixed non-zero port");
  }

  return {
    preferredPort,
    host: url.hostname === "[::1]" ? "::1" : url.hostname,
    allowPortFallback: false,
  };
}

/**
 * Validate that an OAuth authorization URL is safe to pass to a system browser opener.
 * Only allows `https:` URLs or loopback `http:` URLs (`localhost`, `127.0.0.1`, `::1`, `[::1]`).
 */
export function isSafeAuthorizationUrl(input: string | URL): boolean {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    return false;
  }

  if (url.protocol === "https:") {
    return true;
  }

  if (url.protocol === "http:" && isLocalCallbackHost(url.hostname)) {
    return true;
  }

  return false;
}

function parseRedirectUrl(input: string): URL {
  try {
    return new URL(input.trim());
  } catch {
    throw new CallbackUrlValidationError("invalid_url", "Invalid redirect URL");
  }
}

function expectedRedirectUrl(redirectUrl: string | URL): URL {
  return redirectUrl instanceof URL ? redirectUrl : new URL(String(redirectUrl));
}

/** Reject a callback URL whose origin or path differs from the configured redirect URL. */
function assertRedirectTargetMatches(url: URL, redirectUrl: string | URL | undefined): void {
  if (redirectUrl === undefined) {
    if (url.pathname !== CALLBACK_PATH) {
      throw new CallbackUrlValidationError("wrong_path", `Redirect URL path must be ${CALLBACK_PATH}`);
    }
    return;
  }

  const expected = expectedRedirectUrl(redirectUrl);
  if (url.protocol !== expected.protocol || url.hostname !== expected.hostname || url.port !== expected.port) {
    throw new CallbackUrlValidationError(
      "wrong_origin",
      `Redirect URL origin must match ${expected.origin}`,
    );
  }
  if (url.pathname !== expected.pathname) {
    throw new CallbackUrlValidationError(
      "wrong_path",
      `Redirect URL path must be ${expected.pathname}`,
    );
  }
}

const INVALID_STATE_MESSAGE = "Invalid or expired state parameter - potential CSRF attack";

/** Reject a callback whose `state` does not match the expected literal or predicate. */
function assertExpectedState(
  state: string,
  expectedState: string | ((state: string) => boolean) | undefined,
): void {
  if (expectedState === undefined) {
    return;
  }
  const matches = typeof expectedState === "string" ? state === expectedState : expectedState(state);
  if (!matches) {
    throw new CallbackUrlValidationError("invalid_state", INVALID_STATE_MESSAGE);
  }
}

/**
 * Parse and validate an OAuth callback URL (either from an incoming HTTP callback request
 * or from a user-pasted redirect URL).
 */
export function parseCallbackUrl(
  input: string,
  options: ParseCallbackUrlOptions = {},
): { state: string; code: string } | { state: string; error: string } {
  const url = parseRedirectUrl(input);
  assertRedirectTargetMatches(url, options.redirectUrl);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (!state) {
    throw new CallbackUrlValidationError(
      "missing_state",
      "Missing required state parameter - potential CSRF attack",
    );
  }

  assertExpectedState(state, options.expectedState);

  if (error) {
    return { state, error: errorDescription || error };
  }

  if (!code) {
    throw new CallbackUrlValidationError("missing_code", "No authorization code provided");
  }

  return { state, code };
}
