/**
 * Registers MCP management and resource tools on Pi's ExtensionAPI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Type from "typebox";
import type { ConnectionCoordinator } from "./connection-coordinator.js";
import { AuthCancelledError, AuthLockError, AuthRequiredError, McpError } from "./errors.js";
import { formatErrorMessage } from "./startup-auth.js";
import type {
  ResourceBridge,
  McpResourceDefinition,
  McpResourceTemplateDefinition,
  PiResourceContent,
} from "./resource-bridge.js";
import type { ManagedServer, ServerManager } from "./server-manager.js";
import { lookupServerSource, type ConfigProvenance } from "./server-provenance.js";
import {
  collectServerStatus,
  getServerInstructions,
  toStatusRow,
  type ServerStatusRow,
} from "./server-status.js";
import type { ToolActivity, ToolBridge } from "./tool-bridge.js";

export interface ManagementToolDeps {
  manager: ServerManager;
  coordinator: ConnectionCoordinator;
  bridge: ToolBridge;
  resources: ResourceBridge;
  getProvenance: () => ConfigProvenance;
}

/** One `mcp_status` row: state, tool counts, credential summary, error hint, and config source. */
function collectStatusRow(
  server: ManagedServer,
  deps: ManagementToolDeps,
  provenance: ConfigProvenance,
): Promise<ServerStatusRow> {
  return collectServerStatus({
    server,
    tools: deps.bridge.getToolActivity(server.name),
    source: lookupServerSource(provenance, server.name),
    inactiveDirectTools: deps.bridge.getInactiveDirectTools(server.name).length,
    indirectToolsFiltered: deps.bridge.hasAllIndirectToolsFiltered(server.name),
    readAuthStatus: (name) => deps.manager.getServerAuthStatus(name),
  }).then(toStatusRow);
}

export interface McpConnectErrorOptions {
  aborted: boolean;
  serverExists: boolean;
  hasUI: boolean;
}

function formatMcpAuthError(err: unknown, hasUI: boolean): string | undefined {
  if (err instanceof AuthLockError) {
    return "Another Pi process is authorizing this server. Retry after it finishes.";
  }
  if (err instanceof AuthRequiredError) {
    return hasUI
      ? "MCP authorization required. Retry with mcp_connect or /mcp:auth."
      : "MCP authorization requires an interactive Pi session.";
  }
  return undefined;
}

function formatMcpConnectFailureMessage(err: unknown): string {
  if (err instanceof McpError && err.code === "protocol") {
    return "MCP tool discovery failed. Check the server and retry.";
  }
  // WHY: a request timeout means the server was reachable but too slow, so pointing at the
  // configuration would send the user down the wrong path (#209).
  if (err instanceof McpError && err.code === "timeout") {
    return "MCP server did not respond in time. Check that it is running and retry.";
  }
  return "MCP connection failed. Check the server configuration and retry.";
}

export function formatMcpConnectError(err: unknown, options: McpConnectErrorOptions): string {
  if (options.aborted || err instanceof AuthCancelledError) {
    return "MCP connection cancelled. Retry when ready.";
  }
  if (!options.serverExists) {
    return "Unknown MCP server name. Use mcp_status to list configured servers.";
  }
  return formatMcpAuthError(err, options.hasUI) ?? formatMcpConnectFailureMessage(err);
}

/**
 * Success text for `mcp_connect`. A server whose exposure keeps every tool out of the model
 * never becomes active by design, so saying "tools discovered and active" there would read
 * as a silent failure — but Pi's `tool_search` can still have loaded some of them, so the
 * message states that count instead of implying nothing runs (#257).
 */
export function formatConnectSuccess(name: string, activity: ToolActivity): string {
  if (activity.expected > 0) {
    return `MCP server ${name} ready; tools discovered and active.`;
  }
  if (activity.discovered === 0) {
    return `MCP server ${name} ready; it advertises no tools.`;
  }
  const loaded = activity.active > 0 ? ` (${activity.active} loaded through tool_search or codemode)` : "";
  return `MCP server ${name} ready; no tool is configured as direct — all ${activity.discovered} are deferred, codemode, or hidden${loaded}.`;
}

export function registerManagementTools(
  pi: ExtensionAPI,
  deps: ManagementToolDeps,
): void {
  const { manager, coordinator, bridge } = deps;

  pi.registerTool({
    name: "mcp_status",
    label: "MCP status",
    description: "List configured MCP servers, lifecycle, connection and OAuth state. Use mcp_connect to connect one server.",
    promptSnippet: "Inspect configured MCP servers, their connection state, discovered tools, and authentication status.",
    parameters: Type.Object({}),
    async execute() {
      const provenance = deps.getProvenance();
      const rows = await Promise.all(
        manager.getAllServers().map((server) => collectStatusRow(server, deps, provenance)),
      );
      return { content: [{ type: "text", text: JSON.stringify(rows) }], details: {} };
    },
  });

  pi.registerTool({
    name: "mcp_connect",
    label: "Connect MCP server",
    description: "Connect one named configured MCP server and activate its tools. May request interactive OAuth authorization.",
    promptSnippet: "Connect or reconnect to a configured MCP server by name and register its tools.",
    parameters: Type.Object({ name: Type.String({ description: "Exact configured MCP server name" }) }),
    async execute(_id, { name }, signal, _update, ctx) {
      try {
        await coordinator.connect(name, ctx, { signal });
      } catch (err) {
        const message = formatMcpConnectError(err, {
          aborted: Boolean(signal?.aborted),
          serverExists: Boolean(manager.getServer(name)),
          hasUI: ctx.hasUI,
        });
        throw new Error(message);
      }
      // WHY: check the tools whose exposure is `direct` by name, not every discovered one. A
      // server configured with `exposure: "hidden"` plus a few `toolExposure` overrides, or one
      // whose tools are all deferred to `tool_search`, is working as configured — the old
      // discovered-vs-active check reported it as a failure (#257) — while a `direct` tool another
      // extension removed is still a failure. Totals cannot decide it: `active` also counts
      // non-direct tools `tool_search` loaded, and those would mask a missing direct tool.
      if (bridge.getInactiveDirectTools(name).length > 0) {
        throw new Error("MCP server connected, but some tools configured as direct are inactive. Check Pi tool restrictions or extension conflicts; mcp_status reports discovered, active, expected, and inactiveDirect counts.");
      }
      if (bridge.hasAllIndirectToolsFiltered(name)) {
        throw new Error(
          `MCP server connected, but Pi tool restrictions (--tools / --exclude-tools) filtered out its indirect tools; include ${bridge.getToolPrefix()}_* in --tools so codemode and tool_search can reach them.`,
        );
      }
      const activity = bridge.getToolActivity(name);
      const instructions = getServerInstructions(manager.getServer(name));
      const ready = formatConnectSuccess(name, activity);
      const text = instructions === undefined ? ready : `${ready}\nInstructions: ${instructions}`;
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "mcp_list_resources",
    label: "List MCP resources",
    description: "List MCP resources and URI templates exposed by connected servers. Use mcp_read_resource to read one by URI.",
    promptSnippet: "Discover read-only MCP resources (documents, schemas, data streams) and URI templates, optionally for one server.",
    parameters: Type.Object({
      server: Type.Optional(Type.String({ description: "Exact configured MCP server name (default: all connected servers)" })),
    }),
    annotations: { readOnlyHint: true },
    async execute(_id, { server }, signal) {
      const rows = await listResourceRows(deps, server, signal);
      return { content: [{ type: "text", text: JSON.stringify(rows) }], details: {} };
    },
  });

  pi.registerTool({
    name: "mcp_read_resource",
    label: "Read MCP resource",
    description: "Read one MCP resource by server and URI. Text resources return their text; image blobs return an image; other binary blobs return a size summary.",
    promptSnippet: "Read an MCP resource document or data stream by its URI from a connected server.",
    parameters: Type.Object({
      server: Type.String({ description: "Exact configured MCP server name" }),
      uri: Type.String({ description: "Resource URI, or a URI template filled in by the caller" }),
    }),
    annotations: { readOnlyHint: true },
    async execute(_id, { server, uri }, signal) {
      const content = await readResourceForTool(deps, server, uri, signal);
      return { content, details: {} };
    },
  });
}

/** One `mcp_list_resources` row: a connected server's resources and templates. */
interface ResourceToolRow {
  server: string;
  resources: McpResourceDefinition[];
  templates: McpResourceTemplateDefinition[];
  resourcesUnsupported?: boolean;
  error?: string;
}

/**
 * Collect one server's catalog.
 * WHY: a server that never advertised the `resources` capability must not be asked — the raw
 * request would come back as a protocol error rather than an empty catalog. A server that does
 * advertise it but fails keeps its row instead of rejecting every other server's listing.
 */
async function collectResourcesForServer(
  server: ManagedServer,
  deps: ManagementToolDeps,
  signal: AbortSignal | undefined,
): Promise<ResourceToolRow> {
  if (signal?.aborted) throw new AuthCancelledError(server.name);
  const client = server.client;
  if (!client || !client.getServerCapabilities()?.resources) {
    return { server: server.name, resources: [], templates: [], resourcesUnsupported: true };
  }
  try {
    const catalog = await deps.resources.getCatalog(server.name, client, {
      requestTimeoutMs: deps.manager.resolveRequestTimeoutMs(server),
      ...(signal ? { signal } : {}),
    });
    return { server: server.name, ...catalog };
  } catch (err) {
    if (err instanceof AuthCancelledError || signal?.aborted) {
      throw err instanceof AuthCancelledError ? err : new AuthCancelledError(server.name);
    }
    return { server: server.name, resources: [], templates: [], error: formatErrorMessage(err) };
  }
}

/** Gather `mcp_list_resources` rows for every connected server, or one explicitly named server. */
async function listResourceRows(
  deps: ManagementToolDeps,
  filter: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ servers: ResourceToolRow[]; stoppedServers: string[] }> {
  if (signal?.aborted) throw new AuthCancelledError(filter ?? "mcp_list_resources");
  const all = deps.manager.getAllServers();
  if (filter) {
    const target = all.find((server) => server.name === filter);
    if (!target) throw new Error("Unknown MCP server name. Use mcp_status to list configured servers.");
    if (target.state !== "ready") {
      throw new Error(`MCP server ${filter} is not connected. Use mcp_connect to connect it.`);
    }
    return { servers: [await collectResourcesForServer(target, deps, signal)], stoppedServers: [] };
  }
  const connected = all.filter((server) => server.state === "ready");
  const servers = await Promise.all(connected.map((server) => collectResourcesForServer(server, deps, signal)));
  const stoppedServers = all.filter((server) => server.state !== "ready").map((server) => server.name);
  return { servers, stoppedServers };
}

/** Resolve the server for `mcp_read_resource` and read one URI from its live client. */
async function readResourceForTool(
  deps: ManagementToolDeps,
  serverName: string,
  uri: string,
  signal: AbortSignal | undefined,
): Promise<PiResourceContent[]> {
  if (signal?.aborted) throw new AuthCancelledError(serverName);
  const target = deps.manager.getServer(serverName);
  if (!target) throw new Error("Unknown MCP server name. Use mcp_status to list configured servers.");
  const client = target.client;
  if (!client || target.state !== "ready") {
    throw new Error(`MCP server ${serverName} is not connected. Use mcp_connect to connect it.`);
  }
  // WHY: without this a capability-less server answers resources/read with JSON-RPC -32601,
  // which surfaces as a cryptic protocol error instead of the same actionable wording the
  // listing and /mcp:resources use.
  if (!client.getServerCapabilities()?.resources) {
    throw new McpError(`MCP server ${serverName} does not expose MCP resources`, serverName, "protocol");
  }
  return deps.resources.readResource(serverName, client, uri, {
    requestTimeoutMs: deps.manager.resolveRequestTimeoutMs(target),
    ...(signal ? { signal } : {}),
  });
}
