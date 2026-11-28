/**
 * Pure tool-reconciliation, ownership accounting, exposure-aware live `tools/list_changed`
 * active-state preservation (#214, #257), pending-restored tool merging (#257), and
 * deterministic active-set planning (#278) for pi-mcp.
 */

import type { McpToolDefinition } from "./tool-discovery.js";
import {
  DEFAULT_EXPOSURE,
  resolveToolExposure,
  type McpExposure,
  type RegisteredToolSummary,
  type ToolExposureConfig,
} from "./tool-exposure.js";
import {
  buildToolName,
  isCollidingServerStemLoser,
  orderToolsForNameAssignment,
  resolveUniqueToolName,
} from "./tool-names.js";
import { orderOwnedEntries, sameToolList } from "./tool-order.js";

/** Structural shape of `refreshTools` options accepted by {@link normalizeRefreshArgs}. */
export interface RefreshArgsOptions {
  requestTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

/** One discovered MCP tool paired with its deterministically assigned Pi identifier and exposure. */
export interface PlannedServerTool {
  piName: string;
  tool: McpToolDefinition;
  exposure: McpExposure;
}

/** Input for planning a server's tool-registration batch, resolved exposures, and withdrawn ownership. */
export interface PlanServerToolBatchOptions {
  prefix: string;
  serverName: string;
  tools: readonly McpToolDefinition[];
  toolOwners: ReadonlyMap<string, string>;
  ownedPreviousNames?: ReadonlySet<string> | undefined;
  exposureConfig?: ToolExposureConfig | undefined;
  peerServerNames?: Iterable<string> | undefined;
  collidedBaseNames?: ReadonlySet<string> | undefined;
  baseNameOwners?: ReadonlyMap<string, string> | undefined;
  reservedNames?: ReadonlySet<string> | undefined;
}

/** Planned registration batch, Pi→raw lookup tables, exposure maps, and withdrawn tool names. */
export interface ServerToolBatchPlan {
  plannedTools: PlannedServerTool[];
  currentToolNames: Set<string>;
  currentRawNames: Map<string, string>;
  currentExposures: Map<string, McpExposure>;
  piExposures: Map<string, McpExposure>;
  directToolNames: Set<string>;
  withdrawnToolNames: Set<string>;
  crossServerCollisions: Map<string, string>;
}

/** Input for preserving active/inactive tool state across a live `tools/list_changed` refresh. */
export interface LiveRefreshStateInput {
  currentRawNames: ReadonlyMap<string, string>;
  currentExposures?: ReadonlyMap<string, McpExposure> | undefined;
  previousStateByRawName: ReadonlyMap<string, boolean>;
  previousExposures?: ReadonlyMap<string, McpExposure> | undefined;
  previousDropped?: ReadonlyMap<string, boolean> | undefined;
}

/** Desired active Pi tool names and updated dropped-tool memory after a live refresh. */
export interface LiveRefreshStateResult {
  desiredActive: Set<string>;
  dropped: Map<string, boolean> | undefined;
}

/** Input for preserving indirect tools restored from Pi 1.3.0 `_pendingToolNames` on registration. */
export interface PendingRestoredToolsInput {
  desiredActive: Iterable<string>;
  piExposures: ReadonlyMap<string, McpExposure>;
  activeBefore: Iterable<string>;
  activeAfterRegistration: Iterable<string>;
  allTools?: readonly RegisteredToolSummary[] | undefined;
}

/** Input for computing the next ordered active-tool list in Pi. */
export interface ActiveToolReconciliationInput {
  ownedPreviousNames: ReadonlySet<string>;
  desiredActive: ReadonlySet<string>;
  activeBefore: readonly string[];
  currentActive: readonly string[];
  isOwned: (name: string) => boolean;
  extraActive?: readonly string[] | undefined;
}

/** Normalize `refreshTools`' overloaded argument shapes (callback vs. options object). */
export function normalizeRefreshArgs<TOptions extends RefreshArgsOptions = RefreshArgsOptions>(
  isCurrentOrOptions?: (() => boolean) | TOptions,
  maybeOptions?: TOptions,
): { isCurrent: () => boolean; options: TOptions | undefined } {
  const isCurrent = typeof isCurrentOrOptions === "function" ? isCurrentOrOptions : () => true;
  const options = typeof isCurrentOrOptions === "object" ? isCurrentOrOptions : maybeOptions;
  return { isCurrent, options };
}

/** Filter a set of Pi tool names to those still owned by `serverName`. */
export function filterOwnedTools(
  serverName: string,
  toolNames: ReadonlySet<string>,
  toolOwners: ReadonlyMap<string, string>,
): Set<string> {
  const owned = new Set<string>();
  for (const toolName of toolNames) {
    const owner = toolOwners.get(toolName);
    if (owner === undefined || owner === serverName) {
      owned.add(toolName);
    }
  }
  return owned;
}

/** Collect previously owned Pi tool names that `currentToolNames` no longer includes. */
export function collectWithdrawnTools(
  ownedPreviousNames: ReadonlySet<string>,
  currentToolNames: ReadonlySet<string>,
): Set<string> {
  const withdrawn = new Set<string>();
  for (const existingName of ownedPreviousNames) {
    if (!currentToolNames.has(existingName)) {
      withdrawn.add(existingName);
    }
  }
  return withdrawn;
}

/**
 * Remove `serverName`'s tool-set entry and delete only the `toolOwners` entries
 * that still belong to `serverName`.
 */
export function deleteServerOwnedTools(
  serverName: string,
  serverToolNames: Map<string, Set<string>>,
  toolOwners: Map<string, string>,
): void {
  const existing = serverToolNames.get(serverName);
  if (!existing) return;
  for (const toolName of existing) {
    if (toolOwners.get(toolName) === serverName) {
      toolOwners.delete(toolName);
    }
  }
  serverToolNames.delete(serverName);
}

function detectCrossServerCollision(
  baseCandidate: string,
  hashedCandidate: string,
  options: PlanServerToolBatchOptions,
): string | undefined {
  if (baseCandidate === hashedCandidate) return undefined;
  const owner =
    options.toolOwners.get(baseCandidate) ?? options.baseNameOwners?.get(baseCandidate);
  if (owner !== undefined && owner !== options.serverName) {
    return owner;
  }
  return undefined;
}

/**
 * Collect Pi tool names that bridged MCP tools must not overwrite: built-in management
 * tools plus any foreign tools in `allTools` not registered by this bridge (#332).
 */
export function collectReservedToolNames(
  baseReserved: ReadonlySet<string>,
  allTools: readonly RegisteredToolSummary[] | undefined,
  bridgeRegisteredNames: ReadonlySet<string>,
): Set<string> {
  const reserved = new Set(baseReserved);
  if (!allTools) return reserved;
  for (const tool of allTools) {
    if (!bridgeRegisteredNames.has(tool.name)) {
      reserved.add(tool.name);
    }
  }
  return reserved;
}

function getOrCreateSet(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);
  if (!set) {
    set = new Set<string>();
    map.set(key, set);
  }
  return set;
}

/**
 * Record that `serverName` advertises a tool targeting unhashed `baseName`, so if a real
 * cross-server collision later occurs on `baseName` this server is included in
 * `collidedBaseServers` regardless of connect order (#331).
 */
export function recordBaseNameCandidate(
  baseNameCandidates: Map<string, Set<string>>,
  baseName: string,
  serverName: string,
): void {
  getOrCreateSet(baseNameCandidates, baseName).add(serverName);
}

/**
 * Record a cross-server base-name collision and include any previously connected server
 * (such as a stem-loser peer) that also targets `baseName` so dynamic peer removal stays
 * connect-order invariant (#331).
 */
export function recordCrossServerCollision(
  baseName: string,
  incumbentServer: string,
  incomingServer: string,
  collidedBaseServers: Map<string, Set<string>>,
  baseNameCandidates?: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const servers = getOrCreateSet(collidedBaseServers, baseName);
  servers.add(incumbentServer);
  servers.add(incomingServer);
  for (const candidate of baseNameCandidates?.get(baseName) ?? []) {
    servers.add(candidate);
  }
}

/**
 * Remove `serverName` from cross-server base-ownership, collision-set, and candidate-base
 * tracking, deleting any collision entry that drops below 2 competing servers and
 * transferring any sole surviving server back to `baseNameOwners` (#331).
 */
export function forgetServerCollisionState(
  serverName: string,
  baseNameOwners: Map<string, string>,
  collidedBaseServers: Map<string, Set<string>>,
  baseNameCandidates?: Map<string, Set<string>>,
): void {
  for (const [baseName, owner] of baseNameOwners) {
    if (owner === serverName) {
      baseNameOwners.delete(baseName);
    }
  }
  for (const [baseName, servers] of collidedBaseServers) {
    servers.delete(serverName);
    if (servers.size < 2) {
      collidedBaseServers.delete(baseName);
      const [survivor] = servers;
      if (survivor !== undefined) {
        baseNameOwners.set(baseName, survivor);
      }
    }
  }
  for (const [baseName, candidates] of baseNameCandidates ?? []) {
    candidates.delete(serverName);
    if (candidates.size === 0) {
      baseNameCandidates?.delete(baseName);
    }
  }
}

/** Collect resolved MCP exposures present in `next` that were absent from `previous`. */
export function collectAddedExposures(
  previous: ReadonlySet<McpExposure> | undefined,
  next: ReadonlySet<McpExposure>,
): Set<McpExposure> {
  return new Set([...next].filter((exposure) => !previous?.has(exposure)));
}

/**
 * Deterministically assign collision-free Pi tool names and resolved MCP exposures for a
 * server's discovered tools, and compute any previously owned Pi names withdrawn by this refresh.
 */
export function planServerToolBatch(options: PlanServerToolBatchOptions): ServerToolBatchPlan {
  const { prefix, serverName, tools, toolOwners, ownedPreviousNames, exposureConfig } = options;
  const plannedTools: PlannedServerTool[] = [];
  const currentToolNames = new Set<string>();
  const currentRawNames = new Map<string, string>();
  const currentExposures = new Map<string, McpExposure>();
  const piExposures = new Map<string, McpExposure>();
  const directToolNames = new Set<string>();
  const crossServerCollisions = new Map<string, string>();
  const stemLoser = isCollidingServerStemLoser(serverName, options.peerServerNames);
  // WHY: `tools/list` order carries no meaning (a server may reorder it freely), so colliding
  // names are assigned over a deterministic order of the tool set — otherwise the exact-match
  // tool could lose the unhashed name to a lossy one and a later refresh would swap which MCP
  // tool that name executes (#213).
  for (const tool of orderToolsForNameAssignment(prefix, serverName, tools)) {
    const baseCandidate = buildToolName(prefix, serverName, tool.name, false);
    const hashedCandidate = buildToolName(prefix, serverName, tool.name, true);
    const incumbent = stemLoser
      ? undefined
      : detectCrossServerCollision(baseCandidate, hashedCandidate, options);
    if (incumbent !== undefined) {
      crossServerCollisions.set(baseCandidate, incumbent);
    }
    const piName = resolveUniqueToolName({
      prefix,
      serverName,
      rawToolName: tool.name,
      seenInBatch: currentToolNames,
      toolOwners,
      forceHash: stemLoser || incumbent !== undefined,
      collidedBaseNames: options.collidedBaseNames,
      reservedNames: options.reservedNames,
    });
    const exposure = resolveToolExposure(exposureConfig, tool.name);
    plannedTools.push({ piName, tool, exposure });
    currentToolNames.add(piName);
    currentRawNames.set(piName, tool.name);
    currentExposures.set(tool.name, exposure);
    piExposures.set(piName, exposure);
    if (exposure === "direct") {
      directToolNames.add(piName);
    }
  }
  const withdrawnToolNames = ownedPreviousNames
    ? collectWithdrawnTools(ownedPreviousNames, currentToolNames)
    : new Set<string>();
  return {
    plannedTools,
    currentToolNames,
    currentRawNames,
    currentExposures,
    piExposures,
    directToolNames,
    withdrawnToolNames,
    crossServerCollisions,
  };
}

/**
 * Map each raw MCP tool name from the previous snapshot to whether Pi currently has
 * its assigned tool name active.
 */
export function snapshotActiveStateByRawName(
  ownedPreviousNames: ReadonlySet<string>,
  rawNamesBefore: ReadonlyMap<string, string> | undefined,
  activeBefore: ReadonlySet<string>,
): Map<string, boolean> {
  const stateByRawName = new Map<string, boolean>();
  for (const piName of ownedPreviousNames) {
    const rawName = rawNamesBefore?.get(piName) ?? piName;
    stateByRawName.set(rawName, activeBefore.has(piName));
  }
  return stateByRawName;
}

/**
 * Decide whether one advertised tool belongs in Pi's active set on a live `refreshTools`
 * of an already-connected server.
 *
 * - `"hidden"` is never active.
 * - A newly advertised tool (`prevActive === undefined`) activates iff `nextExposure === "direct"`.
 * - When `nextExposure` crosses between `"direct"` and non-`"direct"` relative to `prevExposure`
 *   (live exposure narrowing or widening), the new exposure decides.
 * - Otherwise Pi's current active/inactive state wins: a `direct` tool another extension
 *   deactivated stays inactive (#214), and a `deferred`/`codemode` tool `tool_search`
 *   loaded stays active until disconnect (#257).
 */
export function shouldActivateLiveTool(
  prevActive: boolean | undefined,
  prevExposure: McpExposure | undefined,
  nextExposure: McpExposure,
): boolean {
  if (nextExposure === "hidden") return false;
  if (prevActive === undefined) return nextExposure === "direct";
  if (prevExposure !== undefined && (prevExposure === "direct") !== (nextExposure === "direct")) {
    return nextExposure === "direct";
  }
  return prevActive;
}

function nextDroppedToolState(
  previousStateByRawName: ReadonlyMap<string, boolean>,
  seenRawNames: ReadonlySet<string>,
  previousDropped: ReadonlyMap<string, boolean> | undefined,
): Map<string, boolean> | undefined {
  const dropped = new Map<string, boolean>(previousDropped);
  for (const [rawName, wasActive] of previousStateByRawName) {
    if (!seenRawNames.has(rawName)) {
      dropped.set(rawName, wasActive);
    }
  }
  for (const rawName of seenRawNames) {
    dropped.delete(rawName);
  }
  return dropped.size > 0 ? dropped : undefined;
}

/**
 * Compute which Pi tool names in `currentRawNames` should be active after a live refresh,
 * and update the connection's dropped-tool memory.
 */
export function reconcileLiveRefreshState(input: LiveRefreshStateInput): LiveRefreshStateResult {
  const desiredActive = new Set<string>();
  const seenRawNames = new Set<string>();
  for (const [piName, rawName] of input.currentRawNames) {
    seenRawNames.add(rawName);
    const prevActive =
      input.previousStateByRawName.get(rawName) ?? input.previousDropped?.get(rawName);
    const nextExposure = input.currentExposures?.get(rawName) ?? DEFAULT_EXPOSURE;
    if (shouldActivateLiveTool(prevActive, input.previousExposures?.get(rawName), nextExposure)) {
      desiredActive.add(piName);
    }
  }
  return {
    desiredActive,
    dropped: nextDroppedToolState(
      input.previousStateByRawName,
      seenRawNames,
      input.previousDropped,
    ),
  };
}

/** Retain resolved exposures for currently advertised and dropped tools on an active connection. */
export function mergeRawToolExposures(
  previousExposures: ReadonlyMap<string, McpExposure> | undefined,
  currentExposures: ReadonlyMap<string, McpExposure>,
  dropped: ReadonlyMap<string, boolean> | undefined,
): Map<string, McpExposure> {
  const merged = new Map<string, McpExposure>(previousExposures);
  for (const [rawName, exposure] of currentExposures) {
    merged.set(rawName, exposure);
  }
  for (const rawName of merged.keys()) {
    if (!currentExposures.has(rawName) && !dropped?.has(rawName)) {
      merged.delete(rawName);
    }
  }
  return merged;
}

function hasDeferredExposureSupport(
  allTools: readonly RegisteredToolSummary[] | undefined,
): boolean {
  // WHY: Pi < 1.3.0 ignores `ToolDefinition.exposure`, leaves `tool.exposure` undefined in
  // `getAllTools()`, and auto-activates every registered tool — so without this guard every
  // indirect tool would look "restored from _pendingToolNames" on older runtimes (#257).
  return Boolean(allTools?.some((tool) => tool.exposure === "deferred"));
}

function isIndirectMcpExposure(exposure: McpExposure): boolean {
  return exposure === "deferred" || exposure === "codemode";
}

/**
 * Preserve indirect (`deferred` / `codemode`) tools that Pi 1.3.0's `registerTool()` activated
 * from `_pendingToolNames` (session resume, `/fork`, `/reload`, or `/tree` before reconnect)
 * so reconciling `activeTools` neither deactivates the restored tool nor triggers Pi's
 * `_pendingToolNames.clear()` across remaining servers still connecting (#257).
 */
export function mergePendingRestoredTools(input: PendingRestoredToolsInput): Set<string> {
  const merged = new Set(input.desiredActive);
  if (!hasDeferredExposureSupport(input.allTools)) return merged;
  const before = new Set(input.activeBefore);
  const after = new Set(input.activeAfterRegistration);
  for (const [piName, exposure] of input.piExposures) {
    if (isIndirectMcpExposure(exposure) && !before.has(piName) && after.has(piName)) {
      merged.add(piName);
    }
  }
  return merged;
}

/**
 * Order the active set so this bridge's tools are a pure function of the tool set: they are
 * sorted by Pi name among the positions they already occupy, while every entry another
 * extension owns keeps its position.
 *
 * WHY: a server's tools are registered as its connection completes, and `desiredActive`
 * follows `tools/list` order, which the MCP spec does not define. Without a fixed order the
 * active list — and with it the system prompt's tool section and the tools declared to the
 * provider — depends on eager-connect timing, so a server-side prefix cache keyed on the
 * prompt head misses on every session start or resume (#278).
 */
export function orderOwnedActiveTools(
  active: Iterable<string>,
  isOwned: (name: string) => boolean,
): string[] {
  const names = [...active];
  const ordered = orderOwnedEntries(names, (name) => name, isOwned);
  return ordered ?? names;
}

/**
 * Reconcile a server's active tools in Pi: drop any previously owned Pi tool names that
 * are not in `desiredActive`, append any `desiredActive` or `extraActive` names not yet
 * active, order the result, and return `undefined` when `currentActive` already holds that
 * exact list in that exact order so the caller skips `pi.setActiveTools`.
 */
export function planActiveToolReconciliation(
  input: ActiveToolReconciliationInput,
): string[] | undefined {
  const {
    ownedPreviousNames,
    desiredActive,
    activeBefore,
    currentActive,
    isOwned,
    extraActive = [],
  } = input;
  const activeSet = new Set(activeBefore);
  const remaining = activeBefore.filter(
    (name) => !ownedPreviousNames.has(name) || desiredActive.has(name),
  );
  const newlyActive = [...desiredActive, ...extraActive].filter((name) => !activeSet.has(name));
  const nextActive = orderOwnedActiveTools(new Set([...remaining, ...newlyActive]), isOwned);
  // WHY: `pi.registerTool()` inside the loop may have auto-activated a newly registered hashed
  // Pi name or a `--tools` allowlist entry, and a resumed session restores the order it ended
  // with — so compare against a fresh read and write whenever the set *or* the order differs.
  return sameToolList(currentActive, nextActive) ? undefined : nextActive;
}

/** Input for recording raw MCP tool names of `direct` tools stripped across `/tree` hops (#333). */
export interface UpdateTreeDeactivatedInput {
  existing: ReadonlySet<string> | undefined;
  directTools: ReadonlySet<string> | undefined;
  rawToolNames?: ReadonlyMap<string, string> | undefined;
  droppedToolState?: ReadonlyMap<string, boolean> | undefined;
  rawToolExposures?: ReadonlyMap<string, McpExposure> | undefined;
  beforeActive: ReadonlySet<string> | undefined;
  currentActive: ReadonlySet<string>;
}

/** Input for pruning tracked raw `/tree`-deactivated `direct` tool names (#333). */
export interface PruneTreeDeactivatedInput {
  existing: ReadonlySet<string> | undefined;
  directTools: ReadonlySet<string> | undefined;
  rawToolNames?: ReadonlyMap<string, string> | undefined;
  droppedToolState?: ReadonlyMap<string, boolean> | undefined;
  rawToolExposures?: ReadonlyMap<string, McpExposure> | undefined;
  nowActive: ReadonlySet<string>;
}

/** Input for restoring tracked raw `/tree`-deactivated `direct` tools onto Pi's active set (#333). */
export interface PlanTreeDirectToolRestoreInput {
  pendingRawNames: ReadonlySet<string> | undefined;
  directTools: ReadonlySet<string> | undefined;
  rawToolNames?: ReadonlyMap<string, string> | undefined;
  activeBefore: readonly string[];
  isOwned: (name: string) => boolean;
}

function collectDroppedDirectTools(
  existing: ReadonlySet<string> | undefined,
  activeRaw: ReadonlySet<string>,
  droppedToolState: ReadonlyMap<string, boolean> | undefined,
  rawToolExposures: ReadonlyMap<string, McpExposure> | undefined,
  target: Set<string>,
): void {
  if (!existing || !droppedToolState || !rawToolExposures) return;
  for (const rawName of existing) {
    if (
      !activeRaw.has(rawName) &&
      droppedToolState.has(rawName) &&
      rawToolExposures.get(rawName) === "direct"
    ) {
      target.add(rawName);
    }
  }
}

/**
 * Accumulate raw MCP tool names of `direct` tools stripped across one or more `/tree` hops,
 * retaining transiently dropped `direct` tools while pruning any that are active again on
 * `currentActive` or no longer `direct` (#333).
 * When `beforeActive` is `undefined`, no new deactivations are recorded.
 */
export function updateTreeDeactivatedDirectTools(
  input: UpdateTreeDeactivatedInput,
): Set<string> | undefined {
  const next = new Set<string>();
  const activeRaw = new Set<string>();
  if (input.directTools) {
    for (const piName of input.directTools) {
      const rawName = input.rawToolNames?.get(piName) ?? piName;
      if (input.currentActive.has(piName)) {
        activeRaw.add(rawName);
      } else if (input.beforeActive?.has(piName) || input.existing?.has(rawName)) {
        next.add(rawName);
      }
    }
  }
  collectDroppedDirectTools(
    input.existing,
    activeRaw,
    input.droppedToolState,
    input.rawToolExposures,
    next,
  );
  return next.size > 0 ? next : undefined;
}

/**
 * Prune tracked raw `/tree`-deactivated `direct` tool names against current `direct` tools,
 * dropped-direct memory, and `nowActive` Pi tool names (#333).
 */
export function pruneTreeDeactivatedDirectTools(
  input: PruneTreeDeactivatedInput,
): Set<string> | undefined {
  return updateTreeDeactivatedDirectTools({
    ...input,
    beforeActive: undefined,
    currentActive: input.nowActive,
  });
}

/**
 * Plan an additive, deterministically ordered active-tool list restoring `/tree`-deactivated
 * `direct` tools (resolved from raw MCP tool names to their current Pi names) without altering
 * any other extension's restrictions (#333).
 */
export function planTreeDirectToolRestore(
  input: PlanTreeDirectToolRestoreInput,
): string[] | undefined {
  const { pendingRawNames, directTools, rawToolNames, activeBefore, isOwned } = input;
  if (!pendingRawNames?.size || !directTools?.size) {
    return undefined;
  }
  const activeSet = new Set(activeBefore);
  const toRestore: string[] = [];
  for (const piName of directTools) {
    const rawName = rawToolNames?.get(piName) ?? piName;
    if (pendingRawNames.has(rawName) && !activeSet.has(piName)) {
      toRestore.push(piName);
    }
  }
  if (toRestore.length === 0) return undefined;
  const nextActive = orderOwnedActiveTools(new Set([...activeBefore, ...toRestore]), isOwned);
  return sameToolList(activeBefore, nextActive) ? undefined : nextActive;
}
