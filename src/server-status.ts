/**
 * Per-server status snapshots shared by `/mcp <name>` and the `mcp_status` tool.
 *
 * `collectServerStatus` gathers connection state, tool activation counts, the OAuth
 * credential summary, server instructions, and config provenance in one place; `formatServerDetail` renders
 * the `/mcp <name>` view and `toStatusRow` renders an `mcp_status` row from the same
 * snapshot, so the command and the tool can never drift apart.
 */

import type { ServerConfig } from "./config.js";
import { describeError, sanitizeLogText } from "./debug-log-format.js";
import { reportDiagnostic } from "./debug-log.js";
import { AuthLockError, AuthRequiredError, McpError } from "./errors.js";
import type { ManagedServer } from "./server-manager.js";
import { redactSecrets } from "./secret-redaction.js";
import {
  formatProjectConfigNote,
  formatServerSource,
  type ConfigProvenance,
  type ServerConfigSource,
} from "./server-provenance.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import type { ToolActivity } from "./tool-bridge.js";

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
  tools: ToolActivity;
  /** OAuth credential summary, or undefined when the server has no `auth` config. */
  auth: string | undefined;
  lastError: Error | null;
  /** Recent sanitized stderr output, or the caller's "(no stderr output)" note. */
  recentOutput: string;
  /** Sanitized initialize-handshake guidance, only while the server is ready. */
  instructions?: string | undefined;
  /** Configured `direct` tools currently absent from Pi's active set while ready. */
  inactiveDirectTools?: number | undefined;
  /** Whether Pi's `--tools` / `--exclude-tools` filter removed all indirect tools while ready. */
  indirectToolsFiltered?: boolean | undefined;
}

export interface ServerStatusTools extends ToolActivity {
  /** Configured `direct` tools absent from Pi's active set while ready (omitted when 0). */
  inactiveDirect?: number | undefined;
  /** Present (`true`) when Pi's `--tools` / `--exclude-tools` filter removed all indirect tools while ready. */
  indirectFiltered?: true | undefined;
}

export interface ServerStatusRow {
  name: string;
  lifecycle: string;
  state: string;
  tools: ServerStatusTools;
  auth: string;
  error: string | undefined;
  source: ServerConfigSource | "unknown";
  instructions?: string | undefined;
}

export interface CollectServerStatusParams {
  server: ManagedServer;
  tools: ToolActivity;
  source: ServerConfigSource | undefined;
  recentOutput?: string | undefined;
  /** Configured `direct` tools absent from Pi's active set while ready. */
  inactiveDirectTools?: number | undefined;
  /** Whether Pi's `--tools` / `--exclude-tools` filter removed all indirect tools while ready. */
  indirectToolsFiltered?: boolean | undefined;
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

/**
 * `(N configured direct)` suffix for the `Tools:` line when exposure keeps some tools out of
 * the active set by design — without it a server configured with `exposure: "hidden"` and a
 * few overridden tools renders `3/12 active` and reads as a broken server (#257). Also surfaces
 * inactive configured `direct` tools and indirect tools dropped by `--tools` / `--exclude-tools`.
 */
function formatExposureNote(
  tools: ToolActivity,
  inactiveDirectTools = 0,
  indirectToolsFiltered = false,
): string {
  if (tools.expected === tools.discovered) return "";
  const parts = [`${tools.expected} configured direct`];
  if (inactiveDirectTools > 0) {
    parts.push(`${inactiveDirectTools} direct inactive`);
  }
  if (indirectToolsFiltered) {
    parts.push("indirect filtered by --tools / --exclude-tools");
  }
  return ` (${parts.join(", ")})`;
}

/** `/mcp <name>` detail view: config provenance, tool counts, credentials, and next steps. */
export function formatServerDetail(snapshot: ServerStatusSnapshot, provenance: ConfigProvenance): string {
  const instructions = sanitizeServerInstructions(snapshot.instructions);
  const exposureNote = formatExposureNote(
    snapshot.tools,
    snapshot.inactiveDirectTools,
    snapshot.indirectToolsFiltered,
  );
  const lines: Array<string | undefined> = [
    `Server: ${sanitizeTerminalText(snapshot.name)}`,
    `State:  ${snapshot.state}`,
    `Retries: ${snapshot.retryCount}`,
    `Transport: ${snapshot.transport}`,
    `Lifecycle: ${snapshot.lifecycle}`,
    `Source: ${formatServerSource(snapshot.source)}`,
    `Tools: ${snapshot.tools.active}/${snapshot.tools.discovered} active${exposureNote}`,
    instructions === undefined ? undefined : `Instructions: ${instructions}`,
    snapshot.auth === undefined ? undefined : `OAuth: ${snapshot.auth}`,
    formatProjectConfigNote(provenance),
    // WHY: a connect/stream failure usually quotes the request URL, and that URL can carry a
    // credential. This view is what users paste into an issue, so mask it like the log does.
    snapshot.lastError === null ? undefined : `Last error: ${sanitizeLogText(snapshot.lastError.message, 500)}`,
    formatFailureHint(classifyFailure(snapshot.lastError), snapshot.name),
  ];
  return `${lines.filter(isDefined).join("\n")}\n\nRecent output:\n${snapshot.recentOutput}`;
}

function toStatusTools(snapshot: ServerStatusSnapshot): ServerStatusTools {
  return {
    ...snapshot.tools,
    ...((snapshot.inactiveDirectTools ?? 0) > 0
      ? { inactiveDirect: snapshot.inactiveDirectTools }
      : {}),
    ...(snapshot.indirectToolsFiltered ? { indirectFiltered: true } : {}),
  };
}

/** `mcp_status` row for one server. */
export function toStatusRow(snapshot: ServerStatusSnapshot): ServerStatusRow {
  const instructions = sanitizeServerInstructions(snapshot.instructions);
  return {
    name: snapshot.name,
    lifecycle: snapshot.lifecycle,
    state: snapshot.state,
    tools: toStatusTools(snapshot),
    auth: snapshot.auth ?? "not configured",
    error: formatStatusError(snapshot.lastError),
    source: formatServerSource(snapshot.source),
    ...(instructions === undefined ? {} : { instructions }),
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

/**
 * Sanitize raw MCP initialize-handshake instructions: strip terminal escapes,
 * redact credential-shaped substrings, and bound to 500 UTF-16 code units.
 */
export function sanitizeServerInstructions(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // WHY: remove escapes before redaction so they cannot hide a credential key;
  // bound the redacted result so masking cannot grow it beyond the UI budget.
  const cleaned = sanitizeTerminalText(raw, { maxLength: raw.length }).trim();
  return sanitizeTerminalText(redactSecrets(cleaned), { maxLength: 500 }).trim() || undefined;
}

/** Read and sanitize handshake instructions from a ready server. */
export function getServerInstructions(server: ManagedServer | undefined): string | undefined {
  if (server?.state !== "ready") return undefined;
  return sanitizeServerInstructions(server.client?.getInstructions());
}

export async function collectServerStatus(params: CollectServerStatusParams): Promise<ServerStatusSnapshot> {
  const { server } = params;
  const ready = server.state === "ready";
  const instructions = getServerInstructions(server);
  const inactiveDirectTools =
    ready && (params.inactiveDirectTools ?? 0) > 0 ? params.inactiveDirectTools : undefined;
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
    ...(instructions === undefined ? {} : { instructions }),
    ...(inactiveDirectTools === undefined ? {} : { inactiveDirectTools }),
    ...(ready && params.indirectToolsFiltered ? { indirectToolsFiltered: true } : {}),
  };
}
