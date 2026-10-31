/**
 * Registers `/mcp`, `/mcp:stop`, `/mcp:start`, and `/mcp:auth` commands on Pi's ExtensionAPI.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  parseAuthArguments,
  parseResourceArguments,
  serverNameCompletions,
} from "./commands.js";
import {
  type ConnectionCoordinator,
  formatErrorMessage,
} from "./connection-coordinator.js";
import { sanitizeLogText } from "./debug-log.js";
import { AuthCancelledError } from "./errors.js";
import type { ManagedServer, ServerManager } from "./server-manager.js";
import { lookupServerSource, type ConfigProvenance } from "./server-provenance.js";
import { collectServerStatus, formatServerDetail } from "./server-status.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import type { ToolBridge } from "./tool-bridge.js";
import type { PiResourceContent, ResourceBridge, ResourceCatalog } from "./resource-bridge.js";

export interface RegisterCommandsDeps {
  manager: ServerManager;
  coordinator: ConnectionCoordinator;
  bridge: ToolBridge;
  resources: ResourceBridge;
  /** Session config provenance (file origins merged with extension-registered servers). */
  getProvenance: () => ConfigProvenance;
}

/** Enriched `/mcp <name>` view: provenance, tool counts, credentials, failure hints, output. */
async function buildServerDetail(server: ManagedServer, deps: RegisterCommandsDeps): Promise<string> {
  const { manager } = deps;
  const serverName = server.name;
  const provenance = deps.getProvenance();
  const snapshot = await collectServerStatus({
    server,
    tools: deps.bridge.getToolActivity(serverName),
    source: lookupServerSource(provenance, serverName),
    recentOutput: manager.getServerLogs(serverName),
    readAuthStatus: (name) => manager.getServerAuthStatus(name),
  });
  return formatServerDetail(snapshot, provenance);
}

async function handleMcpStatus(args: string, ctx: ExtensionCommandContext, deps: RegisterCommandsDeps): Promise<void> {
  const { manager } = deps;
  const serverName = args.trim();
  if (!serverName) {
    // Summary view: all servers
    ctx.ui.notify(manager.getStatusSummary(), "info");
    return;
  }
  const server = manager.getServer(serverName);
  if (!server) {
    ctx.ui.notify(`pi-mcp: No server named "${serverName}"`, "error");
    return;
  }
  ctx.ui.notify(await buildServerDetail(server, deps), "info");
}

async function handleMcpStop(
  args: string,
  ctx: ExtensionCommandContext,
  deps: RegisterCommandsDeps,
): Promise<void> {
  const { manager, coordinator, bridge } = deps;
  const serverName = args.trim();
  if (!serverName) {
    ctx.ui.notify("Usage: /mcp:stop <server-name>", "error");
    return;
  }
  if (!manager.getServer(serverName)) {
    ctx.ui.notify(`pi-mcp: No server named "${serverName}"`, "error");
    return;
  }
  coordinator.cancelServer(serverName);
  coordinator.syncStatus(ctx);
  bridge.deactivateServer(serverName);
  await manager.stopServer(serverName);
  ctx.ui.notify(`pi-mcp: Stopped ${serverName}`, "info");
}

async function handleMcpStart(
  args: string,
  ctx: ExtensionCommandContext,
  deps: RegisterCommandsDeps,
): Promise<void> {
  const { manager, coordinator } = deps;
  const serverName = args.trim();
  if (!serverName) {
    ctx.ui.notify("Usage: /mcp:start <server-name>", "error");
    return;
  }
  if (!manager.getServer(serverName)) {
    ctx.ui.notify(`pi-mcp: No server named "${serverName}"`, "error");
    return;
  }
  try {
    await coordinator.connect(serverName, ctx);
    ctx.ui.notify(`pi-mcp: Started ${serverName}`, "info");
  } catch (err) {
    if (err instanceof AuthCancelledError) {
      ctx.ui.notify(`pi-mcp: ${sanitizeTerminalText(err.message)}`, "info");
      return;
    }
    const msg = formatErrorMessage(err);
    ctx.ui.notify(`pi-mcp: Failed to start ${serverName} — ${msg}`, "error");
  }
}

async function handleMcpAuth(
  args: string,
  ctx: ExtensionCommandContext,
  deps: RegisterCommandsDeps,
): Promise<void> {
  const { manager, coordinator, bridge } = deps;
  const { name, reset } = parseAuthArguments(args, manager.getAllServers().map((server) => server.name));
  if (!name) {
    ctx.ui.notify("Usage: /mcp:auth <name> [--reset]", "error");
    return;
  }
  if (!manager.getServer(name)?.config.auth) {
    ctx.ui.notify(`No OAuth server named ${name}`, "error");
    return;
  }
  if (!reset && manager.getServer(name)?.state === "ready") {
    // WHY: Explicit /mcp:auth on an already-ready server must tear down the existing
    // connection and force a fresh reconnect/auth check rather than returning a no-op.
    bridge.deactivateServer(name);
    await manager.stopServer(name);
  }
  try {
    await coordinator.connect(name, ctx, { reset });
    ctx.ui.notify(`pi-mcp: ${name} ready`, "info");
  } catch (err) {
    ctx.ui.notify(
      `pi-mcp: ${sanitizeLogText(err instanceof Error ? err.message : String(err), 500)}`,
      err instanceof AuthCancelledError ? "info" : "error",
    );
  }
}

// ─── /mcp:resources ──────────────────────────────────────────────────────────

const RESOURCE_FIELD_MAX_LENGTH = 120;

interface ResourceTarget {
  server: ManagedServer;
  client: Client;
}

function supportsResources(client: Client): boolean {
  return Boolean(client.getServerCapabilities()?.resources);
}

function formatResourceLine(label: string, detail: string | undefined, mimeType: string | undefined): string {
  const parts = [sanitizeTerminalText(label, { maxLength: RESOURCE_FIELD_MAX_LENGTH })];
  if (detail) parts.push(sanitizeTerminalText(detail, { maxLength: RESOURCE_FIELD_MAX_LENGTH }));
  if (mimeType) parts.push(sanitizeTerminalText(mimeType, { maxLength: 60 }));
  return `  ${parts.join(" — ")}`;
}

/** Maximum catalog rows rendered in one notification; the rest are summarized. */
const MAX_CATALOG_ROWS = 50;

export function formatResourceCatalog(serverName: string, catalog: ResourceCatalog): string {
  const header = `pi-mcp: ${sanitizeTerminalText(serverName, { maxLength: 64 })} — ${catalog.resources.length} resource(s), ${catalog.templates.length} template(s)`;
  const rows = [
    ...catalog.resources.map((resource) =>
      formatResourceLine(resource.uri, resource.description ?? resource.name, resource.mimeType),
    ),
    ...catalog.templates.map((template) =>
      formatResourceLine(template.uriTemplate, template.description ?? template.name, template.mimeType),
    ),
  ];
  if (rows.length === 0) return `${header}\n  (none)`;
  const shown = rows.slice(0, MAX_CATALOG_ROWS);
  const hidden = rows.length - shown.length;
  // WHY: a spec-conformant server may advertise thousands of entries (100 pages × 100 rows),
  // and this string reaches a terminal notification — bound it like the read preview.
  if (hidden > 0) shown.push(`  … and ${hidden} more`);
  return [header, ...shown].join("\n");
}

function describeResourceContent(content: PiResourceContent): string {
  if (content.type === "image") {
    return `[image ${sanitizeTerminalText(content.mimeType, { maxLength: 60 })}, ${content.data.length} base64 chars]`;
  }
  return content.text;
}

function formatResourcePreview(serverName: string, uri: string, content: PiResourceContent[]): string {
  const header = `pi-mcp: ${sanitizeTerminalText(serverName, { maxLength: 64 })} — ${sanitizeTerminalText(uri, { maxLength: RESOURCE_FIELD_MAX_LENGTH })}`;
  const body = sanitizeTerminalText(content.map(describeResourceContent).join("\n"), { maxLength: 1200 });
  // WHY: a notification is a single terminal line, so server-controlled resource content is
  // sanitized and bounded before it reaches the UI; an empty text payload renders the same
  // placeholder as an empty contents array instead of a trailing blank line.
  return `${header}\n${body || "(empty resource)"}`;
}

/** Row for `/mcp:resources` with no server argument: resource and template counts per server. */
async function describeServerResources(server: ManagedServer, deps: RegisterCommandsDeps): Promise<string> {
  const label = sanitizeTerminalText(server.name, { maxLength: 64 });
  const client = server.client;
  if (!client || !supportsResources(client)) return `  ${label} — no MCP resources`;
  try {
    const catalog = await deps.resources.getCatalog(server.name, client, {
      requestTimeoutMs: deps.manager.resolveRequestTimeoutMs(server),
    });
    return `  ${label} — ${catalog.resources.length} resource(s), ${catalog.templates.length} template(s)`;
  } catch (err) {
    return `  ${label} — failed: ${formatErrorMessage(err)}`;
  }
}

async function notifyResourceSummary(deps: RegisterCommandsDeps, ctx: ExtensionCommandContext): Promise<void> {
  const connected = deps.manager.getAllServers().filter((server) => server.state === "ready");
  if (connected.length === 0) {
    ctx.ui.notify("pi-mcp: No connected MCP servers. Use /mcp:start <name> to connect one.", "info");
    return;
  }
  const rows = await Promise.all(connected.map((server) => describeServerResources(server, deps)));
  ctx.ui.notify(["pi-mcp: MCP resources", ...rows].join("\n"), "info");
}

/** Resolve `/mcp:resources <server>` to a live client, notifying the user when it cannot. */
function resolveResourceTarget(
  serverName: string,
  ctx: ExtensionCommandContext,
  deps: RegisterCommandsDeps,
): ResourceTarget | null {
  const label = sanitizeTerminalText(serverName, { maxLength: 64 });
  const server = deps.manager.getServer(serverName);
  if (!server) {
    ctx.ui.notify(`pi-mcp: No server named "${label}"`, "error");
    return null;
  }
  const client = server.client;
  if (!client || server.state !== "ready") {
    ctx.ui.notify(`pi-mcp: ${label} is not connected. Run /mcp:start ${label}.`, "error");
    return null;
  }
  if (!supportsResources(client)) {
    ctx.ui.notify(`pi-mcp: ${label} does not expose MCP resources.`, "info");
    return null;
  }
  return { server, client };
}

async function notifyResourceList(
  target: ResourceTarget,
  deps: RegisterCommandsDeps,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const catalog = await deps.resources.getCatalog(target.server.name, target.client, {
      requestTimeoutMs: deps.manager.resolveRequestTimeoutMs(target.server),
    });
    ctx.ui.notify(formatResourceCatalog(target.server.name, catalog), "info");
  } catch (err) {
    const label = sanitizeTerminalText(target.server.name, { maxLength: 64 });
    ctx.ui.notify(`pi-mcp: Failed to list resources for ${label} — ${formatErrorMessage(err)}`, "error");
  }
}

async function notifyResourceContent(
  target: ResourceTarget,
  uri: string,
  deps: RegisterCommandsDeps,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const content = await deps.resources.readResource(target.server.name, target.client, uri, {
      requestTimeoutMs: deps.manager.resolveRequestTimeoutMs(target.server),
    });
    ctx.ui.notify(formatResourcePreview(target.server.name, uri, content), "info");
  } catch (err) {
    const label = sanitizeTerminalText(uri, { maxLength: RESOURCE_FIELD_MAX_LENGTH });
    ctx.ui.notify(`pi-mcp: Failed to read ${label} — ${formatErrorMessage(err)}`, "error");
  }
}

async function handleMcpResources(
  args: string,
  ctx: ExtensionCommandContext,
  deps: RegisterCommandsDeps,
): Promise<void> {
  const serverNames = deps.manager.getAllServers().map((server) => server.name);
  const { server: serverName, uri } = parseResourceArguments(args, serverNames);
  if (!serverName) return notifyResourceSummary(deps, ctx);
  const target = resolveResourceTarget(serverName, ctx, deps);
  if (!target) return;
  if (uri) return notifyResourceContent(target, uri, deps, ctx);
  return notifyResourceList(target, deps, ctx);
}

export function registerCommands(pi: ExtensionAPI, deps: RegisterCommandsDeps): void {
  const { manager } = deps;

  // ── 4. /mcp — show server status ─────────────────────────────────────────
  pi.registerCommand("mcp", {
    description:
      "Show MCP server status. Usage: /mcp [server-name] for detail.",
    handler: async (args, ctx) => {
      await handleMcpStatus(args, ctx, deps);
    },
    getArgumentCompletions: (prefix) => serverNameCompletions(prefix, manager.getAllServers()),
  });

  // ── 5. /mcp:stop — stop a server ─────────────────────────────────────────
  pi.registerCommand("mcp:stop", {
    description: "Stop an MCP server. Usage: /mcp:stop <server-name>",
    handler: (args, ctx) => handleMcpStop(args, ctx, deps),
    getArgumentCompletions: (prefix) => serverNameCompletions(prefix, manager.getAllServers()),
  });

  // ── 6. /mcp:start — manually start a lazy server ─────────────────────────
  pi.registerCommand("mcp:start", {
    description: "Start an MCP server. Usage: /mcp:start <server-name>",
    handler: (args, ctx) => handleMcpStart(args, ctx, deps),
    getArgumentCompletions: (prefix) => serverNameCompletions(prefix, manager.getAllServers()),
  });

  pi.registerCommand("mcp:auth", {
    description: "Connect with OAuth; use /mcp:auth <name> --reset to discard stored credentials.",
    handler: (args, ctx) => handleMcpAuth(args, ctx, deps),
    getArgumentCompletions: (prefix) => serverNameCompletions(prefix, manager.getAllServers(), { authOnly: true }),
  });

  // ── 7. /mcp:resources — list or read MCP resources ───────────────────────
  pi.registerCommand("mcp:resources", {
    description: "List MCP resources. Usage: /mcp:resources [server] [uri] to read one resource.",
    handler: (args, ctx) => handleMcpResources(args, ctx, deps),
    getArgumentCompletions: (prefix) => serverNameCompletions(prefix, manager.getAllServers()),
  });
}
