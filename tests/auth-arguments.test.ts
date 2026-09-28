import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAuthArguments } from "../src/index.js";

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
});
