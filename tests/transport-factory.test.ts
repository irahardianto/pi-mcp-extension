/**
 * Unit tests for the pure stdio `cwd` resolution in src/transport-factory.ts
 * (Pi 1.3.0 `McpStdioServerConfig.cwd`: relative paths resolve against the session working
 * directory, a leading `~` expands to the home directory).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveStdioCwd } from "../src/transport-factory.js";

describe("resolveStdioCwd", () => {
  it("keeps the session cwd when the server config has no cwd", () => {
    assert.equal(resolveStdioCwd(undefined, "/work/session"), "/work/session");
    assert.equal(resolveStdioCwd(undefined, undefined), undefined);
  });

  it("resolves a relative cwd against the session cwd", () => {
    assert.equal(resolveStdioCwd("./sub", "/work/session"), resolve("/work/session", "./sub"));
    assert.equal(resolveStdioCwd("../shared", "/work/session"), resolve("/work/session", "../shared"));
  });

  it("keeps an absolute cwd as given", () => {
    assert.equal(resolveStdioCwd("/opt/server", "/work/session"), resolve("/opt/server"));
  });

  it("expands a leading ~ to the home directory", () => {
    assert.equal(resolveStdioCwd("~", "/work/session"), homedir());
    assert.equal(resolveStdioCwd("~/mcp/state", "/work/session"), join(homedir(), "mcp/state"));
  });

  it("falls back to the process cwd when the session cwd is unknown", () => {
    assert.equal(resolveStdioCwd("./sub", undefined), resolve(process.cwd(), "./sub"));
  });
});
