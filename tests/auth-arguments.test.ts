import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAuthArguments, parseResourceArguments } from "../src/commands.js";

describe("parseAuthArguments", () => {
  const names = ["local", "team server", "team  server", "release --reset"];

  it("preserves server names containing spaces", () => {
    assert.deepEqual(parseAuthArguments("  team server  ", names), { name: "team server", reset: false });
    assert.deepEqual(parseAuthArguments("team  server", names), { name: "team  server", reset: false });
  });

  it("recognizes a trailing reset option without splitting the server name", () => {
    assert.deepEqual(parseAuthArguments("team server --reset", names), { name: "team server", reset: true });
    assert.deepEqual(parseAuthArguments("  team  server\t--reset  ", names), { name: "team  server", reset: true });
    assert.deepEqual(parseAuthArguments("local --reset", names), { name: "local", reset: true });
  });

  it("prefers an exact configured name to prevent unintended credential reset", () => {
    assert.deepEqual(parseAuthArguments("release --reset", names), { name: "release --reset", reset: false });
    assert.deepEqual(parseAuthArguments("release --reset --reset", names), { name: "release --reset", reset: true });
  });

  it("does not silently discard unknown arguments", () => {
    assert.deepEqual(parseAuthArguments("team server --reset extra", names), { name: "team server --reset extra", reset: false });
    assert.deepEqual(parseAuthArguments("team server --unknown", names), { name: "team server --unknown", reset: false });
    assert.deepEqual(parseAuthArguments(" ", names), { name: "", reset: false });
  });

  it("should parse standalone --reset and leading --reset <name> arguments (Issue 24.4)", () => {
    assert.deepEqual(parseAuthArguments("--reset", names), { name: "", reset: true });
    assert.deepEqual(parseAuthArguments("  --reset  ", names), { name: "", reset: true });
    assert.deepEqual(parseAuthArguments("--reset local", names), { name: "local", reset: true });
    assert.deepEqual(parseAuthArguments("--reset team server", names), { name: "team server", reset: true });
    assert.deepEqual(parseAuthArguments("  --reset\tteam  server  ", names), { name: "team  server", reset: true });
  });
});

describe("parseResourceArguments", () => {
  const names = ["local", "team", "team server", "team  server"];

  it("returns empty server and uri for blank input", () => {
    assert.deepEqual(parseResourceArguments("", names), { server: "", uri: "" });
    assert.deepEqual(parseResourceArguments("   ", names), { server: "", uri: "" });
  });

  it("preserves configured server names containing spaces with or without a URI", () => {
    assert.deepEqual(parseResourceArguments("  team server  ", names), { server: "team server", uri: "" });
    assert.deepEqual(parseResourceArguments("team  server", names), { server: "team  server", uri: "" });
    assert.deepEqual(parseResourceArguments("team server mock://docs/readme", names), {
      server: "team server",
      uri: "mock://docs/readme",
    });
    assert.deepEqual(parseResourceArguments("team server file:///path/with space", names), {
      server: "team server",
      uri: "file:///path/with space",
    });
  });

  it("splits unknown server names at the first whitespace while keeping spaces inside the URI", () => {
    assert.deepEqual(parseResourceArguments("local mock://docs/readme", names), {
      server: "local",
      uri: "mock://docs/readme",
    });
    assert.deepEqual(parseResourceArguments("unknown file:///a b/c"), {
      server: "unknown",
      uri: "file:///a b/c",
    });
  });
});

