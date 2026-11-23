import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/index.js";
import { hasNoMcpFlag } from "../src/commands.js";
import { createMockExtension } from "./helpers/mock-extension.js";

const cases: Array<{ name: string; argv: string[]; disabled: boolean }> = [
  { name: "standalone flag", argv: ["--no-mcp"], disabled: true },
  { name: "flag after positional prompt", argv: ["-p", "hello", "--no-mcp"], disabled: true },
  { name: "flag after plain positional argument", argv: ["hello", "--no-mcp"], disabled: true },
  { name: "flag immediately after print mode", argv: ["-p", "--no-mcp"], disabled: true },
  { name: "flag in RPC mode", argv: ["--mode", "rpc", "--no-mcp"], disabled: true },
  { name: "flag after another value-taking flag", argv: ["--name", "session", "--no-mcp"], disabled: true },
  { name: "flag after separator", argv: ["-p", "--", "--no-mcp"], disabled: false },
  { name: "flag used as system-prompt value", argv: ["--system-prompt", "--no-mcp", "hello"], disabled: false },
  { name: "flag used as name value", argv: ["--name", "--no-mcp", "hello"], disabled: false },
  { name: "flag used as short name value", argv: ["-n", "--no-mcp", "hello"], disabled: false },
  { name: "flag used as extension value", argv: ["-e", "--no-mcp"], disabled: false },
  { name: "flag used as tools value", argv: ["--tools", "--no-mcp"], disabled: false },
  { name: "no marker", argv: ["-p", "hello"], disabled: false },
];

describe("hasNoMcpFlag", () => {
  for (const { name, argv, disabled } of cases) {
    it(name, () => {
      assert.equal(hasNoMcpFlag(argv), disabled);
    });
  }
});

describe("--no-mcp extension initialization", () => {
  for (const argv of [["--no-mcp"], ["-p", "hello", "--no-mcp"], ["--mode", "rpc", "--no-mcp"]]) {
    it(`registers no event handlers, commands, or tools for ${argv.join(" ")}`, async () => {
      const mock = createMockExtension();
      // WHY: Supplying argv explicitly keeps the test independent of the test runner's own CLI.
      await extension(mock.api, { argv });
      assert.equal(mock.events.size, 0);
      assert.equal(mock.commands.size, 0);
      assert.equal(mock.tools.size, 0);
      assert.deepEqual(mock.activeTools, []);
    });
  }

  it("initializes normally when --no-mcp follows the -- separator", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-argv-"));
    const configPath = join(dir, "mcp.json");
    const mock = createMockExtension();
    try {
      await writeFile(configPath, JSON.stringify({ mcpServers: {} }));
      await extension(mock.api, {
        argv: ["-p", "--", "--no-mcp"],
        bootstrapCwd: dir,
        globalConfigPath: configPath,
      });
      assert.ok(mock.events.has("session_start"));
      assert.ok(mock.events.has("mcp_servers_change"));
      assert.ok(mock.commands.has("mcp"));
      assert.ok(mock.tools.has("mcp_status"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
