/**
 * Pure tool-reconciliation, ownership accounting, live `tools/list_changed`
 * active-state preservation (#214), and deterministic active-set planning (#278)
 * for pi-mcp.
 */

import type { McpToolDefinition } from "./tool-discovery.js";
import { orderToolsForNameAssignment, resolveUniqueToolName } from "./tool-names.js";
import { orderOwnedEntries, sameToolList } from "./tool-order.js";

/** Structural shape of `refreshTools` options accepted by {@link normalizeRefreshArgs}. */
export interface RefreshArgsOptions {
  requestTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

/** One discovered MCP tool paired with its deterministically assigned Pi identifier. */
export interface PlannedServerTool {
  piName: string;
  tool: McpToolDefinition;
}

/** Input for planning a server's tool-registration batch and withdrawn ownership. */
export interface PlanServerToolBatchOptions {
  prefix: string;
  serverName: string;
  tools: readonly McpToolDefinition[];
  toolOwners: ReadonlyMap<string, string>;
  ownedPreviousNames?: ReadonlySet<string> | undefined;
}

/** Planned registration batch, Pi→raw lookup tables, and withdrawn tool names for one server. */
export interface ServerToolBatchPlan {
  plannedTools: PlannedServerTool[];
  currentToolNames: Set<string>;
  currentRawNames: Map<string, string>;
  withdrawnToolNames: Set<string>;
}

/** Input for preserving active/inactive tool state across a live `tools/list_changed` refresh. */
export interface LiveRefreshStateInput {
  currentRawNames: ReadonlyMap<string, string>;
  previousStateByRawName: ReadonlyMap<string, boolean>;
  previousDroppedState?: ReadonlyMap<string, boolean> | undefined;
}

/** Desired active Pi tool names and updated dropped-tool memory after a live refresh. */
export interface LiveRefreshStateResult {
  desiredActive: Set<string>;
  droppedState: Map<string, boolean> | undefined;
}

/** Input for computing the next ordered active-tool list in Pi. */
export interface ActiveToolReconciliationInput {
  ownedPreviousNames: ReadonlySet<string>;
  desiredActive: ReadonlySet<string>;
  activeBefore: readonly string[];
  currentActive: readonly string[];
  isOwned: (name: string) => boolean;
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
 * Deterministically assign collision-free Pi tool names for a server's discovered tools
 * and compute any previously owned Pi names withdrawn by this refresh.
 */
export function planServerToolBatch(options: PlanServerToolBatchOptions): ServerToolBatchPlan {
  const { prefix, serverName, tools, toolOwners, ownedPreviousNames } = options;
  const plannedTools: PlannedServerTool[] = [];
  const currentToolNames = new Set<string>();
  const currentRawNames = new Map<string, string>();
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
    plannedTools.push({ piName, tool });
    currentToolNames.add(piName);
    currentRawNames.set(piName, tool.name);
  }
  const withdrawnToolNames = ownedPreviousNames
    ? collectWithdrawnTools(ownedPreviousNames, currentToolNames)
    : new Set<string>();
  return { plannedTools, currentToolNames, currentRawNames, withdrawnToolNames };
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
 * Record the active state of tools dropped in this live refresh, forget tools that are
 * currently advertised, and return `undefined` when no dropped tools remain.
 */
function nextDroppedToolState(
  previousStateByRawName: ReadonlyMap<string, boolean>,
  currentRawNames: ReadonlySet<string>,
  previousDroppedState: ReadonlyMap<string, boolean> | undefined,
): Map<string, boolean> | undefined {
  const dropped = new Map<string, boolean>(previousDroppedState);
  for (const [rawName, wasActive] of previousStateByRawName) {
    if (!currentRawNames.has(rawName)) {
      dropped.set(rawName, wasActive);
    }
  }
  for (const rawName of currentRawNames) {
    dropped.delete(rawName);
  }
  return dropped.size > 0 ? dropped : undefined;
}

/**
 * Compute which Pi tool names in `currentRawNames` should be active after a live refresh,
 * and compute the server's updated dropped-tool memory.
 *
 * A tool present in the previous snapshot keeps the active/inactive state Pi currently
 * reports for it (even if a colliding sibling shifted its Pi name). A tool absent from the
 * previous snapshot restores the state it left in when dropped on this connection, or
 * activates as newly discovered.
 *
 * WHY: `pi.setActiveTools` is shared with every other extension and the user, so an already
 * connected server's tool set may have been narrowed on purpose. A live `tools/list_changed`
 * therefore preserves each raw tool's active/inactive state (including across collision
 * re-settlement and drop/re-advertisement), while a first connect or a reconnect after
 * `deactivateServer` activates the whole discovered set (#214).
 */
export function reconcileLiveRefreshState(input: LiveRefreshStateInput): LiveRefreshStateResult {
  const { currentRawNames, previousStateByRawName, previousDroppedState } = input;
  const desiredActive = new Set<string>();
  const seenRawNames = new Set<string>();
  for (const [piName, rawName] of currentRawNames) {
    seenRawNames.add(rawName);
    const shouldActivate =
      previousStateByRawName.get(rawName) ?? previousDroppedState?.get(rawName) ?? true;
    if (shouldActivate) {
      desiredActive.add(piName);
    }
  }
  return {
    desiredActive,
    droppedState: nextDroppedToolState(previousStateByRawName, seenRawNames, previousDroppedState),
  };
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
 * are not in `desiredActive`, append any `desiredActive` names not yet active, order the
 * result, and return `undefined` when `currentActive` already holds that exact list in
 * that exact order so the caller skips `pi.setActiveTools`.
 */
export function planActiveToolReconciliation(
  input: ActiveToolReconciliationInput,
): string[] | undefined {
  const { ownedPreviousNames, desiredActive, activeBefore, currentActive, isOwned } = input;
  const activeSet = new Set(activeBefore);
  const remaining = activeBefore.filter(
    (name) => !ownedPreviousNames.has(name) || desiredActive.has(name),
  );
  const newlyActive = [...desiredActive].filter((name) => !activeSet.has(name));
  const nextActive = orderOwnedActiveTools(new Set([...remaining, ...newlyActive]), isOwned);
  // WHY: `pi.registerTool()` inside the loop may have auto-activated a newly registered hashed
  // Pi name or a `--tools` allowlist entry, and a resumed session restores the order it ended
  // with — so compare against a fresh read and write whenever the set *or* the order differs.
  return sameToolList(currentActive, nextActive) ? undefined : nextActive;
}
