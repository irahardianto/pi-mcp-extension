/**
 * Stored OAuth state inspection, credential reset, and token invalidation helpers.
 *
 * Owns stored OAuth state inspection (`getAuthStatus`), credential reset (`resetAuth`),
 * and best-effort token invalidation (`invalidateStoredTokens`).
 */

import { unlink } from "node:fs/promises";
import { acquireAuthLock, statePath, type AuthLockHandle } from "./auth-lock.js";
import { canonicalServerUrl, loadState, saveState } from "./oauth-state-store.js";

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
