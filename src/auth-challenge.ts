/**
 * OAuth challenge discovery helpers for manual MCP authentication commands.
 */

import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";

export interface ManualAuthChallenge {
  resourceMetadataUrl?: URL | undefined;
  scope?: string | undefined;
}

export type AuthChallengeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

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
  fetchFn: AuthChallengeFetch = fetch,
): Promise<ManualAuthChallenge> {
  const response = await fetchFn(serverUrl, {
    method: "GET",
    headers: {
      Accept: "application/json, text/event-stream",
    },
  });

  try {
    if (response.status !== 401 && response.status !== 403) {
      return {};
    }

    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
    return {
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      ...(scope ? { scope } : {}),
    };
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}
