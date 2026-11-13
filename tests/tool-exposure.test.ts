/**
 * Unit tests for src/tool-exposure.ts — Pi 1.3.0 `exposure` / `toolExposure` resolution.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EXPOSURE,
  MCP_EXPOSURES,
  normalizeExposureAlias,
  resolveToolExposure,
} from "../src/tool-exposure.js";

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

describe("normalizeExposureAlias", () => {
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
});
