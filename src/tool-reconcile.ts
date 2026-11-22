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
import { orderToolsForNameAssignment, resolveUniqueToolName } from "./tool-names.js";
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
  // WHY: `tools/list` order carries no meaning (a server may reorder it freely), so colliding
  // names are assigned over a deterministic order of the tool set — otherwise the exact-match
  // tool could lose the unhashed name to a lossy one and a later refresh would swap which MCP
  // tool that name executes (#213).
  for (const tool of orderToolsForNameAssignment(prefix, serverName, tools)) {
    const piName = resolveUniqueToolName({
      prefix,
      serverName,
      rawToolName: tool.name,
      seenInBatch: currentToolNames,
      toolOwners,
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
