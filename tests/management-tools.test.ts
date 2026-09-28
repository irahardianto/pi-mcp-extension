import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import extension from "../src/index.js";
import { acquireAuthLock, getAuthStatus, McpOAuthProvider } from "../src/oauth-provider.js";

it("registers agent-visible status and connect tools without eagerly starting a lazy server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-management-"));
  const mock = join(dirname(fileURLToPath(import.meta.url)), "mock-server.ts");
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const commands = new Map<string, any>();
  let active: string[] = [];
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: any) => events.set(name, handler),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
  };
  const ctx = { cwd: dir, hasUI: false, ui: { notify: () => {}, select: async () => undefined } } as any;
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi", "mcp.json"), JSON.stringify({
      settings: { maxRetries: 0 },
      mcpServers: { lazy: { command: "node", args: ["--import", "tsx/esm", mock], lifecycle: "lazy" } },
    }));
    await extension(pi as any, { bootstrapCwd: dir, globalConfigPath: join(dir, "absent-global.json") });
    assert.ok(tools.has("mcp_status"));
    assert.ok(tools.has("mcp_connect"));
    await events.get("session_start")({}, ctx);
    assert.equal(active.length, 0);
    const status = await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx);
    assert.deepEqual(JSON.parse(status.content[0].text).map((row: any) => [row.name, row.lifecycle, row.state]), [["lazy", "lazy", "stopped"]]);
    await assert.rejects(tools.get("mcp_connect").execute("", { name: "unknown" }, undefined, undefined, ctx), /Unknown MCP server name/);
    const result = await tools.get("mcp_connect").execute("", { name: "lazy" }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /ready/);
    assert.ok(active.some((name) => name.includes("echo")));
    assert.ok(commands.has("mcp:start") && commands.has("mcp:stop") && commands.has("mcp:auth"));
    const discovered = active.length;
    const connectedStatus = JSON.parse((await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text);
    assert.deepEqual(connectedStatus[0].tools, { discovered, active: discovered });
    // Another extension may apply an intentional tool restriction after discovery.
    active = active.slice(1);
    await assert.rejects(
      tools.get("mcp_connect").execute("", { name: "lazy" }, undefined, undefined, ctx),
      /connected, but some discovered tools are inactive/,
    );
    assert.equal(active.length, discovered - 1, "Connect must not override another extension's restriction");
    active = [];
    await assert.rejects(
      tools.get("mcp_connect").execute("", { name: "lazy" }, undefined, undefined, ctx),
      /connected, but some discovered tools are inactive/,
    );
    assert.deepEqual(active, []);
    const inactiveStatus = JSON.parse((await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text);
    assert.equal(inactiveStatus[0].state, "ready", "Transport readiness and tool activation are separate states");
    assert.deepEqual(inactiveStatus[0].tools, { discovered, active: 0 });
    await events.get("session_shutdown")({}, ctx);
    assert.equal(active.length, 0);
  } finally {
    await events.get("session_shutdown")?.({}, ctx);
    await rm(dir, { recursive: true, force: true });
  }
});

it("reports headless OAuth as an actionable failure without opening a browser or exposing secrets", async () => {
  const { createServer } = await import("node:http");
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-headless-"));
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: () => {}, on: (name: string, handler: any) => events.set(name, handler),
    getActiveTools: () => [], setActiveTools: () => {},
  };
  let base = "";
  let requests = 0;
  const listener = createServer((req, res) => {
    if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }));
    } else if (req.url === "/.well-known/oauth-authorization-server") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] }));
    } else {
      requests++;
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }); res.end("auth required");
    }
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  const ctx = { cwd: dir, hasUI: false, ui: { notify: () => {}, select: () => assert.fail("No UI") } } as any;
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi", "mcp.json"), JSON.stringify({
      settings: { maxRetries: 2 },
      mcpServers: { private: { transport: "streamable-http", url: `${base}/mcp`, auth: { type: "oauth", clientId: "local" }, headers: { Authorization: "Bearer secret-never-report" }, lifecycle: "lazy" } },
    }));
    await extension(pi as any, { bootstrapCwd: dir, globalConfigPath: join(dir, "no-global.json"), authStorageDir: join(dir, "auth") });
    await events.get("session_start")({}, ctx);
    await assert.rejects(tools.get("mcp_connect").execute("", { name: "private" }, undefined, undefined, ctx), /requires an interactive Pi session/);
    assert.equal(requests, 1);
    const status = await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx);
    assert.match(status.content[0].text, /Authorization required/);
    assert.doesNotMatch(status.content[0].text, /secret-never-report|authorize\?|access_token/);
  } finally {
    await events.get("session_shutdown")?.({}, ctx);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("cancels a management connect during retry delay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-cancel-connect-"));
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: () => {}, on: (name: string, handler: any) => events.set(name, handler),
    getActiveTools: () => [], setActiveTools: () => {},
  };
  const ctx = { cwd: dir, hasUI: false, ui: { notify: () => {} } } as any;
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi", "mcp.json"), JSON.stringify({ settings: { maxRetries: 1 }, mcpServers: { broken: { command: "missing-pi-mcp-executable" } } }));
    await extension(pi as any, { bootstrapCwd: dir, globalConfigPath: join(dir, "no-global.json") });
    await events.get("session_start")({}, ctx);
    const controller = new AbortController();
    const attempt = tools.get("mcp_connect").execute("", { name: "broken" }, controller.signal, undefined, ctx);
    const failure = assert.rejects(attempt, /cancelled/);
    for (let i = 0; i < 100; i++) {
      const status = JSON.parse((await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text);
      if (status[0].state === "starting") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await failure;
    const status = JSON.parse((await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text);
    assert.equal(status[0].state, "stopped");
  } finally {
    await events.get("session_shutdown")?.({}, ctx);
    await rm(dir, { recursive: true, force: true });
  }
});

it("opens an interactive browser only once, reopens on Retry, and cancels without connecting", async () => {
  const { createServer } = await import("node:http");
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-interactive-"));
  let base = "";
  const listener = createServer((req, res) => {
    if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }));
    } else if (req.url === "/.well-known/oauth-authorization-server") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] }));
    } else { res.writeHead(401, { "WWW-Authenticate": "Bearer" }); res.end(); }
  });
  const callbackPort = createServer();
  await new Promise<void>((resolve) => callbackPort.listen(0, "127.0.0.1", resolve));
  const callbackAddress = callbackPort.address();
  assert.ok(callbackAddress && typeof callbackAddress === "object");
  await new Promise<void>((resolve) => callbackPort.close(() => resolve()));
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  let opens = 0;
  let choices = 0;
  const commands = new Map<string, any>();
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command), on: (name: string, handler: any) => events.set(name, handler),
    getActiveTools: () => [], setActiveTools: () => {},
  };
  const ctx = {
    cwd: dir, hasUI: true,
    ui: { notify: () => {}, select: async (_title: string, options: string[]) => options[choices++ === 0 ? 0 : 1] },
  } as any;
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi", "mcp.json"), JSON.stringify({
      settings: { maxRetries: 2 }, mcpServers: {
        "local team": { lifecycle: "lazy", transport: "streamable-http", url: `${base}/mcp`, auth: { type: "oauth", clientId: "local-client", redirectUrl: `http://127.0.0.1:${callbackAddress.port}/callback` } },
      },
    }));
    await extension(pi as any, {
      bootstrapCwd: dir, globalConfigPath: join(dir, "no-global.json"), authStorageDir: join(dir, "auth"),
      browserOpen: () => { opens++; },
    });
    await events.get("session_start")({}, ctx);
    const first = tools.get("mcp_connect").execute("", { name: "local team" }, undefined, undefined, ctx);
    const second = tools.get("mcp_connect").execute("", { name: "local team" }, undefined, undefined, ctx);
    await Promise.all([assert.rejects(first, /MCP connection cancelled/), assert.rejects(second, /MCP connection cancelled/)]);
    assert.equal(opens, 2);
    assert.equal(choices, 2);
    const status = JSON.parse((await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text);
    assert.equal(status[0].state, "stopped");
    const storage = join(dir, "auth");
    const unlock = await acquireAuthLock("local team", storage);
    try {
      await assert.rejects(
        tools.get("mcp_connect").execute("", { name: "local team" }, undefined, undefined, ctx),
        /Another Pi process is authorizing this server/,
      );
      assert.equal(opens, 2);
    } finally { await unlock(); }
    const provider = new McpOAuthProvider("local team", { clientId: "local-client" }, undefined, storage);
    await provider.saveTokens({ access_token: "saved-token", token_type: "Bearer" });
    assert.equal((await getAuthStatus("local team", storage))?.hasTokens, true);
    ctx.ui.select = () => new Promise(() => {});
    const firstReset = commands.get("mcp:auth").handler("local team --reset", ctx);
    for (let i = 0; i < 100 && opens < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(opens, 3);
    const repeatedReset = commands.get("mcp:auth").handler("local team --reset", ctx);
    const joinedConnect = tools.get("mcp_connect").execute("", { name: "local team" }, undefined, undefined, ctx);
    const stoppedConnect = assert.rejects(joinedConnect, /MCP connection cancelled/);
    await commands.get("mcp:stop").handler("local team", ctx);
    await Promise.all([firstReset, repeatedReset, stoppedConnect]);
    assert.equal(opens, 3, "A repeated reset must join the first browser flow");
    assert.equal((await getAuthStatus("local team", storage))?.hasTokens, false);
    const afterStop = JSON.parse((await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text);
    assert.equal(afterStop[0].state, "stopped");

    const shutdownReset = commands.get("mcp:auth").handler("local team --reset", ctx);
    for (let i = 0; i < 100 && opens < 4; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(opens, 4);
    const shutdownConnect = tools.get("mcp_connect").execute("", { name: "local team" }, undefined, undefined, ctx);
    const cancelledConnect = assert.rejects(shutdownConnect, /MCP connection cancelled/);
    await events.get("session_shutdown")({}, ctx);
    await Promise.all([shutdownReset, cancelledConnect]);
    const afterShutdown = JSON.parse((await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text);
    assert.equal(afterShutdown[0].state, "stopped");
    assert.equal(opens, 4);
  } finally {
    await events.get("session_shutdown")?.({}, ctx);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not expose an echoed Authorization header through connect errors or status", async () => {
  const { createServer } = await import("node:http");
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-error-redaction-"));
  const credential = "Bearer mock-secret-never-disclose";
  let echoed = 0;
  const listener = createServer((req, res) => {
    assert.equal(req.headers.authorization, credential);
    echoed++;
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`Failed for Authorization: ${credential}; url: https://local.invalid/authorize?token=${credential}`);
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: () => {}, on: (name: string, handler: any) => events.set(name, handler),
    getActiveTools: () => [], setActiveTools: () => {},
  };
  const ctx = { cwd: dir, hasUI: false, ui: { notify: () => {} } } as any;
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi", "mcp.json"), JSON.stringify({
      settings: { maxRetries: 0 },
      mcpServers: { local: { transport: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: credential }, lifecycle: "lazy" } },
    }));
    await extension(pi as any, { bootstrapCwd: dir, globalConfigPath: join(dir, "no-global.json") });
    await events.get("session_start")({}, ctx);
    await assert.rejects(
      tools.get("mcp_connect").execute("", { name: "local" }, undefined, undefined, ctx),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /MCP connection failed/);
        assert.doesNotMatch(String(err.stack), /mock-secret-never-disclose|authorize\?token=|Authorization:/);
        return true;
      },
    );
    assert.equal(echoed, 1);
    const status = await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx);
    assert.doesNotMatch(status.content[0].text, /mock-secret-never-disclose|authorize\?token=|Authorization:/);
  } finally {
    await events.get("session_shutdown")?.({}, ctx);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
