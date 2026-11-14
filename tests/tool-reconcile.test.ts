/**
 * Focused deterministic unit tests for pure reconciliation helpers in `src/tool-reconcile.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { McpToolDefinition } from "../src/tool-discovery.js";
import {
  collectWithdrawnTools,
  deleteServerOwnedTools,
  filterOwnedTools,
  normalizeRefreshArgs,
  orderOwnedActiveTools,
  planActiveToolReconciliation,
  planServerToolBatch,
  reconcileLiveRefreshState,
  snapshotActiveStateByRawName,
} from "../src/tool-reconcile.js";

function makeTool(name: string): McpToolDefinition {
  return { name, inputSchema: { type: "object", properties: {} } };
}

describe("tool-reconcile: normalizeRefreshArgs", () => {
  it("normalizes omitted, callback-only, options-only, and callback+options call shapes", () => {
    const none = normalizeRefreshArgs();
    assert.equal(none.isCurrent(), true);
    assert.equal(none.options, undefined);

    const guard = () => false;
    const callbackOnly = normalizeRefreshArgs(guard);
    assert.equal(callbackOnly.isCurrent, guard);
    assert.equal(callbackOnly.isCurrent(), false);
    assert.equal(callbackOnly.options, undefined);

    const ac = new AbortController();
    const opts = { requestTimeoutMs: 4200, signal: ac.signal };
    const optionsOnly = normalizeRefreshArgs(opts);
    assert.equal(optionsOnly.isCurrent(), true);
    assert.equal(optionsOnly.options, opts);

    const both = normalizeRefreshArgs(guard, opts);
    assert.equal(both.isCurrent, guard);
    assert.equal(both.options, opts);
  });
});

describe("tool-reconcile: ownership accounting", () => {
  it("filters owned tools, collects withdrawn tools, and deletes only server-owned entries", () => {
    const owners = new Map<string, string>([
      ["mcp_srv_a", "srv"],
      ["mcp_srv_b", "other"],
    ]);
    const candidates = new Set(["mcp_srv_a", "mcp_srv_b", "mcp_srv_unowned"]);
    assert.deepEqual(
      filterOwnedTools("srv", candidates, owners),
      new Set(["mcp_srv_a", "mcp_srv_unowned"]),
    );

    const withdrawn = collectWithdrawnTools(
      new Set(["mcp_srv_a", "mcp_srv_old"]),
      new Set(["mcp_srv_a", "mcp_srv_new"]),
    );
    assert.deepEqual(withdrawn, new Set(["mcp_srv_old"]));

    const serverToolNames = new Map<string, Set<string>>([
      ["srv", new Set(["mcp_srv_a", "mcp_srv_b"])],
    ]);
    deleteServerOwnedTools("missing", serverToolNames, owners);
    assert.equal(serverToolNames.has("srv"), true);

    deleteServerOwnedTools("srv", serverToolNames, owners);
    assert.equal(serverToolNames.has("srv"), false);
    assert.equal(owners.has("mcp_srv_a"), false);
    assert.equal(owners.get("mcp_srv_b"), "other");
  });
});

describe("tool-reconcile: planServerToolBatch", () => {
  it("assigns deterministic collision-free Pi names and computes withdrawn tools when ownedPreviousNames is given", () => {
    const toolOwners = new Map<string, string>([["mcp_a_b_shared", "a_b"]]);
    const tools = [makeTool("my-tool"), makeTool("my_tool"), makeTool("b_shared")];

    const planA = planServerToolBatch({
      prefix: "mcp",
      serverName: "a",
      tools,
      toolOwners,
      ownedPreviousNames: new Set(["mcp_a_my_tool", "mcp_a_retired"]),
    });
    const planB = planServerToolBatch({
      prefix: "mcp",
      serverName: "a",
      tools: [...tools].reverse(),
      toolOwners,
    });

    assert.equal(planA.currentRawNames.get("mcp_a_my_tool"), "my_tool");
    assert.equal(planB.currentRawNames.get("mcp_a_my_tool"), "my_tool");
    assert.equal(planA.currentToolNames.has("mcp_a_b_shared"), false);
    assert.equal(planA.plannedTools.length, 3);
    assert.deepEqual(planA.withdrawnToolNames, new Set(["mcp_a_retired"]));
    assert.deepEqual(planB.withdrawnToolNames, new Set());
  });
});

describe("tool-reconcile: snapshotActiveStateByRawName and reconcileLiveRefreshState", () => {
  it("snapshots active state by raw tool name with fallback when rawNamesBefore is absent", () => {
    const ownedPrev = new Set(["mcp_db_read", "mcp_db_write"]);
    const rawBefore = new Map<string, string>([["mcp_db_read", "read-data"]]);
    const activeBefore = new Set(["mcp_db_read"]);

    const withRawMap = snapshotActiveStateByRawName(ownedPrev, rawBefore, activeBefore);
    assert.deepEqual(
      withRawMap,
      new Map([
        ["read-data", true],
        ["mcp_db_write", false],
      ]),
    );

    const withoutRawMap = snapshotActiveStateByRawName(ownedPrev, undefined, activeBefore);
    assert.deepEqual(
      withoutRawMap,
      new Map([
        ["mcp_db_read", true],
        ["mcp_db_write", false],
      ]),
    );
  });

  it("preserves live active/inactive state across name shifts, tracks dropped tools, and clears dropped memory when empty", () => {
    const firstDrop = reconcileLiveRefreshState({
      currentRawNames: new Map([
        ["mcp_db_read_hashed", "read"],
        ["mcp_db_fresh", "fresh"],
      ]),
      previousStateByRawName: new Map([
        ["read", false],
        ["dropped_active", true],
        ["dropped_muted", false],
      ]),
    });

    assert.deepEqual(firstDrop.desiredActive, new Set(["mcp_db_fresh"]));
    assert.deepEqual(
      firstDrop.droppedState,
      new Map([
        ["dropped_active", true],
        ["dropped_muted", false],
      ]),
    );

    const reAdvertised = reconcileLiveRefreshState({
      currentRawNames: new Map([
        ["mcp_db_read_hashed", "read"],
        ["mcp_db_fresh", "fresh"],
        ["mcp_db_dropped_active", "dropped_active"],
        ["mcp_db_dropped_muted", "dropped_muted"],
      ]),
      previousStateByRawName: new Map([
        ["read", false],
        ["fresh", true],
      ]),
      previousDroppedState: firstDrop.droppedState,
    });

    assert.deepEqual(
      reAdvertised.desiredActive,
      new Set(["mcp_db_fresh", "mcp_db_dropped_active"]),
    );
    assert.equal(reAdvertised.droppedState, undefined);
  });
});

describe("tool-reconcile: orderOwnedActiveTools and planActiveToolReconciliation", () => {
  it("orders owned active tools inside their slots while preserving unowned entries", () => {
    const owned = new Set(["mcp_b_two", "mcp_a_one"]);
    assert.deepEqual(
      orderOwnedActiveTools(["read", "mcp_b_two", "bash", "mcp_a_one"], (n) => owned.has(n)),
      ["read", "mcp_a_one", "bash", "mcp_b_two"],
    );
    assert.deepEqual(
      orderOwnedActiveTools(["read", "mcp_a_one", "bash"], (n) => owned.has(n)),
      ["read", "mcp_a_one", "bash"],
    );
  });

  it("returns undefined when currentActive already matches nextActive, and returns sorted nextActive on membership or order drift", () => {
    const owned = new Set(["mcp_a_one", "mcp_b_two"]);
    const isOwned = (name: string) => owned.has(name);

    const unchanged = planActiveToolReconciliation({
      ownedPreviousNames: new Set(["mcp_a_one"]),
      desiredActive: new Set(["mcp_a_one", "mcp_b_two"]),
      activeBefore: ["read", "mcp_a_one"],
      currentActive: ["read", "mcp_a_one", "mcp_b_two"],
      isOwned,
    });
    assert.equal(unchanged, undefined);

    const reorderedOrChanged = planActiveToolReconciliation({
      ownedPreviousNames: new Set(["mcp_b_two", "mcp_old_gone"]),
      desiredActive: new Set(["mcp_b_two", "mcp_a_one"]),
      activeBefore: ["read", "mcp_b_two", "mcp_old_gone", "bash"],
      currentActive: ["read", "mcp_b_two", "bash", "mcp_a_one"],
      isOwned,
    });
    assert.deepEqual(reorderedOrChanged, ["read", "mcp_a_one", "bash", "mcp_b_two"]);
  });
});
