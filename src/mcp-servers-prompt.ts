/**
 * Pure `<mcp_servers>` system-prompt section renderer for Pi 1.3.0 indirect MCP servers.
 *
 * Neither `codemode` nor `tool_search` lists configured MCP servers or their descriptions in its
 * own tool declaration (`toPiToolExposure("codemode")` registers as `"deferred"` so tool schemas
 * never mutate `codemode`'s description mid-session). Because this extension replaces Pi's
 * `builtin:mcp`, it populates `event.systemPromptOptions.sections["mcp_servers"]` on
 * `before_agent_start` so the model knows which indirect MCP domains exist, how to reach each
 * one (`codemode` vs `tool_search`), and whether a lazy/disconnected server needs `mcp_connect`
 * first (#257).
 */

import {
  CODEMODE_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  sanitizeNamespaceText,
  type McpExposure,
} from "./tool-exposure.js";
import { resolveAllServerNamespaceIds } from "./tool-names.js";
import { compareCodePoints } from "./tool-order.js";

/** Name of the Pi 1.3.0 system-prompt section listing indirect MCP servers. */
export const MCP_SERVERS_SECTION = "mcp_servers";

/** Character cap for the entire `mcp_servers` prompt section (matches Pi 1.3.0). */
export const MAX_SERVERS_SECTION_CHARS = 4096;

/** Per-server one-line summary cap before whole-section budget shrinking. */
const MAX_SERVER_SUMMARY_CHARS = 250;

/** Bound for sanitized raw server names rendered inside `mcp_connect "<name>"` hints. */
const MAX_SAFE_SERVER_NAME_CHARS = 120;

export type IndirectReachMode = "codemode" | "tool_search";

export interface McpPromptServerEntry {
  name: string;
  enabled?: boolean | undefined;
  connected: boolean;
  exposures: Iterable<McpExposure>;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RenderMcpServersSectionOptions {
  servers: readonly McpPromptServerEntry[];
  toolPrefix?: string | undefined;
  activeTools?: readonly string[] | undefined;
}

interface PreparedPromptServer {
  entry: McpPromptServerEntry;
  modes: IndirectReachMode[];
  head: string;
}

interface ReachAvailability {
  codemode: boolean;
  toolSearch: boolean;
}

function resolveReachAvailability(activeTools: readonly string[] | undefined): ReachAvailability {
  if (!activeTools) return { codemode: true, toolSearch: true };
  const active = new Set(activeTools);
  return {
    codemode: active.has(CODEMODE_TOOL_NAME),
    toolSearch: active.has(TOOL_SEARCH_TOOL_NAME),
  };
}

function mapExposureToReachMode(
  exposure: "codemode" | "deferred",
  available: ReachAvailability,
): IndirectReachMode | undefined {
  if (exposure === "codemode") {
    if (available.codemode) return "codemode";
    return available.toolSearch ? "tool_search" : undefined;
  }
  if (available.toolSearch) return "tool_search";
  // WHY: in Pi 1.3.0, `AgentSession._getCallableTools()` exposes both `codemode` and `deferred`
  // tools to codemode scripts, so `--tools read,codemode,mcp_*` (without `tool_search`) can still
  // reach `deferred` tools via `codemode` (#257).
  return available.codemode ? "codemode" : undefined;
}

function resolveIndirectReachModes(
  exposures: ReadonlySet<McpExposure>,
  available: ReachAvailability,
): IndirectReachMode[] {
  const modes: IndirectReachMode[] = [];
  for (const exposure of ["codemode", "deferred"] as const) {
    if (!exposures.has(exposure)) continue;
    const mode = mapExposureToReachMode(exposure, available);
    if (mode && !modes.includes(mode)) {
      modes.push(mode);
    }
  }
  return modes;
}

function pickFirstSummaryLine(raw: string | undefined, maxLength: number): string | undefined {
  if (typeof raw !== "string" || maxLength <= 1) return undefined;
  for (const line of raw.split(/\r?\n/)) {
    const sanitized = sanitizeNamespaceText(line, maxLength);
    if (sanitized !== undefined) return sanitized;
  }
  return undefined;
}

function resolveServerSummary(entry: McpPromptServerEntry, maxLength: number): string | undefined {
  const configured = pickFirstSummaryLine(entry.description, maxLength);
  if (configured !== undefined || !entry.connected) return configured;
  return pickFirstSummaryLine(entry.instructions, maxLength);
}

function buildServerHead(
  entry: McpPromptServerEntry,
  namespace: string,
  modes: readonly IndirectReachMode[],
): string {
  const reachTag = modes.join(", ");
  if (entry.connected) {
    return `- ${namespace} (${reachTag})`;
  }
  const safeName = sanitizeNamespaceText(entry.name, MAX_SAFE_SERVER_NAME_CHARS) ?? namespace;
  return `- ${namespace} (${reachTag}, not connected — mcp_connect "${safeName}")`;
}

function buildSectionIntro(
  reaches: ReadonlySet<IndirectReachMode>,
  hasDisconnected: boolean,
): string {
  const sentences = ["MCP servers whose tools are not declared to you."];
  if (reaches.has("codemode")) {
    sentences.push("Call the tools of `codemode` servers from codemode scripts.");
  }
  if (reaches.has("tool_search")) {
    sentences.push("Load the tools of `tool_search` servers with `tool_search`.");
  }
  if (hasDisconnected) {
    sentences.push("Connect `not connected` servers with `mcp_connect` first.");
  }
  return sentences.join(" ");
}

function omittedTailLines(omittedCount: number, hasCodemode: boolean): string[] {
  if (omittedCount <= 0) return [];
  const noun = omittedCount === 1 ? "server" : "servers";
  const finder = hasCodemode ? "searchTools()" : "tool_search";
  return [`- … ${omittedCount} more ${noun}; find their tools with ${finder}`];
}

function measureSkeletonLength(
  intro: string,
  heads: readonly string[],
  kept: number,
  hasCodemode: boolean,
): number {
  return [
    intro,
    ...heads.slice(0, kept),
    ...omittedTailLines(heads.length - kept, hasCodemode),
  ].join("\n").length;
}

function selectKeptServerCount(
  intro: string,
  heads: readonly string[],
  hasCodemode: boolean,
): { kept: number; perServerBudget: number } {
  let kept = heads.length;
  while (kept > 0 && measureSkeletonLength(intro, heads, kept, hasCodemode) > MAX_SERVERS_SECTION_CHARS) {
    kept = kept - 1;
  }
  if (kept === 0) return { kept: 0, perServerBudget: 0 };
  const remaining = MAX_SERVERS_SECTION_CHARS - measureSkeletonLength(intro, heads, kept, hasCodemode);
  const rawBudget = Math.min(MAX_SERVER_SUMMARY_CHARS, Math.floor(remaining / kept) - 2);
  return { kept, perServerBudget: rawBudget <= 1 ? 0 : rawBudget };
}

function preparePromptServers(
  servers: readonly McpPromptServerEntry[],
  prefix: string,
  available: ReachAvailability,
): PreparedPromptServer[] {
  const namespaces = resolveAllServerNamespaceIds(
    prefix,
    servers.map((server) => server.name),
  );
  const prepared: PreparedPromptServer[] = [];
  for (const entry of servers) {
    if (!entry.connected && entry.enabled === false) continue;
    const modes = resolveIndirectReachModes(new Set(entry.exposures), available);
    if (modes.length === 0) continue;
    const namespace = namespaces.get(entry.name)!.name;
    prepared.push({
      entry,
      modes,
      head: buildServerHead(entry, namespace, modes),
    });
  }
  return prepared.sort((a, b) => compareCodePoints(a.entry.name, b.entry.name));
}

/**
 * Render the `mcp_servers` system-prompt section for enabled or connected servers with indirect
 * (`codemode` / `deferred`) tools, or `undefined` when none exist (or when `activeTools` is
 * supplied and neither `codemode` nor `tool_search` is active).
 */
export function renderMcpServersSection(
  options: RenderMcpServersSectionOptions,
): string | undefined {
  const prefix = options.toolPrefix ?? "mcp";
  const available = resolveReachAvailability(options.activeTools);
  const prepared = preparePromptServers(options.servers, prefix, available);
  if (prepared.length === 0) return undefined;

  const reaches = new Set<IndirectReachMode>(prepared.flatMap((item) => item.modes));
  const hasCodemode = reaches.has("codemode");
  const hasDisconnected = prepared.some((item) => !item.entry.connected);
  const intro = buildSectionIntro(reaches, hasDisconnected);
  const heads = prepared.map((item) => item.head);
  const { kept, perServerBudget } = selectKeptServerCount(intro, heads, hasCodemode);

  const lines = prepared.slice(0, kept).map((item) => {
    const summary =
      perServerBudget > 0 ? resolveServerSummary(item.entry, perServerBudget) : undefined;
    return summary ? `${item.head}: ${summary}` : item.head;
  });
  return [intro, ...lines, ...omittedTailLines(prepared.length - kept, hasCodemode)].join("\n");
}
