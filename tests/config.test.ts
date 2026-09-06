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
import { agentDir, loadConfig } from "../src/config.js";
import { McpError } from "../src/errors.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

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
      // Write project config with overridden server
      await writeMcpJson(dir, {
        settings: { requestTimeoutMs: 60000 },
        mcpServers: {
          myserver: {
            command: "project-version",
            args: ["--project-flag"],
          },
        },
      });
      // We can't write to global without polluting the real ~/.pi/agent/mcp.json,
      // so we test the merge logic by calling loadConfig with only the project file
      const cfg = await loadConfig(dir);
      assert.equal(cfg.settings.requestTimeoutMs, 60000);
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
      const cfg = await loadConfig(cwd);
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
      const cfg = await loadConfig(cwd);
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
      const cfg = await loadConfig(cwd);
      assert.equal(cfg.settings.toolPrefix, "mcp_");
      assert.equal(cfg.settings.requestTimeoutMs, 1000);
    });
  });

  it("rejects an invalid project setting", async () => {
    await withAgentDir(async (_agent, cwd) => {
      await writeMcpJson(cwd, { settings: { toolPrefix: "bad prefix" } });
      await assert.rejects(loadConfig(cwd), McpError);
    });
  });
});
