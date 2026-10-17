/**
 * Pure URL validation and parsing helpers for MCP OAuth authorization and callbacks.
 */

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

/**
 * Parse and validate an OAuth callback URL (either from an incoming HTTP callback request
 * or from a user-pasted redirect URL).
 */
export function parseCallbackUrl(
  input: string,
  options: ParseCallbackUrlOptions = {},
): { state: string; code: string } | { state: string; error: string } {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new CallbackUrlValidationError("invalid_url", "Invalid redirect URL");
  }

  if (options.redirectUrl !== undefined) {
    const expected =
      options.redirectUrl instanceof URL
        ? options.redirectUrl
        : new URL(String(options.redirectUrl));
    if (
      url.protocol !== expected.protocol ||
      url.hostname !== expected.hostname ||
      url.port !== expected.port
    ) {
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
  } else if (url.pathname !== "/callback") {
    throw new CallbackUrlValidationError("wrong_path", "Redirect URL path must be /callback");
  }

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

  if (typeof options.expectedState === "string" && state !== options.expectedState) {
    throw new CallbackUrlValidationError(
      "invalid_state",
      "Invalid or expired state parameter - potential CSRF attack",
    );
  } else if (typeof options.expectedState === "function" && !options.expectedState(state)) {
    throw new CallbackUrlValidationError(
      "invalid_state",
      "Invalid or expired state parameter - potential CSRF attack",
    );
  }

  if (error) {
    return { state, error: errorDescription || error };
  }

  if (!code) {
    throw new CallbackUrlValidationError("missing_code", "No authorization code provided");
  }

  return { state, code };
}
