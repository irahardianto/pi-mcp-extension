/**
 * Pure server `ToolNamespace` construction, peer-aware collision disambiguation,
 * dynamic namespace rebinding, and sanitized/secret-redacted namespace text formatting
 * for Pi 1.3.0 `tool_search` and `codemode` (#257).
 */

import type { ToolNamespace } from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "./secret-redaction.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import {
  compareNamesForAssignment,
  sanitizeIdentifierSegment,
  shortSha256Hex,
} from "./tool-names.js";
import { compareCodePoints } from "./tool-order.js";

/** Character budgets matching Pi's namespace summary and server instruction caps. */
const MAX_NAMESPACE_DESCRIPTION_LENGTH = 250;
const MAX_NAMESPACE_INSTRUCTIONS_LENGTH = 500;

export interface ResolvedServerNamespaceIds {
  name: string;
  aliases: string[];
}

export interface ServerToolNamespaceOptions {
  prefix: string;
  serverName: string;
  description?: string | undefined;
  instructions?: string | undefined;
  /** Optional peer server names so colliding sanitized names (`my-srv` vs `my_srv`) disambiguate deterministically. */
  peerServerNames?: Iterable<string> | undefined;
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

/**
 * Strip ANSI/control sequences, redact credential-shaped substrings, collapse line breaks,
 * and bound server-controlled or configured text to `maxLength` code units.
 */
export function sanitizeNamespaceText(raw: unknown, maxLength: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  // WHY: strip terminal escapes before redacting so escape sequences inside a credential
  // cannot hide a `key=value` token shape, then bound after `[REDACTED]` expansion.
  const cleaned = sanitizeTerminalText(raw, { maxLength: raw.length }).trim();
  return sanitizeTerminalText(redactSecrets(cleaned), { maxLength }).trim() || undefined;
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
  const hash = shortSha256Hex(`${prefix}\0${peer}`);
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

/**
 * Build Pi's `ToolNamespace` metadata for one MCP server so `tool_search` ranks tools with
 * server context and codemode's `searchTools({ namespace })` / `describeNamespace()` resolve
 * the server by `<prefix>_<server>`, raw `<server>`, or Pi's `mcp__<server>` convention without
 * cross-matching colliding peer server names (`my-srv` vs `my_srv`).
 */
export function buildServerToolNamespace(options: ServerToolNamespaceOptions): ToolNamespace {
  const { name, aliases } = resolveServerNamespaceIds(
    options.prefix,
    options.serverName,
    options.peerServerNames,
  );
  const description = sanitizeNamespaceText(options.description, MAX_NAMESPACE_DESCRIPTION_LENGTH);
  const instructions = sanitizeNamespaceText(
    options.instructions,
    MAX_NAMESPACE_INSTRUCTIONS_LENGTH,
  );
  return {
    name,
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(description ? { description } : {}),
    ...(instructions ? { instructions } : {}),
  };
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
