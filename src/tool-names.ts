/**
 * Pure tool-name sanitization, SHA-256 truncation hashing, lossless intra-server
 * ordering (#213), and cross-server tool-name collision resolution for pi-mcp.
 */

import { createHash } from "node:crypto";
import type { McpToolDefinition } from "./tool-discovery.js";
import { compareCodePoints } from "./tool-order.js";

export const MAX_TOOL_NAME_LEN = 64;

export interface ResolveUniqueToolNameOptions {
  prefix: string;
  serverName: string;
  rawToolName: string;
  seenInBatch: ReadonlySet<string>;
  toolOwners: ReadonlyMap<string, string>;
}

/** Replace any character outside `[a-zA-Z0-9_]` with `_`. */
export function sanitizeIdentifierSegment(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Deterministic 8-character lowercase SHA-256 hex digest used for identifier collision disambiguation. */
export function shortSha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

/**
 * Build a Pi-compatible tool name.
 * Format: <prefix>_<server>_<tool>
 * Rules: [a-zA-Z0-9_], max 64 chars.
 * If truncation or collision disambiguation (`forceHash`) is needed, appends an
 * 8-char SHA-256 hex digest computed over the raw unsanitized input components.
 */
export function buildToolName(
  prefix: string,
  serverName: string,
  toolName: string,
  forceHash = false,
): string {
  // WHY: Hash the raw unsanitized components separated by NUL bytes so distinct
  // server/tool pairs that sanitize to the same "_" sequence (e.g. "my-tool" vs
  // "my_tool", or server "a_b" + tool "c" vs server "a" + tool "b_c") never collide.
  const hash = shortSha256Hex(`${prefix}\0${serverName}\0${toolName}`);
  const raw = `${prefix}_${serverName}_${toolName}`;
  const safe = sanitizeIdentifierSegment(raw);
  if (!forceHash && safe.length <= MAX_TOOL_NAME_LEN) {
    return safe;
  }
  return `${safe.slice(0, MAX_TOOL_NAME_LEN - 9)}_${hash}`;
}

/** True when sanitizing the raw tool or server name loses nothing (already `[a-zA-Z0-9_]+`). */
export function isLosslessToolName(rawToolName: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(rawToolName);
}

/** Compare raw MCP tool or server names: lossless `[a-zA-Z0-9_]+` wins, then code-point order. */
export function compareNamesForAssignment(a: string, b: string): number {
  const aLossless = isLosslessToolName(a);
  const bLossless = isLosslessToolName(b);
  if (aLossless !== bLossless) return aLossless ? -1 : 1;
  return compareCodePoints(a, b);
}

/**
 * Order a server's tools so Pi-name assignment depends only on the tool set and never on
 * the order `tools/list` happened to return (#213): a lossless raw name wins the unhashed
 * `<prefix>_<server>_<tool>` identifier over one that needs character substitution
 * (`my_tool` over `my-tool`), and remaining ties fall back to code-point order of the raw
 * name. Without a total order here, the first response's order decided which colliding
 * tool owned the unhashed name, so a reconnect could silently swap tool targets.
 */
export function compareToolsForNameAssignment(a: McpToolDefinition, b: McpToolDefinition): number {
  return compareNamesForAssignment(a.name, b.name);
}

/**
 * Order a server's tools for Pi-name assignment. The server's own `tools/list` order is kept —
 * so registration order only moves where it must — except that tools competing for the same
 * unhashed identifier are emitted as one deterministic group in the position of the group's
 * first member. Which tool the server listed first is not part of the MCP contract, so it must
 * not decide who wins that identifier (#213).
 */
export function orderToolsForNameAssignment(
  prefix: string,
  serverName: string,
  tools: readonly McpToolDefinition[],
): McpToolDefinition[] {
  const groups = new Map<string, McpToolDefinition[]>();
  for (const tool of tools) {
    const baseName = buildToolName(prefix, serverName, tool.name, false);
    const group = groups.get(baseName);
    if (group) group.push(tool);
    else groups.set(baseName, [tool]);
  }

  const emitted = new Set<string>();
  const ordered: McpToolDefinition[] = [];
  for (const tool of tools) {
    const baseName = buildToolName(prefix, serverName, tool.name, false);
    if (emitted.has(baseName)) continue;
    emitted.add(baseName);
    ordered.push(...(groups.get(baseName) ?? []).sort(compareToolsForNameAssignment));
  }
  return ordered;
}

function isToolNameTaken(
  name: string,
  serverName: string,
  seenInBatch: ReadonlySet<string>,
  toolOwners: ReadonlyMap<string, string>,
): boolean {
  if (seenInBatch.has(name)) return true;
  const owner = toolOwners.get(name);
  return owner !== undefined && owner !== serverName;
}

function findSuffixedToolName(
  hashedCandidate: string,
  serverName: string,
  seenInBatch: ReadonlySet<string>,
  toolOwners: ReadonlyMap<string, string>,
): string {
  let suffix = 2;
  while (true) {
    const tag = `_${suffix}`;
    const candidate = `${hashedCandidate.slice(0, MAX_TOOL_NAME_LEN - tag.length)}${tag}`;
    if (!isToolNameTaken(candidate, serverName, seenInBatch, toolOwners)) {
      return candidate;
    }
    suffix++;
  }
}

/**
 * Resolve a collision-free Pi tool name for `rawToolName` on `serverName`.
 * Tries the unhashed `<prefix>_<server>_<tool>` name first, falls back to the
 * 8-character SHA-256 suffix when taken, and appends `_2`, `_3`, … if even the
 * hashed identifier is owned by another server or earlier tool in the batch.
 */
export function resolveUniqueToolName(options: ResolveUniqueToolNameOptions): string {
  const { prefix, serverName, rawToolName, seenInBatch, toolOwners } = options;
  const baseCandidate = buildToolName(prefix, serverName, rawToolName, false);
  if (!isToolNameTaken(baseCandidate, serverName, seenInBatch, toolOwners)) {
    return baseCandidate;
  }

  const hashedCandidate = buildToolName(prefix, serverName, rawToolName, true);
  if (!isToolNameTaken(hashedCandidate, serverName, seenInBatch, toolOwners)) {
    return hashedCandidate;
  }

  return findSuffixedToolName(hashedCandidate, serverName, seenInBatch, toolOwners);
}
