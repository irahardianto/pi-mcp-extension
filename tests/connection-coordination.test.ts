import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ServerManager } from "../src/server-manager.js";
import { ToolBridge } from "../src/tool-bridge.js";
import { AuthRequiredError, McpOAuthProvider, acquireAuthLock, getAuthStatus, resetAuth } from "../src/oauth-provider.js";
import type { McpConfig } from "../src/config.js";

const mockServer = join(dirname(fileURLToPath(import.meta.url)), "mock-server.ts");
function config(command = "node", maxRetries = 0): McpConfig {
  return {
    settings: { toolPrefix: "mcp", requestTimeoutMs: 3000, maxRetries },
    mcpServers: { lazy: { lifecycle: "lazy", transport: "stdio", command, args: ["--import", "tsx/esm", mockServer] } },
  };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

 describe("coordinated connections", () => {
  it("shares readiness including discovery and activates a lazy server only when requested", async () => {
    const tools: any[] = [];
    let active: string[] = [];
    const pi = { registerTool: (tool: any) => tools.push(tool), getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; } };
    const manager = new ServerManager(config());
    const bridge = new ToolBridge(config().settings, pi);
    const discovery = gate();
    manager.setToolRefreshCallback(async (name, client) => {
      await discovery.promise;
      await bridge.refreshTools(name, client, () => manager.getServer(name)?.state !== "stopped");
    });
    try {
      assert.equal(manager.getServer("lazy")?.state, "stopped");
      assert.equal(tools.length, 0);
      const first = manager.startServer("lazy", process.cwd());
      const second = manager.startServer("lazy", process.cwd());
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(manager.getServer("lazy")?.state, "starting");
      assert.equal(active.length, 0);
      discovery.release();
      await Promise.all([first, second]);
      assert.equal(manager.getServer("lazy")?.state, "ready");
      assert.ok(active.some((name) => name.includes("echo")));
      assert.equal(tools.filter((tool) => tool.name.includes("echo")).length, 1);
    } finally { discovery.release(); await manager.shutdownAll(); }
  });

  it("reports exhausted retries and preserves failure status", async () => {
    const manager = new ServerManager(config("missing-pi-mcp-executable", 0));
    await assert.rejects(manager.startServer("lazy", process.cwd()), /Connection failed after 0 retries/);
    assert.equal(manager.getServer("lazy")?.state, "stopped");
    assert.ok(manager.getServer("lazy")?.lastError);
  });

  it("stop during retry delay cancels the pending retry and rejects all waiters", async () => {
    const manager = new ServerManager(config("missing-pi-mcp-executable", 1));
    const first = manager.startServer("lazy", process.cwd());
    const second = manager.startServer("lazy", process.cwd());
    const failures = Promise.allSettled([first, second]);
    for (let i = 0; i < 100 && !manager.getServer("lazy")?.retryTimer; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(manager.getServer("lazy")?.retryTimer);
    await manager.stopServer("lazy");
    const results = await failures;
    assert.ok(results.every((result) => result.status === "rejected"));
    assert.equal(manager.getServer("lazy")?.retryTimer, null);
    assert.equal(manager.getServer("lazy")?.state, "stopped");
  });

  it("stop during discovery prevents late readiness and activation", async () => {
    const manager = new ServerManager(config());
    const discovery = gate();
    let activated = false;
    manager.setToolRefreshCallback(async () => { await discovery.promise; if (manager.getServer("lazy")?.state !== "stopped") activated = true; });
    const start = manager.startServer("lazy", process.cwd());
    const result = assert.rejects(start, /cancelled/);
    for (let i = 0; i < 100 && !manager.getServer("lazy")?.client; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(manager.getServer("lazy")?.client);
    await manager.stopServer("lazy");
    discovery.release();
    await result;
    assert.equal(activated, false);
    assert.equal(manager.getServer("lazy")?.state, "stopped");
  });
});

describe("isolated OAuth storage", () => {
  it("silent attempts never replace PKCE and stored tokens survive until explicit reset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-auth-lock-"));
    try {
      const interactive = new McpOAuthProvider("test", { clientId: "local" }, undefined, dir);
      const silent = new McpOAuthProvider("test", { clientId: "local" }, undefined, dir, true);
      await interactive.saveCodeVerifier("original");
      await interactive.saveTokens({ access_token: "stored", token_type: "Bearer" });
      await assert.rejects(silent.saveCodeVerifier("other"), AuthRequiredError);
      assert.equal(await interactive.codeVerifier(), "original");
      await assert.rejects(silent.codeVerifier(), /No PKCE code verifier/);
      assert.equal((await silent.tokens())?.access_token, "stored");
      const unlock = await acquireAuthLock("test", dir);
      await assert.rejects(acquireAuthLock("test", dir), /Another Pi process/);
      await silent.saveTokens({ access_token: "other", token_type: "Bearer" });
      assert.equal((await silent.tokens())?.access_token, "other");
      await unlock();
      assert.equal((await getAuthStatus("test", dir))?.hasTokens, true);
      await resetAuth("test", dir);
      assert.equal(await getAuthStatus("test", dir), null);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

it("does not retry an OAuth browser challenge or alter stored PKCE during a silent connect", async () => {
  const { createServer } = await import("node:http");
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-local-auth-"));
  let requests = 0;
  let base = "";
  const listener = createServer((req, res) => {
    if (req.url === "/.well-known/oauth-protected-resource/mcp" || req.url === "/.well-known/oauth-protected-resource") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }));
    } else if (req.url === "/.well-known/oauth-authorization-server") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] }));
    } else {
      requests++;
      res.writeHead(401, { "WWW-Authenticate": "Bearer" });
      res.end("auth required");
    }
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  const manager = new ServerManager({
    settings: { toolPrefix: "mcp", requestTimeoutMs: 2000, maxRetries: 2 },
    mcpServers: { local: { lifecycle: "lazy", transport: "streamable-http", url: `${base}/mcp`, args: [], auth: { type: "oauth", clientId: "local-client" } } },
  }, undefined, dir);
  const provider = new McpOAuthProvider("local", { clientId: "local-client" }, undefined, dir);
  try {
    await provider.saveCodeVerifier("existing-flow");
    await assert.rejects(manager.startServer("local", process.cwd()), AuthRequiredError);
    assert.equal(requests, 1);
    assert.equal(manager.getServer("local")?.retryCount, 0);
    assert.equal(await provider.codeVerifier(), "existing-flow");
  } finally {
    await manager.shutdownAll();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("should fail immediately with AuthRequiredError and transition connectRequested into interactive OAuth when an OAuth server returns HTTP 401 after silent auth", async () => {
  // Arrange
  const { createServer } = await import("node:http");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { default: extension } = await import("../src/index.js");
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issue1-auth-"));
  const authDir = join(dir, "auth");
  let base = "";
  let unauthorizedMcpPosts = 0;
  let allowNextRefresh = true;

  const listener = createServer((req, res) => {
    if (req.url === "/.well-known/oauth-protected-resource/mcp" || req.url === "/.well-known/oauth-protected-resource") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }));
      return;
    }
    if (req.url === "/.well-known/oauth-authorization-server") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }
    if (req.url === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", () => {
        const params = new URLSearchParams(body);
        res.setHeader("content-type", "application/json");
        if (params.get("grant_type") === "refresh_token") {
          if (allowNextRefresh) {
            allowNextRefresh = false;
            // Silent refresh succeeds at the token endpoint, but the resource server will still reject this token with 401
            res.end(JSON.stringify({ access_token: "still-rejected-token", token_type: "Bearer" }));
          } else {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "invalid_grant" }));
          }
        } else {
          res.end(JSON.stringify({ access_token: "interactive-valid-token", token_type: "Bearer" }));
        }
      });
      return;
    }
    if (req.url === "/mcp") {
      if (req.method === "GET") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      if (req.headers.authorization !== "Bearer interactive-valid-token") {
        unauthorizedMcpPosts++;
        res.writeHead(401, { "WWW-Authenticate": "Bearer" });
        res.end("Unauthorized");
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", () => {
        const msg = JSON.parse(body);
        if (msg.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "mock-oauth", version: "1.0.0" },
              },
            }),
          );
        } else if (msg.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
        } else if (msg.method === "tools/list") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                tools: [
                  {
                    name: "ping_tool",
                    description: "Ping",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              },
            }),
          );
        } else {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const callbackProbe = createServer();
  await new Promise<void>((resolve) => callbackProbe.listen(0, "127.0.0.1", resolve));
  const callbackAddress = callbackProbe.address();
  assert.ok(callbackAddress && typeof callbackAddress === "object");
  await new Promise<void>((resolve) => callbackProbe.close(() => resolve()));

  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;

  const redirectUrl = `http://127.0.0.1:${callbackAddress.port}/callback`;
  const manager = new ServerManager(
    {
      settings: { toolPrefix: "mcp", requestTimeoutMs: 2000, maxRetries: 2 },
      mcpServers: {
        local: {
          lifecycle: "lazy",
          transport: "streamable-http",
          url: `${base}/mcp`,
          args: [],
          auth: { type: "oauth", clientId: "local-client", redirectUrl },
        },
      },
    },
    undefined,
    authDir,
  );
  const provider = new McpOAuthProvider("local", { clientId: "local-client", redirectUrl }, undefined, authDir);
  const events = new Map<string, any>();

  try {
    await provider.saveTokens({
      access_token: "initial-expired-token",
      refresh_token: "refresh-1",
      token_type: "Bearer",
    });

    // Act (Part 1: direct startServer fails fast with AuthRequiredError and retryCount === 0)
    await assert.rejects(manager.startServer("local", process.cwd()), AuthRequiredError);

    // Assert (Part 1)
    assert.equal(manager.getServer("local")?.retryCount, 0);
    assert.equal(manager.getServer("local")?.state, "stopped");
    assert.ok(manager.getServer("local")?.lastError instanceof AuthRequiredError);
    assert.equal(unauthorizedMcpPosts, 2);

    // Arrange (Part 2: seed refresh_token again so connectRequested hits the same post-silent-auth 401 and transitions to interactive OAuth)
    allowNextRefresh = true;
    await provider.saveTokens({
      access_token: "initial-expired-token",
      refresh_token: "refresh-1",
      token_type: "Bearer",
    });

    const tools = new Map<string, any>();
    let activeTools: string[] = [];
    let browserOpened = 0;
    const pi = {
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: () => {},
      on: (name: string, handler: any) => events.set(name, handler),
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
    };
    const ctx: any = {
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        select: (_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
          new Promise<string | undefined>((resolve) => {
            opts?.signal?.addEventListener("abort", () => resolve(undefined));
          }),
      },
    };

    await mkdir(join(dir, ".pi"));
    await writeFile(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({
        settings: { maxRetries: 2 },
        mcpServers: {
          local: {
            lifecycle: "lazy",
            transport: "streamable-http",
            url: `${base}/mcp`,
            auth: { type: "oauth", clientId: "local-client", redirectUrl },
          },
        },
      }),
    );

    await extension(pi as any, {
      bootstrapCwd: dir,
      globalConfigPath: join(dir, "no-global.json"),
      authStorageDir: authDir,
      browserOpen: (url: string) => {
        browserOpened++;
        const authUrl = new URL(url);
        const state = authUrl.searchParams.get("state");
        const callbackTarget = authUrl.searchParams.get("redirect_uri");
        assert.ok(state && callbackTarget);
        void fetch(`${callbackTarget}?code=interactive-code&state=${encodeURIComponent(state)}`);
      },
    });
    await events.get("session_start")({}, ctx);

    // Act (Part 2: connectRequested transitions into interactive OAuth and completes connection)
    const connectResult = await tools.get("mcp_connect").execute("", { name: "local" }, undefined, undefined, ctx);

    // Assert (Part 2)
    assert.equal(browserOpened, 1);
    assert.match(connectResult.content[0].text, /MCP server local ready/);
    assert.ok(activeTools.some((name) => name.includes("ping_tool")));
  } finally {
    await events.get("session_shutdown")?.({}, { cwd: dir, hasUI: false, ui: { notify: () => {} } });
    await manager.shutdownAll();
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("stop during a pending handshake prevents late readiness", async () => {
  const { createServer } = await import("node:http");
  const entered = gate();
  const response = gate();
  const listener = createServer(async (_req, res) => {
    entered.release();
    await response.promise;
    if (!res.destroyed) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "mock", version: "1" } } }));
    }
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const manager = new ServerManager({
    settings: { toolPrefix: "mcp", requestTimeoutMs: 1000, maxRetries: 0 },
    mcpServers: { delayed: { lifecycle: "lazy", transport: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp`, args: [] } },
  });
  try {
    const attempt = manager.startServer("delayed", process.cwd());
    const failure = assert.rejects(attempt, /cancelled/);
    await entered.promise;
    await manager.stopServer("delayed");
    response.release();
    await failure;
    assert.equal(manager.getServer("delayed")?.state, "stopped");
  } finally {
    response.release();
    await manager.shutdownAll();
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

for (const externalAction of ["stop", "shutdown"] as const) {
  it(`does not reconnect after external ${externalAction} during health cleanup`, async () => {
    const cfg = config();
    cfg.mcpServers.lazy!.healthCheckIntervalMs = 10;
    const manager = new ServerManager(cfg);
    const closeEntered = gate();
    const releaseClose = gate();
    const closeFinished = gate();
    try {
      await manager.startServer("lazy", process.cwd());
      const client = manager.getServer("lazy")!.client! as any;
      const originalClose = client.close.bind(client);
      client.ping = async () => { throw new Error("mock ping failed"); };
      client.close = async () => {
        closeEntered.release();
        await releaseClose.promise;
        try { await originalClose(); }
        finally { closeFinished.release(); }
      };
      let recoveryStarts = 0;
      const originalStart = manager.startServer.bind(manager);
      manager.startServer = async (...args) => { recoveryStarts++; return originalStart(...args); };
      await closeEntered.promise;
      if (externalAction === "stop") await manager.stopServer("lazy");
      else await manager.shutdownAll();
      releaseClose.release();
      await closeFinished.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(recoveryStarts, 0);
      assert.equal(manager.getServer("lazy")?.state, "stopped");
    } finally {
      releaseClose.release();
      await manager.shutdownAll();
    }
  });
}

it("still reconnects after health failure when no external stop occurs", async () => {
  const cfg = config();
  cfg.mcpServers.lazy!.healthCheckIntervalMs = 10;
  const manager = new ServerManager(cfg);
  const recovered = gate();
  try {
    await manager.startServer("lazy", process.cwd());
    const client = manager.getServer("lazy")!.client! as any;
    client.ping = async () => { throw new Error("mock ping failed"); };
    let recoveryStarts = 0;
    const originalStart = manager.startServer.bind(manager);
    manager.startServer = async (...args) => {
      recoveryStarts++;
      recovered.release();
      return originalStart(...args);
    };
    await recovered.promise;
    assert.equal(recoveryStarts, 1);
  } finally { await manager.shutdownAll(); }
});

it("deactivates tools and reconnects when the server process dies unexpectedly", async () => {
  const manager = new ServerManager(config());
  const stopped = gate();
  let stoppedCalls = 0;
  manager.setServerStoppedCallback(() => { stoppedCalls++; stopped.release(); });
  try {
    await manager.startServer("lazy", process.cwd());
    const firstClient = manager.getServer("lazy")!.client! as any;
    const firstPid = firstClient.transport.pid as number;
    assert.ok(firstPid);
    process.kill(firstPid, "SIGKILL");
    await stopped.promise;
    assert.equal(stoppedCalls, 1);
    for (let i = 0; i < 500 && manager.getServer("lazy")?.state !== "ready"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(manager.getServer("lazy")?.state, "ready");
    assert.notEqual(manager.getServer("lazy")?.client, firstClient);
  } finally { await manager.shutdownAll(); }
});

it("does not reconnect after a deliberate stop", async () => {
  const manager = new ServerManager(config());
  try {
    await manager.startServer("lazy", process.cwd());
    let recoveryStarts = 0;
    const originalStart = manager.startServer.bind(manager);
    manager.startServer = async (...args) => { recoveryStarts++; return originalStart(...args); };
    await manager.stopServer("lazy");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(recoveryStarts, 0);
    assert.equal(manager.getServer("lazy")?.state, "stopped");
  } finally { await manager.shutdownAll(); }
});

it("should clear server.attempt and server.controller on stopServer and unblock pending SSE start() so subsequent startServer does not reuse aborted attempt (Issues 19.2, 20.1)", async () => {
  const { createServer } = await import("node:http");
  let allowEndpoint = false;
  const sockets = new Set<any>();

  const listener = createServer((req, res) => {
    if (req.url === "/sse" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (allowEndpoint) {
        res.write("event: endpoint\ndata: /messages\n\n");
      } else {
        res.write(": waiting\n\n");
      }
      return;
    }
    if (req.url === "/messages" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c.toString(); });
      req.on("end", () => {
        const msg = JSON.parse(body);
        res.writeHead(202);
        res.end();
        // Send response over SSE stream if needed — or we can test stop during start()
        void msg;
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  listener.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");

  const manager = new ServerManager({
    settings: { toolPrefix: "mcp", requestTimeoutMs: 5000, maxRetries: 0 },
    mcpServers: {
      sse: {
        lifecycle: "lazy",
        transport: "sse",
        url: `http://127.0.0.1:${address.port}/sse`,
        args: [],
      },
    },
  });

  try {
    const firstAttempt = manager.startServer("sse", process.cwd());
    const rejection = assert.rejects(firstAttempt, /cancelled/i);

    // Wait briefly for SSE request to connect
    await new Promise((resolve) => setTimeout(resolve, 40));
    await manager.stopServer("sse");
    await rejection;

    const srv = manager.getServer("sse");
    assert.equal(srv?.attempt, undefined);
    assert.equal(srv?.controller, undefined);
    assert.equal(srv?.state, "stopped");
  } finally {
    await manager.shutdownAll();
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

it("should cancel listAllTools and refreshTools with AuthCancelledError instead of wrapping in McpError('protocol') (Issue 19.2)", async () => {
  const { AuthCancelledError } = await import("../src/index.js");
  const mockPi = {
    registerTool: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
  const bridge = new ToolBridge({ toolPrefix: "mcp", requestTimeoutMs: 5000, maxRetries: 0 }, mockPi);
  const controller = new AbortController();
  const listToolsEntered = gate();

  const slowClient = {
    listTools: (_params?: any, options?: { signal?: AbortSignal; timeout?: number }) =>
      new Promise((_resolve, reject) => {
        listToolsEntered.release();
        options?.signal?.addEventListener("abort", () => {
          const abortErr = new Error("This operation was aborted");
          abortErr.name = "AbortError";
          reject(abortErr);
        });
      }),
  } as any;

  const refreshPromise = bridge.refreshTools("cancel-srv", slowClient, {
    requestTimeoutMs: 1234,
    signal: controller.signal,
  });
  await listToolsEntered.promise;
  controller.abort();

  await assert.rejects(
    refreshPromise,
    (err: unknown) => err instanceof AuthCancelledError,
  );
});

it("should recover SSE and StreamableHTTP servers on unexpected transport errors while ignoring benign protocol warnings, and surface recovery failures via callback and UI notifications (Issue 20.2)", async () => {
  const { createServer } = await import("node:http");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { default: extension } = await import("../src/index.js");
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-issue20-2-"));

  let shouldFailConnect = false;
  let shouldRequireAuth = false;

  const listener = createServer((req, res) => {
    if (req.url === "/mcp") {
      if (req.method === "GET") {
        // Simulate a POST-only HTTP server (e.g. Express/Fastify app.post('/mcp')) returning 404 on GET
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      if (shouldRequireAuth) {
        res.writeHead(401, { "WWW-Authenticate": "Bearer" });
        res.end("Unauthorized");
        return;
      }
      if (shouldFailConnect) {
        res.writeHead(500);
        res.end("Internal Server Error");
        return;
      }
      let body = "";
      req.on("data", (c) => { body += c.toString(); });
      req.on("end", () => {
        const msg = JSON.parse(body);
        if (msg.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "http-srv", version: "1.0.0" },
              },
            }),
          );
        } else if (msg.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
        } else if (msg.method === "tools/list") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                tools: [{ name: "http_ping", inputSchema: { type: "object", properties: {} } }],
              },
            }),
          );
        } else if (msg.method === "ping") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
        } else {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/mcp`;

  const manager = new ServerManager({
    settings: { toolPrefix: "mcp", requestTimeoutMs: 1000, maxRetries: 0 },
    mcpServers: {
      httpSrv: {
        lifecycle: "lazy",
        transport: "streamable-http",
        url: baseUrl,
        args: [],
        auth: { type: "oauth", clientId: "cid" },
      },
    },
  }, undefined, join(dir, "auth"));

  try {
    await manager.startServer("httpSrv", dir);
    assert.equal(manager.getServer("httpSrv")?.state, "ready");
    const firstClient = manager.getServer("httpSrv")!.client!;

    // 1. Benign protocol errors and optional GET SSE probe failures must NOT trigger recovery
    let recoveryStarts = 0;
    const origStart = manager.startServer.bind(manager);
    const reconnected = gate();
    manager.startServer = async (...args) => {
      recoveryStarts++;
      const res = await origStart(...args);
      reconnected.release();
      return res;
    };

    firstClient.onerror?.(new Error("Received a response for an unknown message ID: 99"));
    firstClient.onerror?.(new Error("Failed to open SSE stream: Method Not Allowed"));
    firstClient.onerror?.(new Error("Streamable HTTP error: Failed to open SSE stream: Bad Request"));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(recoveryStarts, 0, "Benign errors must not trigger recovery");
    assert.equal(manager.getServer("httpSrv")?.client, firstClient);

    // 2. Real stream disconnect error on ready streamable-http server triggers recovery
    firstClient.onerror?.(new Error("SSE stream disconnected: TypeError: terminated"));
    await reconnected.promise;
    assert.equal(recoveryStarts, 1);
    assert.equal(manager.getServer("httpSrv")?.state, "ready");

    // 3. Recovery failure invokes setRecoveryFailedCallback
    const recoveryFailedGate = gate();
    let failedServer = "";
    let failedErr: Error | undefined;
    manager.setRecoveryFailedCallback((srvName: string, err: Error) => {
      failedServer = srvName;
      failedErr = err;
      recoveryFailedGate.release();
    });

    shouldFailConnect = true;
    const secondClient = manager.getServer("httpSrv")!.client!;
    secondClient.onerror?.(new Error("Maximum reconnection attempts (0) exceeded."));
    await recoveryFailedGate.promise;
    assert.equal(failedServer, "httpSrv");
    assert.ok(failedErr);

    // 4. Verify src/index.ts wires setRecoveryFailedCallback to notify on auth vs connection errors
    shouldFailConnect = false;
    shouldRequireAuth = false;
    const events = new Map<string, any>();
    const notifications: Array<{ msg: string; level?: string | undefined }> = [];
    const statuses: Array<string | undefined> = [];
    const authNotified = gate();
    const connNotified = gate();
    const pi = {
      registerTool: () => {},
      registerCommand: () => {},
      on: (name: string, fn: any) => events.set(name, fn),
      getActiveTools: () => [],
      setActiveTools: () => {},
    };
    const ctx: any = {
      cwd: dir,
      hasUI: true,
      ui: {
        notify: (msg: string, level?: string) => {
          notifications.push({ msg, level });
          if (msg.includes("requires re-authorization")) authNotified.release();
          if (msg.includes("Lost connection to")) connNotified.release();
        },
        setStatus: (_key: string, text?: string) => statuses.push(text),
        select: async () => "Not now",
      },
    };
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({
        settings: { maxRetries: 0, requestTimeoutMs: 1000 },
        mcpServers: {
          httpSrv: {
            lifecycle: "eager",
            transport: "streamable-http",
            url: baseUrl,
            healthCheckIntervalMs: 25,
            auth: { type: "oauth", clientId: "cid" },
          },
        },
      }),
    );

    await extension(pi as any, {
      bootstrapCwd: dir,
      globalConfigPath: join(dir, "no-global.json"),
      authStorageDir: join(dir, "auth2"),
    });
    await events.get("session_start")({}, ctx);

    // Trigger background 401 failure on health check -> _recover -> AuthRequiredError
    shouldRequireAuth = true;
    await authNotified.promise;
    assert.ok(
      notifications.some(
        (n) =>
          n.msg === "pi-mcp: httpSrv requires re-authorization — run /mcp:auth httpSrv" &&
          n.level === "warning",
      ),
    );
    assert.ok(statuses.includes("run /mcp:auth httpSrv"));

    await events.get("session_shutdown")({}, ctx);
  } finally {
    await manager.shutdownAll();
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

