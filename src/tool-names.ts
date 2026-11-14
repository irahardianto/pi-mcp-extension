/**
 * Pure tool-name sanitization, SHA-256 truncation hashing, lossless intra-server
 * ordering (#213), and cross-server tool/namespace collision resolution for pi-mcp.
 */

import type { ToolNamespace } from "@earendil-works/pi-coding-agent";
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

export interface ResolvedServerNamespaceIds {
  name: string;
  aliases: string[];
}

export interface RebindToolDefinitionsOptions<
  T extends { name: string; exposure?: string | undefined; namespace?: ToolNamespace | undefined },
> {
  prefix: string;
  activeServers: ReadonlySet<string>;
  serverToolNames: ReadonlyMap<string, ReadonlySet<string>>;
  toolOwners: ReadonlyMap<string, string>;
  definitions: ReadonlyMap<string, T>;
  peerServerNames: Iterable<string>;
}

function sanitizeIdentifierSegment(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Normalize a namespace or alias string to the exact JavaScript identifier form Pi 1.3.0's
 * `toCodemodeIdentifier()` compares inside `isNamespaceName(namespace, query)`.
 */
function toScriptIdentifier(name: string): string {
  let identifier = "";
  for (const char of name) {
    const pattern = identifier === "" ? /^[A-Za-z_$]$/ : /^[A-Za-z0-9_$]$/;
    identifier = `${identifier}${pattern.test(char) ? char : "_"}`;
  }
  return identifier === "" ? "_" : identifier;
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
  const hash = createHash("sha256")
    .update(`${prefix}\0${serverName}\0${toolName}`)
    .digest("hex")
    .slice(0, 8);
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

function groupPeersByBaseId(prefix: string, peers: ReadonlySet<string>): Array<[string, string[]]> {
  const groups = new Map<string, string[]>();
  for (const peer of peers) {
    const key = toScriptIdentifier(`${prefix}_${sanitizeIdentifierSegment(peer)}`);
    const existing = groups.get(key);
    if (existing) existing.push(peer);
    else groups.set(key, [peer]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => compareCodePoints(a, b))
    .map(([key, members]) => [key, members.sort(compareNamesForAssignment)]);
}

function pickSuffixedNamespaceStem(
  prefix: string,
  peer: string,
  sanitized: string,
  claimedIds: ReadonlySet<string>,
): string {
  const hash = createHash("sha256").update(`${prefix}\0${peer}`).digest("hex").slice(0, 8);
  const hashedStem = `${sanitized}_${hash}`;
  if (!claimedIds.has(toScriptIdentifier(`${prefix}_${hashedStem}`))) return hashedStem;
  let suffix = 2;
  while (claimedIds.has(toScriptIdentifier(`${prefix}_${hashedStem}_${suffix}`))) {
    suffix = suffix + 1;
  }
  return `${hashedStem}_${suffix}`;
}

function assignCollidedGroupStems(
  prefix: string,
  baseId: string,
  members: readonly string[],
  stems: Map<string, string>,
  claimedIds: Set<string>,
): void {
  for (const [index, peer] of members.entries()) {
    const sanitized = sanitizeIdentifierSegment(peer);
    const canUseBase = index === 0 && !claimedIds.has(baseId);
    const stem = canUseBase
      ? sanitized
      : pickSuffixedNamespaceStem(prefix, peer, sanitized, claimedIds);
    stems.set(peer, stem);
    claimedIds.add(toScriptIdentifier(`${prefix}_${stem}`));
  }
}

function assignPeerNamespaceStems(prefix: string, peers: ReadonlySet<string>): Map<string, string> {
  const groups = groupPeersByBaseId(prefix, peers);
  const stems = new Map<string, string>();
  const claimedIds = new Set<string>();
  for (const [baseId, members] of groups) {
    if (members.length === 1) {
      stems.set(members[0]!, sanitizeIdentifierSegment(members[0]!));
      claimedIds.add(baseId);
    }
  }
  for (const [baseId, members] of groups) {
    if (members.length > 1) {
      assignCollidedGroupStems(prefix, baseId, members, stems, claimedIds);
    }
  }
  return stems;
}

function countPeerScriptIdClaims(
  prefix: string,
  stems: ReadonlyMap<string, string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [peer, stem] of stems) {
    const peerIds = new Set([
      toScriptIdentifier(`${prefix}_${stem}`),
      toScriptIdentifier(peer),
      toScriptIdentifier(`mcp__${stem}`),
    ]);
    for (const id of peerIds) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

function buildResolvedNamespaceIds(
  prefix: string,
  serverName: string,
  stem: string,
  idClaims: ReadonlyMap<string, number>,
): ResolvedServerNamespaceIds {
  const name = `${prefix}_${stem}`;
  const seenIds = new Set<string>([toScriptIdentifier(name)]);
  const aliases: string[] = [];
  for (const candidate of [serverName, `mcp__${stem}`]) {
    const candidateId = toScriptIdentifier(candidate);
    if (candidate !== name && !seenIds.has(candidateId) && (idClaims.get(candidateId) ?? 0) <= 1) {
      seenIds.add(candidateId);
      aliases.push(candidate);
    }
  }
  return { name, aliases };
}

/**
 * Resolve collision-free `ToolNamespace` identifiers for an entire peer set in one pass
 * (`O(N log N)` rather than recomputing peer groups per server).
 */
export function resolveAllServerNamespaceIds(
  prefix: string,
  serverNames: Iterable<string>,
): Map<string, ResolvedServerNamespaceIds> {
  const peers = new Set<string>(serverNames);
  const stems = assignPeerNamespaceStems(prefix, peers);
  const idClaims = countPeerScriptIdClaims(prefix, stems);
  const resolved = new Map<string, ResolvedServerNamespaceIds>();
  for (const [peer, stem] of stems) {
    resolved.set(peer, buildResolvedNamespaceIds(prefix, peer, stem, idClaims));
  }
  return resolved;
}

/**
 * Resolve deterministic, collision-free `ToolNamespace` identifiers (`name` + `aliases`) for
 * `serverName` across `peerServerNames`.
 *
 * WHY: Pi 1.3.0's `builtin:mcp` rejects configs whose server names sanitize to the same
 * namespace (`my-srv` vs `my_srv`), while this extension keeps accepting them for backwards
 * compatibility. Without peer-aware disambiguation, both servers would register `mcp_my_srv`
 * and `codemode`'s `isNamespaceName()` (`toCodemodeIdentifier(alias) === toCodemodeIdentifier(query)`)
 * would merge both servers' tools under whichever server's metadata came first (#257).
 */
export function resolveServerNamespaceIds(
  prefix: string,
  serverName: string,
  peerServerNames?: Iterable<string>,
): ResolvedServerNamespaceIds {
  const all = resolveAllServerNamespaceIds(prefix, [serverName, ...(peerServerNames ?? [])]);
  return all.get(serverName)!;
}

/** Merge `serverName`, currently active bridge servers, and optional configured peer names. */
export function mergePeerServerNames(
  serverName: string,
  activeServers: Iterable<string>,
  configuredPeers: Iterable<string> | undefined,
): Set<string> {
  return new Set<string>([serverName, ...activeServers, ...(configuredPeers ?? [])]);
}

function sameStringArray(a: readonly string[] | undefined, b: readonly string[]): boolean {
  const left = a ?? [];
  return left.length === b.length && left.every((value, idx) => value === b[idx]);
}

function rebindServerToolNamespace(
  current: ToolNamespace | undefined,
  resolved: ResolvedServerNamespaceIds,
): ToolNamespace | undefined {
  if (current?.name === resolved.name && sameStringArray(current.aliases, resolved.aliases)) {
    return undefined;
  }
  return {
    name: resolved.name,
    ...(resolved.aliases.length > 0 ? { aliases: resolved.aliases } : {}),
    ...(current?.description ? { description: current.description } : {}),
    ...(current?.instructions ? { instructions: current.instructions } : {}),
  };
}

function isRebindableServerTool<T extends { exposure?: string | undefined }>(
  existing: T | undefined,
  owner: string | undefined,
  serverName: string,
): existing is T {
  return existing !== undefined && existing.exposure !== "hidden" && owner === serverName;
}

function rebindSingleServerDefinitions<
  T extends { name: string; exposure?: string | undefined; namespace?: ToolNamespace | undefined },
>(
  serverName: string,
  toolNames: ReadonlySet<string>,
  resolved: ResolvedServerNamespaceIds,
  options: RebindToolDefinitionsOptions<T>,
  rebound: T[],
): void {
  for (const piName of toolNames) {
    const existing = options.definitions.get(piName);
    if (!isRebindableServerTool(existing, options.toolOwners.get(piName), serverName)) continue;
    const nextNamespace = rebindServerToolNamespace(existing.namespace, resolved);
    if (nextNamespace !== undefined) {
      rebound.push({ ...existing, namespace: nextNamespace });
    }
  }
}

/**
 * Return cloned tool definitions whose `namespace.name` or `namespace.aliases` changed after
 * `peerServerNames` added or removed a colliding server name (`[]` when unchanged).
 */
export function collectReboundToolDefinitions<
  T extends { name: string; exposure?: string | undefined; namespace?: ToolNamespace | undefined },
>(options: RebindToolDefinitionsOptions<T>): T[] {
  const namespaces = resolveAllServerNamespaceIds(options.prefix, [
    ...options.activeServers,
    ...options.peerServerNames,
  ]);
  const rebound: T[] = [];
  for (const serverName of options.activeServers) {
    const toolNames = options.serverToolNames.get(serverName);
    const resolved = namespaces.get(serverName);
    if (!toolNames || !resolved) continue;
    rebindSingleServerDefinitions(serverName, toolNames, resolved, options, rebound);
  }
  return rebound;
}
