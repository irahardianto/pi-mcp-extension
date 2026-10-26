/**
 * Per-server status snapshots shared by `/mcp <name>` and the `mcp_status` tool.
 *
 * `collectServerStatus` gathers connection state, tool activation counts, the OAuth
 * credential summary, and config provenance in one place; `formatServerDetail` renders
 * the `/mcp <name>` view and `toStatusRow` renders an `mcp_status` row from the same
 * snapshot, so the command and the tool can never drift apart.
 */

import type { ServerConfig } from "./config.js";
import { describeError, reportDiagnostic } from "./debug-log.js";
import { McpError } from "./errors.js";
import { AuthLockError, AuthRequiredError } from "./oauth-provider.js";
import type { ManagedServer } from "./server-manager.js";
import {
  formatProjectConfigNote,
  formatServerSource,
  type ConfigProvenance,
  type ServerConfigSource,
} from "./server-provenance.js";
import { sanitizeTerminalText } from "./terminal-text.js";

/** Stored-credentials summary as far as a status view needs it. */
export interface StoredAuthStatus {
  hasTokens: boolean;
}

export interface ServerStatusSnapshot {
  name: string;
  state: ManagedServer["state"];
  transport: ServerConfig["transport"];
  lifecycle: ServerConfig["lifecycle"];
  retryCount: number;
  source: ServerConfigSource | undefined;
  tools: { discovered: number; active: number };
  /** OAuth credential summary, or undefined when the server has no `auth` config. */
  auth: string | undefined;
  lastError: Error | null;
  /** Recent sanitized stderr output, or the caller's "(no stderr output)" note. */
  recentOutput: string;
}

export interface ServerStatusRow {
  name: string;
  lifecycle: string;
  state: string;
  tools: { discovered: number; active: number };
  auth: string;
  error: string | undefined;
  source: ServerConfigSource | "unknown";
}

export interface CollectServerStatusParams {
  server: ManagedServer;
  tools: { discovered: number; active: number };
  source: ServerConfigSource | undefined;
  recentOutput?: string | undefined;
  /** Reads stored OAuth state for a server; injected so tests avoid disk I/O. */
  readAuthStatus: (serverName: string) => Promise<StoredAuthStatus | null>;
}

/** How a failed server should be steered back to a working state. */
export type FailureKind = "auth-required" | "auth-lock" | "connection";

const ISSUE_TRACKER = "https://github.com/irahardianto/pi-mcp-extension/issues";

export function formatStatusAuth(
  authConfig: ServerConfig["auth"] | undefined,
  authCorrupt: boolean,
  hasTokens: boolean | undefined,
): string {
  if (!authConfig) return "not configured";
  if (authCorrupt) return "corrupt state file backed up (re-auth required)";
  if (hasTokens) return "credentials stored";
  return "authorization may be required";
}

/** Short action hint for the `mcp_status` tool, or undefined when the server is healthy. */
export function formatStatusError(lastError: unknown): string | undefined {
  if (!lastError) return undefined;
  if (lastError instanceof AuthRequiredError) {
    return "Authorization required: use mcp_connect in an interactive Pi session";
  }
  const code = lastError instanceof McpError ? lastError.code : "failed";
  return `Connection ${code}; use mcp_connect to retry`;
}

export function classifyFailure(error: Error | null): FailureKind | undefined {
  if (error === null) return undefined;
  // WHY: AuthLockError extends AuthRequiredError, so the narrower lock case must be
  // tested first or every lock contention would be reported as missing credentials.
  if (error instanceof AuthLockError) return "auth-lock";
  if (error instanceof AuthRequiredError) return "auth-required";
  return "connection";
}

/** Troubleshooting hint for `/mcp <name>`, or undefined when there is no failure. */
export function formatFailureHint(kind: FailureKind | undefined, serverName: string): string | undefined {
  if (kind === undefined) return undefined;
  const name = sanitizeTerminalText(serverName);
  if (kind === "auth-required") {
    return `Hint: run /mcp:auth ${name} (or /mcp:auth ${name} --reset if stored credentials expired)`;
  }
  if (kind === "auth-lock") {
    return `Hint: another Pi process is authorizing ${name}; retry once it finishes`;
  }
  return `Hint: run with PI_MCP_DEBUG=1 pi to log redacted diagnostics, or report server issues at ${ISSUE_TRACKER}`;
}

function isDefined(value: string | undefined): value is string {
  return value !== undefined;
}

/** `/mcp <name>` detail view: config provenance, tool counts, credentials, and next steps. */
export function formatServerDetail(snapshot: ServerStatusSnapshot, provenance: ConfigProvenance): string {
  const lines: Array<string | undefined> = [
    `Server: ${sanitizeTerminalText(snapshot.name)}`,
    `State:  ${snapshot.state}`,
    `Retries: ${snapshot.retryCount}`,
    `Transport: ${snapshot.transport}`,
    `Lifecycle: ${snapshot.lifecycle}`,
    `Source: ${formatServerSource(snapshot.source)}`,
    `Tools: ${snapshot.tools.active}/${snapshot.tools.discovered} active`,
    snapshot.auth === undefined ? undefined : `OAuth: ${snapshot.auth}`,
    formatProjectConfigNote(provenance),
    snapshot.lastError === null ? undefined : `Last error: ${sanitizeTerminalText(snapshot.lastError.message)}`,
    formatFailureHint(classifyFailure(snapshot.lastError), snapshot.name),
  ];
  return `${lines.filter(isDefined).join("\n")}\n\nRecent output:\n${snapshot.recentOutput}`;
}

/** `mcp_status` row for one server. */
export function toStatusRow(snapshot: ServerStatusSnapshot): ServerStatusRow {
  return {
    name: snapshot.name,
    lifecycle: snapshot.lifecycle,
    state: snapshot.state,
    tools: snapshot.tools,
    auth: snapshot.auth ?? "not configured",
    error: formatStatusError(snapshot.lastError),
    source: formatServerSource(snapshot.source),
  };
}

/**
 * OAuth summary for one server. A corrupt stored-state file is reported as a
 * diagnostic and rendered as "corrupt state file backed up", never thrown: one
 * broken server must not take down `/mcp <name>` or the whole `mcp_status` list.
 */
async function summarizeAuth(params: CollectServerStatusParams): Promise<string | undefined> {
  const authConfig = params.server.config.auth;
  if (authConfig === undefined) return undefined;
  try {
    const status = await params.readAuthStatus(params.server.name);
    return formatStatusAuth(authConfig, false, status?.hasTokens);
  } catch (err) {
    // WHY: getAuthStatus() already backed up and deleted the corrupt file before throwing.
    const { kind, message } = describeError(err);
    reportDiagnostic({
      level: "error",
      event: "oauth.state_corrupt",
      server: params.server.name,
      message,
      fields: { kind },
    });
    return formatStatusAuth(authConfig, true, undefined);
  }
}

export async function collectServerStatus(params: CollectServerStatusParams): Promise<ServerStatusSnapshot> {
  const { server } = params;
  return {
    name: server.name,
    state: server.state,
    transport: server.config.transport,
    lifecycle: server.config.lifecycle,
    retryCount: server.retryCount,
    source: params.source,
    tools: params.tools,
    auth: await summarizeAuth(params),
    lastError: server.lastError,
    recentOutput: params.recentOutput ?? "",
  };
}
