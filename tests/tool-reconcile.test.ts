/**
 * Focused deterministic unit tests for pure reconciliation helpers in `src/tool-reconcile.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { McpToolDefinition } from "../src/tool-discovery.js";
import {
  collectAddedExposures,
  collectWithdrawnTools,
  deleteServerOwnedTools,
  filterOwnedTools,
  forgetServerCollisionState,
  mergePendingRestoredTools,
  normalizeRefreshArgs,
  orderOwnedActiveTools,
  planActiveToolReconciliation,
  planServerToolBatch,
  planTreeDirectToolRestore,
  pruneTreeDeactivatedDirectTools,
  reconcileLiveRefreshState,
  recordBaseNameCandidate,
  recordCrossServerCollision,
  snapshotActiveStateByRawName,
  updateTreeDeactivatedDirectTools,
} from "../src/tool-reconcile.js";
import { isCollidingServerStemLoser } from "../src/tool-names.js";

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
  it("assigns deterministic collision-free Pi names, resolves exposures, and computes withdrawn tools", () => {
    const toolOwners = new Map<string, string>([["mcp_a_b_shared", "a_b"]]);
    const tools = [makeTool("my-tool"), makeTool("my_tool"), makeTool("b_shared")];

    const planA = planServerToolBatch({
      prefix: "mcp",
      serverName: "a",
      tools,
      toolOwners,
      ownedPreviousNames: new Set(["mcp_a_my_tool", "mcp_a_retired"]),
      exposureConfig: {
        exposure: "deferred",
        toolExposure: { my_tool: "direct", "my-*": "codemode" },
      },
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
    assert.deepEqual(planA.directToolNames, new Set(["mcp_a_my_tool"]));
    assert.equal(planA.currentExposures.get("my_tool"), "direct");
    assert.equal(planA.currentExposures.get("my-tool"), "codemode");
    assert.equal(planA.currentExposures.get("b_shared"), "deferred");
    assert.equal(planA.piExposures.get("mcp_a_my_tool"), "direct");
    assert.deepEqual(planA.withdrawnToolNames, new Set(["mcp_a_retired"]));
    assert.deepEqual(planB.withdrawnToolNames, new Set());
    assert.equal(planB.directToolNames.size, 3);
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
      firstDrop.dropped,
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
      previousDropped: firstDrop.dropped,
    });

    assert.deepEqual(
      reAdvertised.desiredActive,
      new Set(["mcp_db_fresh", "mcp_db_dropped_active"]),
    );
    assert.equal(reAdvertised.dropped, undefined);
  });
});

describe("tool-reconcile: mergePendingRestoredTools", () => {
  it("preserves deferred and codemode tools activated from _pendingToolNames, ignores hidden and live-narrowed tools, and no-ops on Pi < 1.3.0", () => {
    const piExposures = new Map([
      ["mcp_s_direct", "direct" as const],
      ["mcp_s_deferred", "deferred" as const],
      ["mcp_s_codemode", "codemode" as const],
      ["mcp_s_narrowed", "deferred" as const],
      ["mcp_s_hidden", "hidden" as const],
      ["mcp_s_inactive", "deferred" as const],
    ]);
    const pi13Tools = [
      { name: "mcp_s_direct", exposure: "direct" },
      { name: "mcp_s_deferred", exposure: "deferred" },
      { name: "mcp_s_codemode", exposure: "deferred" },
      { name: "mcp_s_narrowed", exposure: "deferred" },
      { name: "mcp_s_hidden", exposure: "hidden" },
      { name: "mcp_s_inactive", exposure: "deferred" },
    ];

    const merged = mergePendingRestoredTools({
      desiredActive: ["mcp_s_direct"],
      piExposures,
      // `mcp_s_narrowed` was ALREADY active before registration (live narrowing from direct -> deferred),
      // so it must NOT be treated as restored from `_pendingToolNames`.
      activeBefore: ["read", "mcp_s_narrowed"],
      activeAfterRegistration: [
        "read",
        "mcp_s_direct",
        "mcp_s_deferred",
        "mcp_s_codemode",
        "mcp_s_narrowed",
        "mcp_s_hidden",
      ],
      allTools: pi13Tools,
    });

    assert.deepEqual(
      merged,
      new Set(["mcp_s_direct", "mcp_s_deferred", "mcp_s_codemode"]),
    );

    // Pi < 1.3.0 (`allTools` undefined or lacking `exposure: "deferred"`) returns desiredActive unchanged
    assert.deepEqual(
      mergePendingRestoredTools({
        desiredActive: ["mcp_s_direct"],
        piExposures,
        activeBefore: ["read"],
        activeAfterRegistration: ["read", "mcp_s_direct", "mcp_s_deferred", "mcp_s_codemode"],
        allTools: [{ name: "mcp_s_deferred" }, { name: "mcp_s_codemode" }],
      }),
      new Set(["mcp_s_direct"]),
    );
    assert.deepEqual(
      mergePendingRestoredTools({
        desiredActive: ["mcp_s_direct"],
        piExposures,
        activeBefore: ["read"],
        activeAfterRegistration: ["read", "mcp_s_direct", "mcp_s_deferred"],
        allTools: undefined,
      }),
      new Set(["mcp_s_direct"]),
    );
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

  it("returns undefined when currentActive already matches nextActive, and includes extraActive discovery tools", () => {
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
      extraActive: ["tool_search"],
    });
    assert.deepEqual(reorderedOrChanged, ["read", "mcp_a_one", "bash", "mcp_b_two", "tool_search"]);
  });
});

describe("tool-reconcile: cross-server stem disambiguation, reservedNames, and baseNameOwners (#331, #332)", () => {
  it("isCollidingServerStemLoser picks lossless then code-point winner and leaves distinct prefixes untouched", () => {
    assert.equal(isCollidingServerStemLoser("my-srv", ["my-srv", "my_srv"]), true);
    assert.equal(isCollidingServerStemLoser("my_srv", ["my-srv", "my_srv"]), false);
    assert.equal(isCollidingServerStemLoser("a-b", ["a-b", "a.b", "a_b"]), true);
    assert.equal(isCollidingServerStemLoser("a.b", ["a-b", "a.b", "a_b"]), true);
    assert.equal(isCollidingServerStemLoser("a_b", ["a-b", "a.b", "a_b"]), false);
    assert.equal(isCollidingServerStemLoser("a-b", ["a-b", "a.b"]), false);
    assert.equal(isCollidingServerStemLoser("a.b", ["a-b", "a.b"]), true);
    assert.equal(isCollidingServerStemLoser("github", ["github", "github_enterprise"]), false);
    assert.equal(isCollidingServerStemLoser("github_enterprise", ["github", "github_enterprise"]), false);
  });

  it("planServerToolBatch respects peerServerNames, collidedBaseNames, baseNameOwners, and reservedNames", () => {
    const loserPlan = planServerToolBatch({
      prefix: "mcp",
      serverName: "my-srv",
      tools: [makeTool("run")],
      toolOwners: new Map(),
      peerServerNames: ["my-srv", "my_srv"],
    });
    assert.match(loserPlan.plannedTools[0]!.piName, /^mcp_my_srv_run_[0-9a-f]{8}$/);
    assert.equal(loserPlan.crossServerCollisions.size, 0);

    const winnerPlan = planServerToolBatch({
      prefix: "mcp",
      serverName: "my_srv",
      tools: [makeTool("run")],
      toolOwners: new Map(),
      peerServerNames: ["my-srv", "my_srv"],
    });
    assert.equal(winnerPlan.plannedTools[0]!.piName, "mcp_my_srv_run");

    const distinctPlan = planServerToolBatch({
      prefix: "mcp",
      serverName: "github_enterprise",
      tools: [makeTool("list_issues")],
      toolOwners: new Map([["mcp_github_list_issues", "github"]]),
      peerServerNames: ["github", "github_enterprise"],
    });
    assert.equal(distinctPlan.plannedTools[0]!.piName, "mcp_github_enterprise_list_issues");

    // Transient withdrawal held in baseNameOwners still triggers crossServerCollisions
    const baseOwnerPlan = planServerToolBatch({
      prefix: "mcp",
      serverName: "a_b",
      tools: [makeTool("c")],
      toolOwners: new Map(),
      baseNameOwners: new Map([["mcp_a_b_c", "a"]]),
    });
    assert.match(baseOwnerPlan.plannedTools[0]!.piName, /^mcp_a_b_c_[0-9a-f]{8}$/);
    assert.deepEqual(baseOwnerPlan.crossServerCollisions, new Map([["mcp_a_b_c", "a"]]));

    // reservedNames forces hashed fallback (and _2 suffix if hashed candidate is also reserved) without recording crossServerCollisions
    const reserved = new Set(["mcp_list_resources"]);
    const reservedPlan = planServerToolBatch({
      prefix: "mcp",
      serverName: "list",
      tools: [makeTool("resources")],
      toolOwners: new Map(),
      reservedNames: reserved,
    });
    const firstHash = reservedPlan.plannedTools[0]!.piName;
    assert.match(firstHash, /^mcp_list_resources_[0-9a-f]{8}$/);
    assert.equal(reservedPlan.crossServerCollisions.size, 0);

    const doubleReserved = new Set(["mcp_list_resources", firstHash]);
    const suffixedPlan = planServerToolBatch({
      prefix: "mcp",
      serverName: "list",
      tools: [makeTool("resources")],
      toolOwners: new Map(),
      reservedNames: doubleReserved,
    });
    assert.equal(suffixedPlan.plannedTools[0]!.piName, `${firstHash}_2`);
  });

  it("forgetServerCollisionState, recordBaseNameCandidate, and recordCrossServerCollision keep 3-server stem-loser collisions order-invariant (#331)", () => {
    // 2-way collision set -> drop 1 -> survivor moves to baseNameOwners -> drop survivor -> empty
    const baseOwners2 = new Map<string, string>([["mcp_a_other", "a_b"]]);
    const collided2 = new Map<string, Set<string>>([["mcp_a_b_c", new Set(["a", "a_b"])]]);
    forgetServerCollisionState("a_b", baseOwners2, collided2);
    assert.equal(collided2.has("mcp_a_b_c"), false);
    assert.deepEqual(baseOwners2, new Map([["mcp_a_b_c", "a"]]));

    forgetServerCollisionState("a", baseOwners2, collided2);
    assert.equal(collided2.size, 0);
    assert.equal(baseOwners2.size, 0);

    // 3-way collision set -> drop 1 keeps collision set -> drop 2nd hands off survivor -> drop 3rd clears
    const baseOwners3 = new Map<string, string>();
    const collided3 = new Map<string, Set<string>>([
      ["mcp_x_y_z_w", new Set(["x", "x_y", "x_y_z"])],
    ]);
    forgetServerCollisionState("x", baseOwners3, collided3);
    assert.deepEqual(collided3.get("mcp_x_y_z_w"), new Set(["x_y", "x_y_z"]));
    assert.equal(baseOwners3.size, 0);

    forgetServerCollisionState("x_y_z", baseOwners3, collided3);
    assert.equal(collided3.has("mcp_x_y_z_w"), false);
    assert.deepEqual(baseOwners3, new Map([["mcp_x_y_z_w", "x_y"]]));

    forgetServerCollisionState("x_y", baseOwners3, collided3);
    assert.equal(collided3.size, 0);
    assert.equal(baseOwners3.size, 0);

    // Stem-loser `my-srv` connected before `my` + `my_srv` collided: baseNameCandidates pulls it into collidedBaseServers
    const candidates = new Map<string, Set<string>>();
    const baseOwnersCombined = new Map<string, string>();
    const collidedCombined = new Map<string, Set<string>>();
    recordBaseNameCandidate(candidates, "mcp_my_srv_run", "my-srv");
    recordBaseNameCandidate(candidates, "mcp_my_srv_run", "my");
    recordCrossServerCollision("mcp_my_srv_run", "my", "my_srv", collidedCombined, candidates);
    recordBaseNameCandidate(candidates, "mcp_my_srv_run", "my_srv");
    assert.deepEqual(collidedCombined.get("mcp_my_srv_run"), new Set(["my", "my_srv", "my-srv"]));

    // Removing `my_srv` retains {"my", "my-srv"} in collidedBaseServers
    forgetServerCollisionState("my_srv", baseOwnersCombined, collidedCombined, candidates);
    assert.deepEqual(collidedCombined.get("mcp_my_srv_run"), new Set(["my", "my-srv"]));
    assert.deepEqual(candidates.get("mcp_my_srv_run"), new Set(["my-srv", "my"]));
    assert.equal(baseOwnersCombined.size, 0);

    // Removing `my-srv` transfers sole survivor `my` back to baseNameOwners
    forgetServerCollisionState("my-srv", baseOwnersCombined, collidedCombined, candidates);
    assert.equal(collidedCombined.has("mcp_my_srv_run"), false);
    assert.deepEqual(baseOwnersCombined, new Map([["mcp_my_srv_run", "my"]]));
    assert.deepEqual(candidates.get("mcp_my_srv_run"), new Set(["my"]));

    // Removing `my` clears every map cleanly
    forgetServerCollisionState("my", baseOwnersCombined, collidedCombined, candidates);
    assert.equal(collidedCombined.size, 0);
    assert.equal(baseOwnersCombined.size, 0);
    assert.equal(candidates.size, 0);
  });

  it("collectAddedExposures returns only exposures newly added relative to previous", () => {
    assert.deepEqual(
      collectAddedExposures(undefined, new Set(["deferred", "direct"])),
      new Set(["deferred", "direct"]),
    );
    assert.deepEqual(collectAddedExposures(new Set(), new Set(["codemode"])), new Set(["codemode"]));
    assert.deepEqual(
      collectAddedExposures(new Set(["deferred"]), new Set(["deferred", "codemode"])),
      new Set(["codemode"]),
    );
    assert.deepEqual(
      collectAddedExposures(new Set(["deferred"]), new Set(["deferred"])),
      new Set(),
    );
  });
});

describe("tool-reconcile: /tree deactivated direct tool helpers (#333)", () => {
  it("accumulates multi-hop /tree deactivations by raw name, ignores missing beforeActive, and clears on forward hop", () => {
    const direct = new Set(["mcp_s_a", "mcp_s_b"]);
    const rawToolNames = new Map<string, string>([
      ["mcp_s_a", "raw-a"],
      ["mcp_s_b", "raw-b"],
    ]);
    // Hop 1: Turn 2 (only a active) -> Turn 1a (neither active)
    const hop1 = updateTreeDeactivatedDirectTools({
      existing: undefined,
      directTools: direct,
      rawToolNames,
      beforeActive: new Set(["read", "mcp_s_a"]),
      currentActive: new Set(["read"]),
    });
    assert.deepEqual(hop1, new Set(["raw-a"]));

    // Hop 2: Turn 1a -> Turn 1b (neither active) retains raw-a
    const hop2 = updateTreeDeactivatedDirectTools({
      existing: hop1,
      directTools: direct,
      rawToolNames,
      beforeActive: new Set(["read"]),
      currentActive: new Set(["read"]),
    });
    assert.deepEqual(hop2, new Set(["raw-a"]));

    // Missing beforeActive records no new deactivations, only prunes currentActive
    assert.equal(
      updateTreeDeactivatedDirectTools({
        existing: undefined,
        directTools: direct,
        rawToolNames,
        beforeActive: undefined,
        currentActive: new Set(["read"]),
      }),
      undefined,
    );
    assert.deepEqual(
      updateTreeDeactivatedDirectTools({
        existing: hop2,
        directTools: direct,
        rawToolNames,
        beforeActive: undefined,
        currentActive: new Set(["read"]),
      }),
      new Set(["raw-a"]),
    );

    // Forward hop to Turn 2 where mcp_s_a is active clears raw-a
    assert.equal(
      updateTreeDeactivatedDirectTools({
        existing: hop2,
        directTools: direct,
        rawToolNames,
        beforeActive: new Set(["read"]),
        currentActive: new Set(["read", "mcp_s_a"]),
      }),
      undefined,
    );
  });

  it("retains transiently dropped direct raw tools across /tree and pruning while pruning exposure changes and active tools", () => {
    const dropped = new Map<string, boolean>([
      ["dropped_direct", false],
      ["dropped_deferred", false],
    ]);
    const exposures = new Map<string, "direct" | "deferred" | "codemode" | "hidden">([
      ["my-tool", "direct"],
      ["my_tool", "direct"],
      ["dropped_direct", "direct"],
      ["dropped_deferred", "deferred"],
      ["turned_deferred", "deferred"],
    ]);
    // Intra-server rename: `my_tool` claimed & activated `mcp_s_my_tool`, while `my-tool` moved to hashed and stayed inactive
    const rawToolNames = new Map<string, string>([
      ["mcp_s_my_tool", "my_tool"],
      ["mcp_s_my_tool_deadbeef", "my-tool"],
      ["mcp_s_turned_deferred", "turned_deferred"],
    ]);
    const directTools = new Set(["mcp_s_my_tool", "mcp_s_my_tool_deadbeef"]);

    const pruned = pruneTreeDeactivatedDirectTools({
      existing: new Set(["my-tool", "my_tool", "dropped_direct", "dropped_deferred", "turned_deferred"]),
      directTools,
      rawToolNames,
      droppedToolState: dropped,
      rawToolExposures: exposures,
      nowActive: new Set(["mcp_s_my_tool"]),
    });
    assert.deepEqual(pruned, new Set(["my-tool", "dropped_direct"]));

    // Multi-hop /tree while `dropped_direct` is still dropped retains it
    const afterTreeDuringDrop = updateTreeDeactivatedDirectTools({
      existing: new Set(["dropped_direct"]),
      directTools: new Set(),
      rawToolNames: new Map(),
      droppedToolState: dropped,
      rawToolExposures: exposures,
      beforeActive: new Set(["read"]),
      currentActive: new Set(["read"]),
    });
    assert.deepEqual(afterTreeDuringDrop, new Set(["dropped_direct"]));

    // Restoring resolves raw `my-tool` onto its current hashed Pi name without touching already-active tools
    const owned = new Set(["mcp_s_my_tool", "mcp_s_my_tool_deadbeef", "mcp_other_z"]);
    const next = planTreeDirectToolRestore({
      pendingRawNames: new Set(["my-tool", "dropped_direct"]),
      directTools,
      rawToolNames,
      activeBefore: ["read", "mcp_other_z", "mcp_s_my_tool"],
      isOwned: (n) => owned.has(n),
    });
    assert.deepEqual(next, ["read", "mcp_other_z", "mcp_s_my_tool", "mcp_s_my_tool_deadbeef"]);

    // Already active -> undefined
    assert.equal(
      planTreeDirectToolRestore({
        pendingRawNames: new Set(["my_tool"]),
        directTools,
        rawToolNames,
        activeBefore: ["read", "mcp_s_my_tool"],
        isOwned: (n) => owned.has(n),
      }),
      undefined,
    );
  });
});
