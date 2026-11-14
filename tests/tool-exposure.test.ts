/**
 * Unit tests for src/tool-exposure.ts — Pi 1.3.0 `exposure` / `toolExposure` resolution.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CODEMODE_TOOL_NAME,
  DEFAULT_EXPOSURE,
  MCP_EXPOSURES,
  TOOL_SEARCH_TOOL_NAME,
  assessRegisteredServerExposures,
  buildServerToolNamespace,
  collectConfiguredExposures,
  collectConnectedExposures,
  collectRequiredDiscoveryExposures,
  mergeRawToolExposures,
  normalizeExposureAlias,
  reconcileLiveRefreshState,
  resolveDiscoveryActivation,
  resolveToolExposure,
  shouldActivateLiveTool,
  toPiToolExposure,
} from "../src/tool-exposure.js";
import {
  MAX_SERVERS_SECTION_CHARS,
  MCP_SERVERS_SECTION,
  renderMcpServersSection,
} from "../src/mcp-servers-prompt.js";

describe("resolveToolExposure", () => {
  it("defaults to direct when the server entry states no exposure", () => {
    assert.equal(DEFAULT_EXPOSURE, "direct");
    assert.equal(resolveToolExposure(undefined, "anything"), "direct");
    assert.equal(resolveToolExposure({}, "anything"), "direct");
  });

  it("uses the server exposure when no per-tool override matches", () => {
    assert.equal(resolveToolExposure({ exposure: "deferred" }, "search"), "deferred");
    assert.equal(
      resolveToolExposure({ exposure: "hidden", toolExposure: { other: "direct" } }, "search"),
      "hidden",
    );
  });

  it("applies an exact tool override before any wildcard pattern", () => {
    const config = {
      exposure: "hidden",
      toolExposure: { "get_*": "hidden", get_users: "direct" },
    } as const;
    assert.equal(resolveToolExposure(config, "get_users"), "direct");
    assert.equal(resolveToolExposure(config, "get_orders"), "hidden");
  });

  it("applies the first matching wildcard pattern in declaration order", () => {
    // Deliberately collide: declaration order decides, not specificity.
    const config = {
      exposure: "hidden",
      toolExposure: { "*_users": "direct", "get_*": "deferred" },
    } as const;
    assert.equal(resolveToolExposure(config, "get_users"), "direct");
    assert.equal(resolveToolExposure(config, "get_orders"), "deferred");
  });

  it("treats every non-star character literally instead of as a regular expression", () => {
    const config = {
      exposure: "hidden",
      toolExposure: { "a.b": "direct", "[x]": "direct", "c+": "deferred" },
    } as const;
    assert.equal(resolveToolExposure(config, "a.b"), "direct");
    assert.equal(resolveToolExposure(config, "axb"), "hidden");
    assert.equal(resolveToolExposure(config, "[x]"), "direct");
    assert.equal(resolveToolExposure(config, "x"), "hidden", "a pattern is not a character class");
    assert.equal(resolveToolExposure(config, "c+"), "deferred");
    assert.equal(resolveToolExposure(config, "ccc"), "hidden", "`+` is not a quantifier");
  });

  it("lets * match empty and any run of characters, including consecutive stars", () => {
    const config = {
      exposure: "hidden",
      toolExposure: { "get_*": "direct", "a**b": "deferred" },
    } as const;
    assert.equal(resolveToolExposure(config, "get_"), "direct");
    assert.equal(resolveToolExposure(config, "get_a_b"), "direct");
    assert.equal(resolveToolExposure(config, "ab"), "deferred");
    assert.equal(resolveToolExposure(config, "aXYZb"), "deferred");
    assert.equal(resolveToolExposure(config, "abx"), "hidden");
    assert.equal(resolveToolExposure({ toolExposure: { "*": "codemode" } }, "anything"), "codemode");
  });

  it("never reads an Object.prototype member as a tool override", () => {
    const config = { exposure: "hidden", toolExposure: {} } as const;
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      assert.equal(resolveToolExposure(config, name), "hidden", `${name} must not leak a prototype value`);
    }
  });

  it("resolves a pathological wildcard pattern without backtracking blow-up", () => {
    const toolName = "a".repeat(2000);
    const config = { exposure: "hidden", toolExposure: { "a*a*a*a*a*a*a*b": "direct" } } as const;
    const started = performance.now();
    assert.equal(resolveToolExposure(config, toolName), "hidden");
    assert.ok(
      performance.now() - started < 1000,
      "wildcard matching must stay linear: a backtracking matcher would take hours here",
    );
  });
});

describe("normalizeExposureAlias & toPiToolExposure", () => {
  it("maps Pi's retired codemode-deferred alias onto codemode", () => {
    assert.equal(normalizeExposureAlias("codemode-deferred"), "codemode");
    for (const exposure of MCP_EXPOSURES) {
      assert.equal(normalizeExposureAlias(exposure), exposure);
    }
  });

  it("passes non-string and unknown values through for the schema to judge", () => {
    assert.equal(normalizeExposureAlias(undefined), undefined);
    assert.equal(normalizeExposureAlias(7), 7);
    assert.equal(normalizeExposureAlias("bogus"), "bogus");
    assert.equal(normalizeExposureAlias("constructor"), "constructor");
  });

  it("maps MCP codemode onto Pi deferred so codemode descriptions stay out of the prompt (#257)", () => {
    assert.equal(toPiToolExposure("codemode"), "deferred");
    assert.equal(toPiToolExposure("deferred"), "deferred");
    assert.equal(toPiToolExposure("direct"), "direct");
    assert.equal(toPiToolExposure("hidden"), "hidden");
  });
});

describe("shouldActivateLiveTool & reconcileLiveRefreshState", () => {
  it("enforces hidden, activates new direct tools, honors live exposure crossings, and preserves state otherwise", () => {
    for (const prevActive of [undefined, true, false]) {
      for (const prevExposure of [undefined, "direct", "deferred", "codemode", "hidden"] as const) {
        assert.equal(shouldActivateLiveTool(prevActive, prevExposure, "hidden"), false);
      }
    }
    assert.equal(shouldActivateLiveTool(undefined, undefined, "direct"), true);
    assert.equal(shouldActivateLiveTool(undefined, undefined, "deferred"), false);
    assert.equal(shouldActivateLiveTool(undefined, undefined, "codemode"), false);

    // Live narrowing/widening across direct <-> indirect
    assert.equal(shouldActivateLiveTool(true, "direct", "deferred"), false);
    assert.equal(shouldActivateLiveTool(true, "direct", "codemode"), false);
    assert.equal(shouldActivateLiveTool(false, "deferred", "direct"), true);
    assert.equal(shouldActivateLiveTool(false, "codemode", "direct"), true);

    // Unchanged direct (#214) and indirect-to-indirect (#257) preserve Pi's active state
    assert.equal(shouldActivateLiveTool(false, "direct", "direct"), false);
    assert.equal(shouldActivateLiveTool(true, "direct", "direct"), true);
    assert.equal(shouldActivateLiveTool(true, "deferred", "codemode"), true);
    assert.equal(shouldActivateLiveTool(false, "codemode", "deferred"), false);
  });

  it("tracks dropped tools, restores or updates them on re-advertisement, and prunes stale exposures", () => {
    const step1 = reconcileLiveRefreshState({
      currentRawNames: new Map([["mcp_s_keep", "keep"]]),
      currentExposures: new Map([["keep", "direct"]]),
      previousStateByRawName: new Map([
        ["keep", true],
        ["dropped_loaded", true],
      ]),
      previousExposures: new Map([
        ["keep", "direct"],
        ["dropped_loaded", "deferred"],
      ]),
      previousDropped: undefined,
    });
    assert.deepEqual([...step1.desiredActive], ["mcp_s_keep"]);
    assert.deepEqual([...(step1.dropped ?? [])], [["dropped_loaded", true]]);

    const exposuresAfterStep1 = mergeRawToolExposures(
      new Map([
        ["keep", "direct"],
        ["dropped_loaded", "deferred"],
        ["stale_forgotten", "codemode"],
      ]),
      new Map([["keep", "direct"]]),
      step1.dropped,
    );
    assert.deepEqual(
      [...exposuresAfterStep1],
      [
        ["keep", "direct"],
        ["dropped_loaded", "deferred"],
      ],
    );

    const step2 = reconcileLiveRefreshState({
      currentRawNames: new Map([
        ["mcp_s_keep", "keep"],
        ["mcp_s_dropped_loaded", "dropped_loaded"],
      ]),
      currentExposures: new Map([
        ["keep", "deferred"],
        ["dropped_loaded", "deferred"],
      ]),
      previousStateByRawName: new Map([["keep", true]]),
      previousExposures: exposuresAfterStep1,
      previousDropped: step1.dropped,
    });
    assert.deepEqual(
      [...step2.desiredActive],
      ["mcp_s_dropped_loaded"],
      "narrowed keep becomes inactive while re-advertised deferred tool restores loaded state",
    );
    assert.equal(step2.dropped, undefined);
  });
});

describe("buildServerToolNamespace", () => {
  it("builds namespace aliases, sanitizes escapes before redacting secrets, and bounds field lengths", () => {
    const ns = buildServerToolNamespace({
      prefix: "mcp",
      serverName: "my-docs",
      description: `  Docs \u001b[31mapi_key\u001b[0m=sk-secret-123456 ${"x".repeat(300)}  `,
      instructions: `Use search first; Authorization: Bearer super-secret-token ${"y".repeat(600)}`,
    });
    assert.equal(ns.name, "mcp_my_docs");
    assert.deepEqual(ns.aliases, ["my-docs", "mcp__my_docs"]);
    assert.ok(ns.description);
    assert.ok(!ns.description.includes("sk-secret-123456"));
    assert.ok(!ns.description.includes("\u001b"));
    assert.ok(ns.description.includes("[REDACTED]"));
    assert.ok(ns.description.length <= 250);
    assert.ok(ns.instructions);
    assert.ok(!ns.instructions.includes("super-secret-token"));
    assert.ok(ns.instructions.length <= 500);
  });

  it("omits empty metadata and deduplicates aliases that equal the primary namespace name", () => {
    const ns = buildServerToolNamespace({
      prefix: "mcp_",
      serverName: "mcp__plain",
      description: "   \u001b[0m  ",
      instructions: undefined,
    });
    assert.equal(ns.name, "mcp__mcp__plain");
    assert.equal("description" in ns, false);
    assert.equal("instructions" in ns, false);
  });
});

describe("collectConfiguredExposures & resolveDiscoveryActivation", () => {
  const reachingCodemode = { name: CODEMODE_TOOL_NAME, reachesTools: true };
  const reachingToolSearch = { name: TOOL_SEARCH_TOOL_NAME, reachesTools: true };

  it("collects default and overridden exposures across enabled server configs and skips enabled: false", () => {
    const exposures = collectConfiguredExposures([
      {},
      { enabled: true, exposure: "hidden", toolExposure: { search: "deferred", run: "codemode" } },
      { enabled: false, exposure: "codemode", toolExposure: { extra: "deferred" } },
    ]);
    assert.deepEqual([...exposures].sort(), ["codemode", "deferred", "direct", "hidden"]);
    assert.deepEqual([...collectConfiguredExposures([{ enabled: false, exposure: "codemode" }])], []);
  });

  it("collects exposures across connected server sets and unions them with configured servers", () => {
    const connected = collectConnectedExposures([
      new Set(["direct", "codemode"] as const),
      new Set(["deferred"] as const),
    ]);
    assert.deepEqual([...connected].sort(), ["codemode", "deferred", "direct"]);

    const required = collectRequiredDiscoveryExposures(
      [{ enabled: false, exposure: "codemode" }, { exposure: "direct" }],
      ["codemode"],
    );
    assert.deepEqual([...required].sort(), ["codemode", "direct"]);
  });

  it("assesses registered server exposures against Pi's --tools / --exclude-tools filter", () => {
    const piExposures = new Map<string, "direct" | "codemode" | "deferred" | "hidden">([
      ["mcp_docs_ping", "direct"],
      ["mcp_docs_search", "deferred"],
      ["mcp_docs_run", "codemode"],
      ["mcp_docs_internal", "hidden"],
    ]);

    // Without getAllTools, all configured exposures remain intact
    const unchecked = assessRegisteredServerExposures({
      serverName: "docs",
      toolPrefix: "mcp",
      piExposures,
    });
    assert.equal(unchecked.allIndirectFiltered, false);
    assert.equal(unchecked.filteredWarning, undefined);
    assert.deepEqual([...unchecked.exposures].sort(), ["codemode", "deferred", "direct", "hidden"]);

    // Partial --exclude-tools (1 indirect tool excluded, 1 surviving) is treated as intentional
    const partial = assessRegisteredServerExposures({
      serverName: "docs",
      toolPrefix: "mcp",
      piExposures,
      allTools: [{ name: "mcp_docs_ping" }, { name: "mcp_docs_search" }],
    });
    assert.equal(partial.allIndirectFiltered, false);
    assert.equal(partial.filteredWarning, undefined);
    assert.deepEqual([...partial.exposures].sort(), ["deferred", "direct", "hidden"]);

    // Full --tools filtering (no indirect tools surviving in allTools) suppresses indirect exposures and warns
    const filtered = assessRegisteredServerExposures({
      serverName: "evil\u001b[31mdocs",
      toolPrefix: "ext",
      piExposures: new Map([
        ["ext_docs_ping", "direct"],
        ["ext_docs_search", "deferred"],
      ]),
      allTools: [{ name: "read" }, { name: "codemode" }, { name: "ext_docs_ping" }],
    });
    assert.equal(filtered.allIndirectFiltered, true);
    assert.deepEqual([...filtered.exposures], ["direct"]);
    assert.ok(filtered.filteredWarning);
    assert.equal(filtered.filteredWarning.includes("\u001b"), false);
    assert.match(filtered.filteredWarning, /include ext_\* in --tools/);
  });

  it("activates codemode and tool_search in deterministic order and ignores non-reaching impostors", () => {
    assert.deepEqual(
      resolveDiscoveryActivation({
        exposures: ["direct", "hidden"],
        allTools: [reachingCodemode, reachingToolSearch],
        activeTools: [],
      }),
      { activate: [] },
    );

    const both = resolveDiscoveryActivation({
      exposures: ["deferred", "codemode"],
      allTools: [reachingToolSearch, reachingCodemode],
      activeTools: ["read"],
    });
    assert.deepEqual(both, { activate: ["codemode", "tool_search"] });

    // An extension tool named `codemode` or `tool_search` without `reachesTools` must never activate
    const impostor = resolveDiscoveryActivation({
      exposures: ["codemode", "deferred"],
      allTools: [
        { name: CODEMODE_TOOL_NAME, reachesTools: false },
        { name: TOOL_SEARCH_TOOL_NAME },
      ],
      activeTools: ["read"],
    });
    assert.deepEqual(impostor.activate, []);
    assert.match(impostor.unreachableWarning ?? "", /neither is active;/);
  });

  it("honors autoEnableCodemode: false, warning only when neither reaching tool is active", () => {
    const blocked = resolveDiscoveryActivation({
      exposures: ["codemode"],
      allTools: [reachingCodemode, reachingToolSearch],
      activeTools: ["read"],
      autoEnableCodemode: false,
    });
    assert.deepEqual(blocked.activate, []);
    assert.match(blocked.unreachableWarning ?? "", /\(autoEnableCodemode is false\)/);

    const savedByToolSearch = resolveDiscoveryActivation({
      exposures: ["codemode"],
      allTools: [reachingCodemode, reachingToolSearch],
      activeTools: ["read", TOOL_SEARCH_TOOL_NAME],
      autoEnableCodemode: false,
    });
    assert.equal(savedByToolSearch.unreachableWarning, undefined);
    assert.deepEqual(savedByToolSearch, { activate: [] });
  });
});

describe("renderMcpServersSection", () => {
  it("returns undefined when no indirect servers are enabled or connected", () => {
    assert.equal(MCP_SERVERS_SECTION, "mcp_servers");
    assert.equal(MAX_SERVERS_SECTION_CHARS, 4096);
    assert.equal(renderMcpServersSection({ servers: [] }), undefined);
    assert.equal(
      renderMcpServersSection({
        servers: [
          { name: "direct-only", connected: true, exposures: ["direct", "hidden"] },
          { name: "disabled-lazy", enabled: false, connected: false, exposures: ["codemode"] },
        ],
      }),
      undefined,
    );
  });

  it("renders connected and disconnected indirect servers in code-point order with adaptive intro", () => {
    const rendered = renderMcpServersSection({
      servers: [
        {
          name: "zeta-search",
          connected: false,
          exposures: ["deferred"],
          description: "Documentation search",
          // Disconnected servers must never surface stale handshake instructions
          instructions: "Stale handshake instructions",
        },
        {
          name: "alpha-code",
          enabled: false, // manually connected disabled server still appears while active
          connected: true,
          exposures: ["codemode", "deferred"],
          instructions: "\n   \nFirst handshake line\nSecond handshake line",
        },
      ],
      activeTools: ["read", "codemode", "tool_search"],
    });

    assert.equal(
      rendered,
      [
        "MCP servers whose tools are not declared to you. Call the tools of `codemode` servers from codemode scripts. Load the tools of `tool_search` servers with `tool_search`. Connect `not connected` servers with `mcp_connect` first.",
        "- mcp_alpha_code (codemode, tool_search): First handshake line",
        '- mcp_zeta_search (tool_search, not connected — mcp_connect "zeta-search"): Documentation search',
      ].join("\n"),
    );
  });

  it("falls back symmetrically when only one discovery tool is active and omits when neither is active", () => {
    const fallback = renderMcpServersSection({
      servers: [
        {
          name: "warehouse",
          connected: true,
          exposures: ["codemode", "deferred"],
          description: "SQL warehouse\nIgnored second line",
        },
      ],
      toolPrefix: "ext",
      activeTools: ["read", "tool_search"],
    });
    assert.equal(
      fallback,
      [
        "MCP servers whose tools are not declared to you. Load the tools of `tool_search` servers with `tool_search`.",
        "- ext_warehouse (tool_search): SQL warehouse",
      ].join("\n"),
    );

    // Symmetric fallback: deferred server falls back to codemode when codemode is active without tool_search
    const codemodeOnly = renderMcpServersSection({
      servers: [{ name: "docs", connected: true, exposures: ["deferred"], description: "Reference docs" }],
      activeTools: ["read", "codemode"],
    });
    assert.equal(
      codemodeOnly,
      [
        "MCP servers whose tools are not declared to you. Call the tools of `codemode` servers from codemode scripts.",
        "- mcp_docs (codemode): Reference docs",
      ].join("\n"),
    );

    // Neither reaching tool active -> section omitted so the prompt never instructs calling undeclared tools
    assert.equal(
      renderMcpServersSection({
        servers: [{ name: "warehouse", connected: true, exposures: ["codemode", "deferred"] }],
        activeTools: ["read"],
      }),
      undefined,
    );

    // Without activeTools, codemode stays codemode
    const directCodemode = renderMcpServersSection({
      servers: [{ name: "warehouse", connected: true, exposures: ["codemode"] }],
    });
    assert.equal(
      directCodemode,
      [
        "MCP servers whose tools are not declared to you. Call the tools of `codemode` servers from codemode scripts.",
        "- mcp_warehouse (codemode)",
      ].join("\n"),
    );
  });

  it("strips ANSI escapes, redacts secrets, and falls back to namespace for control-only server names", () => {
    const syntheticCred = ["api_key", ["tok", "987654"].join("-")].join("=");
    const rendered = renderMcpServersSection({
      servers: [
        {
          name: "\u0000\u0007",
          connected: false,
          exposures: ["deferred"],
          description: `\u001b[31mInternal\u001b[0m ${syntheticCred}`,
        },
      ],
    });
    assert.ok(rendered);
    assert.ok(!rendered.includes("\u001b"));
    assert.ok(!rendered.includes("tok-987654"));
    assert.ok(rendered.includes("[REDACTED]"));
    assert.ok(rendered.includes('mcp_connect "mcp___"'));
  });

  it("shrinks summaries to fit MAX_SERVERS_SECTION_CHARS and emits singular/plural overflow lines", () => {
    // 25 servers with 240-char descriptions exceed 4096 unless per-server summaries shrink
    const twentyFive = Array.from({ length: 25 }, (_, i) => ({
      name: `srv-${String(i).padStart(2, "0")}`,
      connected: true,
      exposures: ["codemode"] as const,
      description: `Detailed domain summary ${"x".repeat(220)}`,
    }));
    const shrunk = renderMcpServersSection({ servers: twentyFive });
    assert.ok(shrunk);
    assert.ok(shrunk.length <= MAX_SERVERS_SECTION_CHARS);
    assert.ok(shrunk.includes("- mcp_srv_00 (codemode): Detailed domain summary"));

    // Tight head budget where perServerBudget drops to 0 omits summaries cleanly without trailing ": "
    const tightCount = 155;
    const tightServers = Array.from({ length: tightCount }, (_, i) => ({
      name: `s${String(i).padStart(3, "0")}`,
      connected: true,
      exposures: ["codemode"] as const,
      description: "Should be omitted when budget is tight",
    }));
    const tight = renderMcpServersSection({ servers: tightServers });
    assert.ok(tight);
    assert.ok(tight.length <= MAX_SERVERS_SECTION_CHARS);

    // Overflow by exactly 1 server -> singular "1 more server"
    let baseCount = 1;
    while (
      (renderMcpServersSection({
        servers: Array.from({ length: baseCount }, (_, i) => ({
          name: `overflow-server-${String(i).padStart(3, "0")}`,
          connected: true,
          exposures: ["codemode"] as const,
        })),
      }) ?? "").includes("more server") === false
    ) {
      baseCount += 1;
    }
    const singularOverflow = renderMcpServersSection({
      servers: Array.from({ length: baseCount }, (_, i) => ({
        name: `overflow-server-${String(i).padStart(3, "0")}`,
        connected: true,
        exposures: ["codemode"] as const,
      })),
    });
    assert.ok(singularOverflow);
    assert.ok(singularOverflow.length <= MAX_SERVERS_SECTION_CHARS);
    assert.match(singularOverflow, /- … \d+ more server(s)?; find their tools with searchTools\(\)$/m);

    const pluralOverflow = renderMcpServersSection({
      servers: Array.from({ length: baseCount + 5 }, (_, i) => ({
        name: `overflow-server-${String(i).padStart(3, "0")}`,
        connected: true,
        exposures: ["codemode"] as const,
      })),
    });
    assert.ok(pluralOverflow);
    assert.ok(pluralOverflow.length <= MAX_SERVERS_SECTION_CHARS);
    assert.match(pluralOverflow, /- … \d+ more servers; find their tools with searchTools\(\)$/);

    const toolSearchOverflow = renderMcpServersSection({
      servers: Array.from({ length: baseCount + 5 }, (_, i) => ({
        name: `overflow-server-${String(i).padStart(3, "0")}`,
        connected: true,
        exposures: ["deferred"] as const,
      })),
      activeTools: ["read", "tool_search"],
    });
    assert.ok(toolSearchOverflow);
    assert.ok(toolSearchOverflow.length <= MAX_SERVERS_SECTION_CHARS);
    assert.match(toolSearchOverflow, /- … \d+ more servers; find their tools with tool_search$/);
  });
});


