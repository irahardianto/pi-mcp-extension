/**
 * Unit tests for src/config.ts
 * Uses Node.js built-in test runner (node --test).
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  agentDir,
  loadConfig as loadConfigFile,
  parseRegisteredServerConfig,
  stripJsonComments,
} from "../src/config.js";
import { McpError } from "../src/errors.js";

// ── Helpers ─

const loadConfig = (dir: string, options?: { includeProjectConfig?: boolean }) =>
  loadConfigFile(dir, join(dir, "isolated-global-mcp.json"), options);

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = join(tmpdir(), `pi-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeMcpJson(dir: string, content: unknown): Promise<void> {
  const piDir = join(dir, ".pi");
  await mkdir(piDir, { recursive: true });
  await writeFile(join(piDir, "mcp.json"), JSON.stringify(content));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("loadConfig", () => {
  // Every test below points the global config at an EMPTY agent dir, so the developer's real
  // ~/.pi/agent/mcp.json cannot leak into the expectations (it did: two tests failed on any
  // machine that had a global config).
  let prevAgentDir: string | undefined;
  let isolatedAgentDir: string;
  before(async () => {
    isolatedAgentDir = join(tmpdir(), `pi-mcp-test-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(isolatedAgentDir, { recursive: true });
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
  });
  after(async () => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    await rm(isolatedAgentDir, { recursive: true, force: true });
  });

  it("returns empty config when no files exist", async () => {
    await withTempDir(async (dir) => {
      const cfg = await loadConfig(dir);
      assert.deepEqual(cfg.mcpServers, {});
      assert.equal(cfg.settings.toolPrefix, "mcp");
      assert.equal(cfg.settings.requestTimeoutMs, 30000);
      assert.equal(cfg.settings.maxRetries, 5);
    });
  });

  it("loads and validates a valid stdio server config", async () => {
    await withTempDir(async (dir) => {
      await writeMcpJson(dir, {
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            transport: "stdio",
            lifecycle: "eager",
          },
        },
      });
      const cfg = await loadConfig(dir);
      assert.equal(Object.keys(cfg.mcpServers).length, 1);
      const server = cfg.mcpServers["filesystem"];
      assert.ok(server);
      assert.equal(server.command, "npx");
      assert.equal(server.transport, "stdio");
      assert.equal(server.lifecycle, "eager");
    });
  });

  it("loads and validates a streamable-http server config", async () => {
    await withTempDir(async (dir) => {
      await writeMcpJson(dir, {
        mcpServers: {
          supabase: {
            transport: "streamable-http",
            url: "https://mcp.supabase.com/mcp",
            lifecycle: "eager",
          },
        },
      });
      const cfg = await loadConfig(dir);
      const server = cfg.mcpServers["supabase"];
      assert.ok(server);
      assert.equal(server.transport, "streamable-http");
      assert.equal(server.url, "https://mcp.supabase.com/mcp");
    });
  });

  it("loads and validates a legacy sse server config", async () => {
    await withTempDir(async (dir) => {
      await writeMcpJson(dir, {
        mcpServers: {
          legacy: {
            transport: "sse",
            url: "https://legacy-server.example.com/sse",
          },
        },
      });
      const cfg = await loadConfig(dir);
      const server = cfg.mcpServers["legacy"];
      assert.ok(server);
      assert.equal(server.transport, "sse");
    });
  });

  it("throws McpError for stdio server missing command", async () => {
    await withTempDir(async (dir) => {
      await writeMcpJson(dir, {
        mcpServers: {
          bad: {
            transport: "stdio",
            // command is missing
          },
        },
      });
      await assert.rejects(
        () => loadConfig(dir),
        (err: unknown) => {
          assert.ok(err instanceof McpError);
          assert.equal(err.code, "config");
          assert.ok(err.message.includes('"command" is required'));
          return true;
        },
      );
    });
  });

  it("throws McpError for streamable-http server missing url", async () => {
    await withTempDir(async (dir) => {
      await writeMcpJson(dir, {
        mcpServers: {
          bad: {
            command: "should-be-ignored",
            transport: "streamable-http",
            // url is missing
          },
        },
      });
      await assert.rejects(
        () => loadConfig(dir),
        (err: unknown) => {
          assert.ok(err instanceof McpError);
          assert.equal(err.code, "config");
          assert.ok(err.message.includes('"url" is required'));
          return true;
        },
      );
    });
  });

  it("throws McpError for invalid JSON", async () => {
    await withTempDir(async (dir) => {
      const piDir = join(dir, ".pi");
      await mkdir(piDir, { recursive: true });
      await writeFile(join(piDir, "mcp.json"), "{ invalid json");
      await assert.rejects(() => loadConfig(dir));
    });
  });

  it("applies default values for optional fields", async () => {
    await withTempDir(async (dir) => {
      await writeMcpJson(dir, {
        mcpServers: {
          minimal: { command: "my-server" },
        },
      });
      const cfg = await loadConfig(dir);
      const server = cfg.mcpServers["minimal"];
      assert.ok(server);
      assert.deepEqual(server.args, []);
      assert.equal(server.transport, "stdio");
      assert.equal(server.lifecycle, "lazy");
    });
  });

  it("project config overrides global server entries", async () => {
    // This tests the shallow merge: project server completely replaces global
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "isolated-global-mcp.json"), JSON.stringify({
        settings: { requestTimeoutMs: 1000 },
        mcpServers: { myserver: { command: "global-version" }, other: { command: "global-only" } },
      }));
      await writeMcpJson(dir, {
        settings: { requestTimeoutMs: 60000 },
        mcpServers: {
          myserver: {
            command: "project-version",
            args: ["--project-flag"],
          },
        },
      });
      const cfg = await loadConfig(dir);
      assert.equal(cfg.settings.requestTimeoutMs, 60000);
      assert.equal(cfg.mcpServers["other"]?.command, "global-only");
      const server = cfg.mcpServers["myserver"];
      assert.ok(server);
      assert.equal(server.command, "project-version");
    });
  });

  it("rejects invalid toolPrefix", async () => {
    await withTempDir(async (dir) => {
      await writeMcpJson(dir, {
        settings: { toolPrefix: "my-prefix" }, // hyphens not allowed
        mcpServers: {},
      });
      await assert.rejects(
        () => loadConfig(dir),
        (err: unknown) => {
          assert.ok(err instanceof McpError);
          assert.ok(err.message.includes("toolPrefix"));
          return true;
        },
      );
    });
  });

  it("loads server config with static headers", async () => {
    await withTempDir(async (dir) => {
      await writeMcpJson(dir, {
        mcpServers: {
          api: {
            transport: "streamable-http",
            url: "https://api.example.com/mcp",
            headers: {
              "Authorization": "Bearer my-api-key",
              "X-Custom": "value",
            },
          },
        },
      });
      const cfg = await loadConfig(dir);
      const server = cfg.mcpServers["api"]!;
      assert.ok(server);
      assert.equal(server.headers?.["Authorization"], "Bearer my-api-key");
      assert.equal(server.headers?.["X-Custom"], "value");
    });
  });

  it("loads server config with OAuth auth", async () => {
    await withTempDir(async (dir) => {
      await writeMcpJson(dir, {
        mcpServers: {
          deepsource: {
            transport: "streamable-http",
            url: "https://mcp.deepsource.com/mcp",
            auth: {
              type: "oauth",
            },
          },
        },
      });
      const cfg = await loadConfig(dir);
      const server = cfg.mcpServers["deepsource"]!;
      assert.ok(server);
      assert.ok(server.auth);
      assert.equal(server.auth.type, "oauth");
    });
  });

  it("loads server config with OAuth auth and static credentials", async () => {
    await withTempDir(async (dir) => {
      await writeMcpJson(dir, {
        mcpServers: {
          custom: {
            transport: "streamable-http",
            url: "https://custom.example.com/mcp",
            auth: {
              type: "oauth",
              clientId: "my-client-id",
              clientSecret: "my-client-secret",
              redirectUrl: "http://localhost:8080/callback",
              scope: "read write",
            },
          },
        },
      });
      const cfg = await loadConfig(dir);
      const server = cfg.mcpServers["custom"]!;
      assert.ok(server.auth);
      assert.equal(server.auth.clientId, "my-client-id");
      assert.equal(server.auth.clientSecret, "my-client-secret");
      assert.equal(server.auth.redirectUrl, "http://localhost:8080/callback");
      assert.equal(server.auth.scope, "read write");
    });
  });

  it("loads server config with both headers and auth", async () => {
    await withTempDir(async (dir) => {
      await writeMcpJson(dir, {
        mcpServers: {
          dual: {
            transport: "streamable-http",
            url: "https://dual.example.com/mcp",
            headers: { "X-Api-Key": "key123" },
            auth: { type: "oauth" },
          },
        },
      });
      const cfg = await loadConfig(dir);
      const server = cfg.mcpServers["dual"]!;
      assert.ok(server.headers);
      assert.ok(server.auth);
    });
  });
});

// ── Agent dir + project settings merge ───────────────────────────────────────

async function withAgentDir(
  fn: (agent: string, cwd: string) => Promise<void>,
): Promise<void> {
  await withTempDir(async (root) => {
    const agent = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(agent, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    try {
      await fn(agent, cwd);
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });
}

describe("agentDir", () => {
  it("defaults to ~/.pi/agent", () => {
    assert.equal(agentDir({}), join(homedir(), ".pi", "agent"));
  });

  it("follows PI_CODING_AGENT_DIR, with tilde expansion", () => {
    assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/opt/pi-agent" }), "/opt/pi-agent");
    assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~/.pi-other/agent" }), join(homedir(), ".pi-other", "agent"));
  });
});

describe("loadConfig with PI_CODING_AGENT_DIR", () => {
  it("reads the global config from the configured agent dir", async () => {
    await withAgentDir(async (agent, cwd) => {
      await writeFile(
        join(agent, "mcp.json"),
        JSON.stringify({ settings: { toolPrefix: "mcp_" }, mcpServers: { g: { command: "true" } } }),
      );
      const cfg = await loadConfigFile(cwd);
      assert.equal(cfg.settings.toolPrefix, "mcp_");
      assert.deepEqual(Object.keys(cfg.mcpServers), ["g"]);
    });
  });

  it("a project file without settings keeps the global settings", async () => {
    await withAgentDir(async (agent, cwd) => {
      await writeFile(
        join(agent, "mcp.json"),
        JSON.stringify({ settings: { toolPrefix: "mcp_", requestTimeoutMs: 45000 }, mcpServers: { g: { command: "true" } } }),
      );
      await writeMcpJson(cwd, { mcpServers: { p: { command: "true" } } });
      const cfg = await loadConfigFile(cwd);
      assert.equal(cfg.settings.toolPrefix, "mcp_");
      assert.equal(cfg.settings.requestTimeoutMs, 45000);
      assert.equal(cfg.settings.maxRetries, 5);
      assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ["g", "p"]);
    });
  });

  it("a project file that states a setting still overrides the global one", async () => {
    await withAgentDir(async (agent, cwd) => {
      await writeFile(join(agent, "mcp.json"), JSON.stringify({ settings: { toolPrefix: "mcp_" } }));
      await writeMcpJson(cwd, { settings: { requestTimeoutMs: 1000 }, mcpServers: {} });
      const cfg = await loadConfigFile(cwd);
      assert.equal(cfg.settings.toolPrefix, "mcp_");
      assert.equal(cfg.settings.requestTimeoutMs, 1000);
    });
  });

  it("rejects an invalid project setting", async () => {
    await withAgentDir(async (_agent, cwd) => {
      await writeMcpJson(cwd, { settings: { toolPrefix: "bad prefix" } });
      await assert.rejects(loadConfigFile(cwd), McpError);
    });
  });

  it("ignores <cwd>/.pi/mcp.json when includeProjectConfig is false", async () => {
    await withAgentDir(async (agent, cwd) => {
      await writeFile(
        join(agent, "mcp.json"),
        JSON.stringify({
          settings: { toolPrefix: "global_mcp", requestTimeoutMs: 25000 },
          mcpServers: { safe: { command: "safe-cmd" } },
        }),
      );
      // Untrusted project file with malicious server + invalid setting override
      await writeMcpJson(cwd, {
        settings: { toolPrefix: "untrusted_mcp", requestTimeoutMs: 1000 },
        mcpServers: { pwn: { command: "sh", args: ["-c", "evil"], lifecycle: "eager" } },
      });

      const cfg = await loadConfigFile(cwd, undefined, { includeProjectConfig: false });
      assert.equal(cfg.settings.toolPrefix, "global_mcp");
      assert.equal(cfg.settings.requestTimeoutMs, 25000);
      assert.deepEqual(Object.keys(cfg.mcpServers), ["safe"]);
      assert.equal(cfg.mcpServers["pwn"], undefined);
    });
  });

  it("does not read or fail on malformed <cwd>/.pi/mcp.json when includeProjectConfig is false", async () => {
    await withTempDir(async (dir) => {
      const piDir = join(dir, ".pi");
      await mkdir(piDir, { recursive: true });
      await writeFile(join(piDir, "mcp.json"), "{ invalid json from untrusted repo");

      const cfg = await loadConfig(dir, { includeProjectConfig: false });
      assert.deepEqual(cfg.mcpServers, {});
    });
  });
});

describe("Pi 1.x server schema compatibility", () => {
  it("infers streamable-http transport when url is provided without transport or command", async () => {
    await withTempDir(async (dir) => {
      await writeMcpJson(dir, {
        mcpServers: {
          sentry: {
            url: "https://mcp.sentry.dev/mcp",
          },
        },
      });
      const cfg = await loadConfig(dir);
      const server = cfg.mcpServers["sentry"];
      assert.ok(server);
      assert.equal(server.transport, "streamable-http");
      assert.equal(server.url, "https://mcp.sentry.dev/mcp");
      assert.equal(server.lifecycle, "lazy");
    });
  });

  it("accepts type: 'http' and transport: 'http' as aliases for streamable-http", async () => {
    await withTempDir(async (dir) => {
      await writeMcpJson(dir, {
        mcpServers: {
          viaType: {
            type: "http",
            url: "https://example.com/mcp-type",
          },
          viaTransport: {
            transport: "http",
            url: "https://example.com/mcp-transport",
          },
          viaSseType: {
            type: "sse",
            url: "https://example.com/sse",
          },
          viaStdioType: {
            type: "stdio",
            command: "npx",
            args: ["-y", "my-mcp"],
          },
        },
      });
      const cfg = await loadConfig(dir);
      assert.equal(cfg.mcpServers["viaType"]?.transport, "streamable-http");
      assert.equal(cfg.mcpServers["viaTransport"]?.transport, "streamable-http");
      assert.equal(cfg.mcpServers["viaSseType"]?.transport, "sse");
      assert.equal(cfg.mcpServers["viaStdioType"]?.transport, "stdio");
      assert.equal(cfg.mcpServers["viaStdioType"]?.command, "npx");
    });
  });

  it("maps Pi 1.x oauth object and timeout (seconds) to auth and requestTimeoutMs", async () => {
    await withTempDir(async (dir) => {
      await writeMcpJson(dir, {
        mcpServers: {
          withCallbackUrl: {
            url: "https://example.com/mcp",
            timeout: 45,
            oauth: {
              clientId: "cid-1",
              clientSecret: "csec-1",
              callbackUrl: "http://127.0.0.1:8888/callback",
              scope: "read:all",
            },
          },
          withCallbackPort: {
            url: "https://example.com/mcp2",
            oauth: {
              callbackPort: 7777,
            },
          },
        },
      });
      const cfg = await loadConfig(dir);
      const s1 = cfg.mcpServers["withCallbackUrl"]!;
      assert.equal(s1.transport, "streamable-http");
      assert.equal(s1.requestTimeoutMs, 45000);
      assert.deepEqual(s1.auth, {
        type: "oauth",
        clientId: "cid-1",
        clientSecret: "csec-1",
        redirectUrl: "http://127.0.0.1:8888/callback",
        scope: "read:all",
      });

      const s2 = cfg.mcpServers["withCallbackPort"]!;
      assert.deepEqual(s2.auth, {
        type: "oauth",
        redirectUrl: "http://127.0.0.1:7777/callback",
      });
    });
  });

  it("parseRegisteredServerConfig defaults lifecycle to eager unless enabled is false", () => {
    const eagerDefault = parseRegisteredServerConfig("ext-http", {
      url: "https://mcp.sentry.dev/mcp",
    });
    assert.equal(eagerDefault.transport, "streamable-http");
    assert.equal(eagerDefault.lifecycle, "eager");

    const disabledLazy = parseRegisteredServerConfig("ext-disabled", {
      command: "node",
      args: ["server.js"],
      enabled: false,
    });
    assert.equal(disabledLazy.transport, "stdio");
    assert.equal(disabledLazy.lifecycle, "lazy");

    const explicitLazy = parseRegisteredServerConfig("ext-lazy", {
      command: "node",
      lifecycle: "lazy",
    });
    assert.equal(explicitLazy.lifecycle, "lazy");
  });
});

// ── Issue #28: JSONC comments, McpError wrapping, toolPrefix, auth validation ─

describe("stripJsonComments", () => {
  it("strips // line comments and /* */ block comments while preserving newlines", () => {
    const input = [
      "// Leading comment",
      "{",
      '  /* multi-line',
      '     block comment */',
      '  "key": "value" // trailing comment',
      "}",
    ].join("\n");

    const stripped = stripJsonComments(input);
    assert.equal(stripped.split("\n").length, input.split("\n").length);
    assert.deepEqual(JSON.parse(stripped), { key: "value" });
  });

  it("preserves URLs (https://...) and /* */ markers inside JSON string literals", () => {
    const input = `{
      // Server URL with // and /* inside strings
      "url": "https://mcp.supabase.com/mcp",
      "pattern": "/* not a comment */",
      "inline": "value /* still string */ // also string"
    }`;

    const parsed = JSON.parse(stripJsonComments(input));
    assert.deepEqual(parsed, {
      url: "https://mcp.supabase.com/mcp",
      pattern: "/* not a comment */",
      inline: "value /* still string */ // also string",
    });
  });

  it("handles escaped quotes inside strings followed by // and /* */", () => {
    const input = `{
      "escaped": "prefix \\" // not a comment \\" /* also not */ suffix", // real comment
      "backslash": "path\\\\" // comment after escaped backslash at end of string
    }`;

    const parsed = JSON.parse(stripJsonComments(input));
    assert.deepEqual(parsed, {
      escaped: 'prefix " // not a comment " /* also not */ suffix',
      backslash: "path\\",
    });
  });

  it("leaves unterminated /* block comments intact so JSON.parse fails with SyntaxError", () => {
    const input = `{
      "a": 1
      /* unterminated block comment
    }`;

    const stripped = stripJsonComments(input);
    assert.ok(stripped.includes("/* unterminated block comment"));
    assert.throws(() => JSON.parse(stripped), SyntaxError);
  });
});

describe("Issue #28: Config validation and error handling", () => {
  it("loads examples/mcp.json.example directly via loadConfig without error", async () => {
    await withTempDir(async (dir) => {
      const examplePath = join(process.cwd(), "examples", "mcp.json.example");
      const cfg = await loadConfigFile(dir, examplePath);
      assert.equal(cfg.settings.toolPrefix, "mcp");
      assert.equal(cfg.settings.requestTimeoutMs, 30000);
      assert.equal(cfg.settings.maxRetries, 5);
      assert.ok(cfg.mcpServers["supabase"]);
      assert.ok(cfg.mcpServers["filesystem"]);
    });
  });

  it("loads JSONC config containing both // and /* */ comments", async () => {
    await withTempDir(async (dir) => {
      const piDir = join(dir, ".pi");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        join(piDir, "mcp.json"),
        `{
          // Global settings override
          "settings": {
            /* custom prefix */
            "toolPrefix": "custom_mcp"
          },
          "mcpServers": {
            "remote": {
              "url": "https://example.com/mcp" // inline comment after URL
            }
          }
        }`,
      );

      const cfg = await loadConfig(dir);
      assert.equal(cfg.settings.toolPrefix, "custom_mcp");
      assert.equal(cfg.mcpServers["remote"]?.url, "https://example.com/mcp");
    });
  });

  it("wraps malformed JSON syntax errors in McpError with code 'config', file path, and SyntaxError cause", async () => {
    await withTempDir(async (dir) => {
      const piDir = join(dir, ".pi");
      await mkdir(piDir, { recursive: true });
      const filePath = join(piDir, "mcp.json");
      await writeFile(filePath, "{ invalid json");

      await assert.rejects(
        () => loadConfig(dir),
        (err: unknown) => {
          assert.ok(err instanceof McpError);
          assert.equal(err.code, "config");
          assert.equal(err.server, "<config>");
          assert.ok(err.message.includes(filePath), `Expected path ${filePath} in message: ${err.message}`);
          assert.ok(err.cause instanceof SyntaxError);
          return true;
        },
      );
    });
  });

  it("wraps non-ENOENT filesystem read errors in McpError with code 'config', file path, and cause", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, ".pi", "mcp.json");
      // Make mcp.json a directory so readFile fails with EISDIR
      await mkdir(filePath, { recursive: true });

      await assert.rejects(
        () => loadConfig(dir),
        (err: unknown) => {
          assert.ok(err instanceof McpError);
          assert.equal(err.code, "config");
          assert.equal(err.server, "<config>");
          assert.ok(err.message.includes(filePath), `Expected path ${filePath} in message: ${err.message}`);
          assert.ok(err.cause instanceof Error);
          return true;
        },
      );
    });
  });

  it("rejects toolPrefix starting with a digit or underscore and accepts leading letters", async () => {
    await withTempDir(async (dir) => {
      for (const invalidPrefix of ["1mcp_", "_mcp"]) {
        await writeMcpJson(dir, {
          settings: { toolPrefix: invalidPrefix },
        });
        await assert.rejects(
          () => loadConfig(dir),
          (err: unknown) => {
            assert.ok(err instanceof McpError);
            assert.equal(err.code, "config");
            assert.ok(
              err.message.includes("toolPrefix must start with a letter and contain only alphanumeric characters and underscores"),
              `Unexpected error message for ${invalidPrefix}: ${err.message}`,
            );
            return true;
          },
        );

        // Also verify global config SettingsSchema rejects it
        const globalPath = join(dir, "isolated-global-mcp.json");
        await writeFile(globalPath, JSON.stringify({ settings: { toolPrefix: invalidPrefix } }));
        await assert.rejects(
          () => loadConfig(dir, { includeProjectConfig: false }),
          (err: unknown) => {
            assert.ok(err instanceof McpError);
            assert.equal(err.code, "config");
            assert.ok(
              err.message.includes("toolPrefix must start with a letter and contain only alphanumeric characters and underscores"),
            );
            return true;
          },
        );
        await rm(globalPath, { force: true });
      }

      for (const validPrefix of ["a", "mcp_2"]) {
        await writeMcpJson(dir, {
          settings: { toolPrefix: validPrefix },
        });
        const cfg = await loadConfig(dir);
        assert.equal(cfg.settings.toolPrefix, validPrefix);
      }
    });
  });

  it("rejects auth configuration on a stdio server with McpError (code === 'config')", async () => {
    await withTempDir(async (dir) => {
      await writeMcpJson(dir, {
        mcpServers: {
          localStdio: {
            transport: "stdio",
            command: "npx",
            args: ["-y", "some-mcp"],
            auth: { type: "oauth" },
          },
        },
      });

      await assert.rejects(
        () => loadConfig(dir),
        (err: unknown) => {
          assert.ok(err instanceof McpError);
          assert.equal(err.code, "config");
          assert.ok(
            err.message.includes("OAuth authentication is only supported for 'sse' and 'streamable-http' transports, not 'stdio'"),
            `Unexpected error message: ${err.message}`,
          );
          return true;
        },
      );

      // Also verify global config rejects auth/oauth on stdio servers
      const globalPath = join(dir, "isolated-global-mcp.json");
      await writeFile(
        globalPath,
        JSON.stringify({
          mcpServers: {
            globalStdio: {
              command: "npx",
              oauth: { callbackPort: 19876 },
            },
          },
        }),
      );
      await assert.rejects(
        () => loadConfig(dir, { includeProjectConfig: false }),
        (err: unknown) => {
          assert.ok(err instanceof McpError);
          assert.equal(err.code, "config");
          assert.ok(
            err.message.includes("OAuth authentication is only supported for 'sse' and 'streamable-http' transports, not 'stdio'"),
          );
          return true;
        },
      );
      await rm(globalPath, { force: true });
    });
  });

  it("rejects invalid auth.redirectUrl values (including callbackUrl/callbackPort aliases) at config load time with McpError (code === 'config')", async () => {
    const invalidRedirectUrls = [
      "http://example.com:8080/callback", // non-loopback host
      "http://127.0.0.1/callback",        // missing port
      "http://127.0.0.1:8080/cb",         // wrong path /cb
      "",                                 // empty string
      "ftp://127.0.0.1:8080/callback",    // ftp:// scheme
    ];

    await withTempDir(async (dir) => {
      for (const redirectUrl of invalidRedirectUrls) {
        for (const serverDef of [
          {
            transport: "streamable-http",
            url: "https://example.com/mcp",
            auth: { type: "oauth", redirectUrl },
          },
          {
            transport: "streamable-http",
            url: "https://example.com/mcp",
            auth: { type: "oauth", callbackUrl: redirectUrl },
          },
          {
            transport: "streamable-http",
            url: "https://example.com/mcp",
            oauth: { callbackUrl: redirectUrl },
          },
        ]) {
          await writeMcpJson(dir, {
            mcpServers: {
              remote: serverDef,
            },
          });

          await assert.rejects(
            () => loadConfig(dir),
            (err: unknown) => {
              assert.ok(err instanceof McpError, `Expected McpError for redirectUrl="${redirectUrl}"`);
              assert.equal(err.code, "config");
              assert.ok(
                err.message.includes("auth.redirectUrl"),
                `Expected 'auth.redirectUrl' path in error message for "${redirectUrl}", got: ${err.message}`,
              );
              return true;
            },
          );
        }
      }
    });
  });

  it("reports both missing command and invalid auth on stdio server simultaneously", async () => {
    await withTempDir(async (dir) => {
      await writeMcpJson(dir, {
        mcpServers: {
          badStdio: {
            transport: "stdio",
            // missing command
            auth: { type: "oauth" },
          },
        },
      });

      await assert.rejects(
        () => loadConfig(dir),
        (err: unknown) => {
          assert.ok(err instanceof McpError);
          assert.equal(err.code, "config");
          assert.ok(
            err.message.includes('"command" is required for stdio transport'),
            `Expected missing command message, got: ${err.message}`,
          );
          assert.ok(
            err.message.includes("OAuth authentication is only supported for 'sse' and 'streamable-http' transports, not 'stdio'"),
            `Expected invalid auth message, got: ${err.message}`,
          );
          return true;
        },
      );
    });
  });

  it("yields default settings when settings omitted, with independent object identity across loads", async () => {
    await withTempDir(async (dir) => {
      await writeMcpJson(dir, {
        mcpServers: {
          serverA: {
            command: "echo",
            transport: "stdio",
          },
        },
      });

      const cfg1 = await loadConfig(dir);
      const cfg2 = await loadConfig(dir);

      assert.equal(cfg1.settings.toolPrefix, "mcp");
      assert.equal(cfg1.settings.requestTimeoutMs, 30000);
      assert.equal(cfg1.settings.maxRetries, 5);

      assert.notEqual(cfg1.settings, cfg2.settings);

      (cfg1.settings as { toolPrefix: string }).toolPrefix = "mutated";
      assert.equal(cfg2.settings.toolPrefix, "mcp");
    });
  });

  it("rejects non-string values in env and headers with McpError (code === 'config')", async () => {
    await withTempDir(async (dir) => {
      // Non-string env value
      await writeMcpJson(dir, {
        mcpServers: {
          badEnv: {
            command: "echo",
            env: { FOO: 123 },
          },
        },
      });
      await assert.rejects(
        () => loadConfig(dir),
        (err: unknown) => {
          assert.ok(err instanceof McpError);
          assert.equal(err.code, "config");
          assert.ok(
            err.message.includes("env.FOO"),
            `Expected env.FOO issue in error message, got: ${err.message}`,
          );
          return true;
        },
      );

      // Non-string headers value
      await writeMcpJson(dir, {
        mcpServers: {
          badHeaders: {
            transport: "streamable-http",
            url: "https://example.com/mcp",
            headers: { Authorization: 123 },
          },
        },
      });
      await assert.rejects(
        () => loadConfig(dir),
        (err: unknown) => {
          assert.ok(err instanceof McpError);
          assert.equal(err.code, "config");
          assert.ok(
            err.message.includes("headers.Authorization"),
            `Expected headers.Authorization issue in error message, got: ${err.message}`,
          );
          return true;
        },
      );
    });
  });
});


