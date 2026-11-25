import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import fc from "fast-check";
import extension from "../src/index.js";
import { hasNoMcpFlag } from "../src/commands.js";
import { getDebugLog, setDebugLog } from "../src/debug-log.js";
import { createMockExtension } from "./helpers/mock-extension.js";

const VALUE_TAKING_FLAGS = [
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--name",
  "-n",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "--models",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--thinking",
  "--export",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
] as const;

const PI_CLI_TOKENS = [
  "--no-mcp",
  "--",
  "-",
  "---",
  "---prompt",
  "--help",
  "-h",
  "--version",
  "-v",
  "--mode",
  "rpc",
  "json",
  "text",
  "--continue",
  "-c",
  "--resume",
  "-r",
  ...VALUE_TAKING_FLAGS,
  "--no-session",
  "--no-tools",
  "-nt",
  "--no-builtin-tools",
  "-nbt",
  "--print",
  "-p",
  "--no-extensions",
  "-ne",
  "--use-theme",
  "--no-skills",
  "-ns",
  "--no-prompt-templates",
  "-np",
  "--no-themes",
  "--no-context-files",
  "-nc",
  "--list-models",
  "--tui-mode",
  "regular",
  "fullscreen",
  "--verbose",
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--offline",
  "@file.md",
  "hello",
  "--unknown",
  "--unknown=val",
  "--no-mcp=true",
  "--system-prompt=--no-mcp",
  "-x",
] as const;

const cases: Array<{ name: string; argv: string[]; disabled: boolean }> = [
  { name: "standalone flag", argv: ["--no-mcp"], disabled: true },
  { name: "flag after positional prompt", argv: ["-p", "hello", "--no-mcp"], disabled: true },
  { name: "flag after plain positional argument", argv: ["hello", "--no-mcp"], disabled: true },
  { name: "flag immediately after print mode", argv: ["-p", "--no-mcp"], disabled: true },
  { name: "flag after print mode triple-dash prompt", argv: ["-p", "---", "--no-mcp"], disabled: true },
  { name: "flag in RPC mode", argv: ["--mode", "rpc", "--no-mcp"], disabled: true },
  { name: "flag after another value-taking flag", argv: ["--name", "session", "--no-mcp"], disabled: true },
  { name: "flag after value-taking flag consuming --", argv: ["--system-prompt", "--", "--no-mcp"], disabled: true },
  { name: "flag immediately after conditional --mode", argv: ["--mode", "--no-mcp"], disabled: true },
  { name: "flag immediately after conditional --use-theme", argv: ["--use-theme", "--no-mcp"], disabled: true },
  { name: "flag immediately after conditional --tui-mode", argv: ["--tui-mode", "--no-mcp"], disabled: true },
  { name: "flag immediately after conditional --list-models", argv: ["--list-models", "--no-mcp"], disabled: true },
  { name: "flag immediately after unknown long flag", argv: ["--custom-flag", "--no-mcp"], disabled: true },
  { name: "flag after separator", argv: ["-p", "--", "--no-mcp"], disabled: false },
  { name: "flag with equals syntax is not --no-mcp", argv: ["--no-mcp=true"], disabled: false },
  { name: "equals-joined value containing --no-mcp", argv: ["--system-prompt=--no-mcp"], disabled: false },
  { name: "trailing value-taking flag with no value", argv: ["--name"], disabled: false },
  { name: "trailing short value-taking flag with no value", argv: ["-e"], disabled: false },
  ...VALUE_TAKING_FLAGS.map((flag) => ({
    name: `flag consumed as ${flag} value`,
    argv: [flag, "--no-mcp", "hello"],
    disabled: false,
  })),
  { name: "no marker", argv: ["-p", "hello"], disabled: false },
];

describe("hasNoMcpFlag", () => {
  for (const { name, argv, disabled } of cases) {
    it(name, () => {
      assert.equal(hasNoMcpFlag(argv), disabled);
      assert.equal(hasNoMcpFlag(argv), Boolean(parseArgs([...argv]).noMcp));
    });
  }

  it("matches Pi's parseArgs().noMcp across randomized CLI token sequences", () => {
    // WHY: Drift guard against future Pi upgrades adding or changing CLI flags.
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...PI_CLI_TOKENS), { maxLength: 12 }), (argv) => {
        assert.equal(hasNoMcpFlag(argv), Boolean(parseArgs([...argv]).noMcp));
      }),
      { numRuns: 1000, seed: 339_130 },
    );
  });
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

  it("exits before initializing DebugLog or reading mcp.json when --no-mcp is active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-nomcp-"));
    const configPath = join(dir, "mcp.json");
    const mock = createMockExtension();
    const previousDebug = process.env.PI_MCP_DEBUG;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousStderr = console.error;
    const stderrLines: string[] = [];

    try {
      // Malformed config that would emit a diagnostic if loadBootstrapConfigState ran.
      await writeFile(configPath, "{ invalid json");
      setDebugLog(null);
      process.env.PI_MCP_DEBUG = "1";
      process.env.PI_CODING_AGENT_DIR = dir;
      console.error = (...args: unknown[]) => {
        stderrLines.push(args.map(String).join(" "));
      };

      await extension(mock.api, {
        argv: ["--no-mcp"],
        bootstrapCwd: dir,
        globalConfigPath: configPath,
      });

      assert.equal(getDebugLog(), null);
      assert.deepEqual(stderrLines, []);
      assert.equal(mock.events.size, 0);
      assert.equal(mock.commands.size, 0);
      assert.equal(mock.tools.size, 0);
      await assert.rejects(access(join(dir, "logs")), { code: "ENOENT" });
    } finally {
      console.error = previousStderr;
      setDebugLog(null);
      if (previousDebug === undefined) delete process.env.PI_MCP_DEBUG;
      else process.env.PI_MCP_DEBUG = previousDebug;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(dir, { recursive: true, force: true });
    }
  });

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
