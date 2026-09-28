import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/index.js";
import { McpOAuthProvider, getAuthStatus } from "../src/oauth-provider.js";

it("coordinates OAuth commands for a server name with spaces, including repeated reset and stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-auth-command-"));
  let base = "";
  const listener = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
      res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }));
    } else if (req.url === "/.well-known/oauth-authorization-server") {
      res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] }));
    } else { res.writeHead(401, { "WWW-Authenticate": "Bearer" }); res.end(); }
  });
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const callbackAddress = probe.address();
  assert.ok(callbackAddress && typeof callbackAddress === "object");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const messages: string[] = [];
  let opens = 0;
  let choices = 0;
  const ctx: any = {
    cwd: dir, hasUI: true,
    ui: {
      notify: (message: string) => messages.push(message),
      select: async (_title: string, options: string[]) => options[choices++ === 0 ? 0 : 1],
    },
  };
  const waitForOpen = async (expected: number) => {
    for (let i = 0; i < 100 && opens < expected; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(opens, expected);
  };
  const assertStopped = async () => {
    await commands.get("mcp").handler("team server", ctx);
    assert.match(messages.at(-1)!, /State:  stopped/);
  };
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi", "mcp.json"), JSON.stringify({
      settings: { maxRetries: 0 },
      mcpServers: {
        "team server": { lifecycle: "lazy", transport: "streamable-http", url: `${base}/mcp`, auth: { type: "oauth", clientId: "test-client", redirectUrl: `http://127.0.0.1:${callbackAddress.port}/callback` } },
      },
    }));
    await extension({
      registerTool: () => {},
      registerCommand: (name: string, command: any) => commands.set(name, command),
      on: (name: string, handler: any) => events.set(name, handler),
      getActiveTools: () => [], setActiveTools: () => {},
    } as any, { bootstrapCwd: dir, globalConfigPath: join(dir, "missing.json"), authStorageDir: join(dir, "auth"), browserOpen: () => { opens++; } });
    await events.get("session_start")({}, ctx);
    await commands.get("mcp:auth").handler("  team server  ", ctx);
    assert.equal(opens, 2, "One initial browser launch and one explicit Retry");
    assert.equal(choices, 2);
    assert.ok(messages.some((message) => /Authentication cancelled for team server/.test(message)));
    await assertStopped();

    const provider = new McpOAuthProvider("team server", { clientId: "test-client" }, undefined, join(dir, "auth"));
    await provider.saveTokens({ access_token: "test-token", token_type: "Bearer" });
    ctx.ui.select = () => new Promise(() => {});
    const firstReset = commands.get("mcp:auth").handler("team server --reset", ctx);
    await waitForOpen(3);
    const repeatedReset = commands.get("mcp:auth").handler("team server --reset", ctx);
    const joinedStart = commands.get("mcp:start").handler("team server", ctx);
    await commands.get("mcp:stop").handler("team server", ctx);
    await Promise.all([firstReset, repeatedReset, joinedStart]);
    assert.equal(opens, 3, "Repeated reset must not open a second authorization");
    assert.equal((await getAuthStatus("team server", join(dir, "auth")))?.hasTokens, false);
    await assertStopped();

    const shutdownReset = commands.get("mcp:auth").handler("team server --reset", ctx);
    await waitForOpen(4);
    const shutdownStart = commands.get("mcp:start").handler("team server", ctx);
    await events.get("session_shutdown")({}, ctx);
    await Promise.all([shutdownReset, shutdownStart]);
    assert.equal(opens, 4);
    await assertStopped();
  } finally {
    await events.get("session_shutdown")?.({}, ctx);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
