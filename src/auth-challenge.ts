/**
 * OAuth challenge discovery helpers for manual MCP authentication commands.
 */

import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";

export interface ManualAuthChallenge {
  resourceMetadataUrl?: URL | undefined;
  scope?: string | undefined;
}

export type AuthChallengeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const AUTH_CHALLENGE_TIMEOUT_MS = 10_000;

export interface ManualAuthChallengeOptions {
  fetchFn?: AuthChallengeFetch | undefined;
  timeoutMs?: number | undefined;
  headers?: Record<string, string> | undefined;
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
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json, text/event-stream");
  const response = await fetchFn(serverUrl, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? AUTH_CHALLENGE_TIMEOUT_MS),
  });

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
    await response.body?.cancel().catch(() => {});
  }
}
