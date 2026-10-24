/**
 * Persisted OAuth state schemas, origin-binding helpers, and atomic file I/O.
 */

import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { readFile, writeFile, mkdir, unlink, chmod, rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpError } from "./errors.js";
import { AuthRequiredError, authDir, statePath } from "./auth-lock.js";

// ─── URL Canonicalization & Origin-Binding Helpers ────────────────────────────

export function canonicalServerUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${u.origin}${path}${u.search}`;
  } catch {
    // WHY: new URL() throws TypeError per WHATWG URL spec on malformed or relative
    // URL strings. Falling back to trimmed rawUrl allows graceful degradation for
    // non-standard or unparseable URLs without crashing callers.
    return rawUrl.trim();
  }
}

export function urlsMatch(storedUrl: string, expectedUrl: string): boolean {
  return canonicalServerUrl(storedUrl) === canonicalServerUrl(expectedUrl);
}

function isUrlPrefixCompatible(req: URL, cfg: URL): boolean {
  if (req.origin !== cfg.origin) return false;
  if (req.pathname.length < cfg.pathname.length) return false;
  const reqPath = req.pathname.endsWith("/") ? req.pathname : `${req.pathname}/`;
  const cfgPath = cfg.pathname.endsWith("/") ? cfg.pathname : `${cfg.pathname}/`;
  return reqPath.startsWith(cfgPath);
}

export function isResourceCompatibleWithServerUrl(resource: string, expectedServerUrl: string): boolean {
  if (urlsMatch(resource, expectedServerUrl)) return true;
  try {
    const req = new URL(canonicalServerUrl(expectedServerUrl));
    const cfg = new URL(canonicalServerUrl(resource));
    return isUrlPrefixCompatible(req, cfg);
  } catch {
    // WHY: new URL() throws TypeError per WHATWG URL spec if canonicalServerUrl produced
    // an invalid or relative URL. If either URL cannot be parsed into an absolute URL,
    // they cannot be origin/path-compatible, so returning false is the safe fallback.
    return false;
  }
}

// ─── Persistent State Types & Schema ──────────────────────────────────────────

export interface StoredClientInfo {
  client_id: string;
  client_secret: string | undefined;
  client_id_issued_at: number | undefined;
  client_secret_expires_at: number | undefined;
  token_endpoint_auth_method: string | undefined;
  redirect_uris: string[] | undefined;
  issuer: string | undefined;
}

export interface StoredTokens {
  access_token: string;
  token_type: string | undefined;
  refresh_token: string | undefined;
  expires_in: number | undefined;
  scope: string | undefined;
  /** ISO timestamp when tokens were saved (for expiry estimation). */
  saved_at: string | undefined;
  issuer: string | undefined;
}

export interface StoredState {
  serverUrl?: string | undefined;
  clientInfo: StoredClientInfo | undefined;
  tokens: StoredTokens | undefined;
  discoveryState: OAuthDiscoveryState | undefined;
}

// WHY: Credentials persisted before SDK 1.31 (GHSA-6qxp-vccf-f47h) have no `issuer`
// property. We allow `issuer: z.string().optional()` so legacy state loads gracefully;
// the SDK binds them to the discovered authorization server on first successful use.
// Unknown keys are stripped by z.object, so explicit schema inclusion is required to
// persist and return the SDK's issuer stamp.
const StoredClientInfoSchema = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
  token_endpoint_auth_method: z.string().optional(),
  redirect_uris: z.array(z.string()).optional(),
  issuer: z.string().optional(),
});

const StoredTokensSchema = z.object({
  access_token: z.string(),
  token_type: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  saved_at: z.string().optional(),
  issuer: z.string().optional(),
});

export const StoredStateSchema = z.object({
  serverUrl: z.string().optional(),
  clientInfo: StoredClientInfoSchema.optional(),
  tokens: StoredTokensSchema.optional(),
  discoveryState: z.record(z.string(), z.unknown()).optional(),
});

// ─── File helpers ─────────────────────────────────────────────────────────────

export async function loadState(
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
          issuer: parsed.clientInfo.issuer,
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
          issuer: parsed.tokens.issuer,
        }
      : undefined,
    discoveryState,
  };
}

export async function saveState(
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

function isStoredStateOriginCompatible(
  state: { serverUrl?: string | undefined; discoveryState?: unknown },
  expectedServerUrl: string,
): boolean {
  if (state.serverUrl !== undefined) {
    return urlsMatch(state.serverUrl, expectedServerUrl);
  }
  const discoveryState = state.discoveryState as OAuthDiscoveryState | undefined;
  const resource = (discoveryState?.resourceMetadata as { resource?: unknown } | undefined)?.resource;
  if (typeof resource === "string") {
    return isResourceCompatibleWithServerUrl(resource, expectedServerUrl);
  }
  return true;
}

function readAndParseStoredStateSync(path: string): z.output<typeof StoredStateSchema> | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    const json: unknown = JSON.parse(raw);
    const parsed = StoredStateSchema.safeParse(json);
    return parsed.success ? parsed.data : undefined;
  } catch {
    // WHY: State file may not exist yet (ENOENT), directory may be inaccessible, or JSON is malformed; return undefined.
    return undefined;
  }
}

/**
 * Synchronously load stored DCR redirect URIs from disk if valid and origin-compatible.
 * Used by silent McpOAuthProvider to report registered redirect_uris synchronously.
 */
export function loadStoredRedirectUrisSync(
  serverName: string,
  storageDir?: string,
  serverUrl?: string,
): string[] | undefined {
  const data = readAndParseStoredStateSync(statePath(serverName, storageDir));
  if (!data) return undefined;
  if (serverUrl !== undefined && !isStoredStateOriginCompatible(data, serverUrl)) {
    return undefined;
  }
  const uris = data.clientInfo?.redirect_uris;
  if (Array.isArray(uris) && uris.length > 0) {
    return uris.map(String);
  }
  return undefined;
}

