import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/index.js";
import { McpOAuthProvider, getAuthStatus } from "../src/oauth-provider.js";
import { createMockExtension, createMockContext } from "./helpers/mock-extension.js";

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
  const mockExt = createMockExtension();
  const commands = mockExt.commands;
  const events = mockExt.events;
  const messages: string[] = [];
  let opens = 0;
  let choices = 0;
  const ctx = createMockContext({
    cwd: dir,
    hasUI: true,
    ui: {
      notify: (message: string) => messages.push(message),
      select: async (_title: string, options: string[]) => options.at(choices++ === 0 ? 0 : -1),
    },
  });
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
    await extension(mockExt.api, { bootstrapCwd: dir, globalConfigPath: join(dir, "missing.json"), authStorageDir: join(dir, "auth"), browserOpen: () => { opens++; } });
    await events.get("session_start")({}, ctx);
    await commands.get("mcp:auth").handler("  team server  ", ctx);
    assert.equal(opens, 2, "One initial browser launch and one explicit Retry");
    assert.equal(choices, 2);
    assert.ok(messages.some((message) => /Authentication cancelled for team server/.test(message)));
    await assertStopped();

    const provider = new McpOAuthProvider({
      serverName: "team server",
      authConfig: { clientId: "test-client" },
      storageDir: join(dir, "auth"),
    });
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

it("stops a ready server on /mcp:auth and re-authenticates interactively instead of returning a no-op", async () => {
  const { startFakeOAuthServer } = await import("./helpers/fake-oauth-server.js");
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-auth-ready-"));
  const authDir = join(dir, "auth");
  const fakeServer = await startFakeOAuthServer({ serverName: "ready-oauth", toolName: "ready_echo" });
  const mockExt = createMockExtension();
  const commands = mockExt.commands;
  const events = mockExt.events;
  const messages: string[] = [];
  const ctx = createMockContext({
    cwd: dir,
    hasUI: true,
    ui: {
      notify: (message: string) => messages.push(message),
      select: (_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
        new Promise<string | undefined>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
    },
  });

  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({
        settings: { maxRetries: 0 },
        mcpServers: {
          "ready-oauth": {
            lifecycle: "lazy",
            transport: "streamable-http",
            url: fakeServer.mcpUrl,
            auth: { type: "oauth" },
          },
        },
      }),
    );

    await extension(
      mockExt.api,
      {
        bootstrapCwd: dir,
        globalConfigPath: join(dir, "missing.json"),
        authStorageDir: authDir,
        browserOpen: fakeServer.browserOpen,
      },
    );
    await events.get("session_start")({}, ctx);

    // Step 1: Initial /mcp:auth connects and reaches ready state
    await commands.get("mcp:auth").handler("ready-oauth", ctx);
    assert.equal(fakeServer.browserOpenCount, 1);

    // Step 2: While server is still in "ready" state, expire tokens and fail refresh on the server, then run /mcp:auth again
    fakeServer.expireAccessTokens();
    fakeServer.failRefresh = true;
    await commands.get("mcp:auth").handler("ready-oauth", ctx);
    const activeTools = mockExt.activeTools;

    // Assert: /mcp:auth stopped the ready server, detected the 401/failed refresh, and opened the browser a second time
    assert.equal(fakeServer.browserOpenCount, 2);
    assert.ok(activeTools.some((name) => name.includes("ready_echo")));
  } finally {
    await events.get("session_shutdown")?.({}, ctx);
    await fakeServer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("should report usage on bare /mcp:auth --reset, support leading /mcp:auth --reset <name>, and suppress false error notification when /mcp:start is cancelled via /mcp:stop (Issue 24.4)", async () => {
  const { startFakeOAuthServer } = await import("./helpers/fake-oauth-server.js");
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-auth-cmd-24-4-"));
  const authDir = join(dir, "auth");
  const fakeServer = await startFakeOAuthServer({ serverName: "oauth-srv", toolName: "oauth_echo" });

  let holdHttpConnect = true;
  let releaseHttpConnect!: () => void;
  const httpEntered = new Promise<void>((resolve) => {
    releaseHttpConnect = resolve;
  });
  let markHttpEntered!: () => void;
  const httpReached = new Promise<void>((resolve) => {
    markHttpEntered = resolve;
  });
  const handleSlowRequest = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    markHttpEntered();
    if (holdHttpConnect) {
      await httpEntered;
    }
    if (!res.destroyed) {
      res.writeHead(500);
      res.end();
    }
  };
  const slowListener = createServer((_req, res) => {
    void handleSlowRequest(_req, res);
  });
  await new Promise<void>((resolve) => slowListener.listen(0, "127.0.0.1", resolve));
  const slowAddr = slowListener.address();
  assert.ok(slowAddr && typeof slowAddr === "object");

  const mockExt = createMockExtension();
  const commands = mockExt.commands;
  const events = mockExt.events;
  const notifications: Array<{ msg: string; level?: string | undefined }> = [];
  const ctx = createMockContext({
    cwd: dir,
    hasUI: true,
    ui: {
      notify: (msg: string, level?: string) => notifications.push({ msg, level }),
      select: (_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
        new Promise<string | undefined>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
    },
  });

  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({
        settings: { maxRetries: 0, requestTimeoutMs: 5000 },
        mcpServers: {
          "oauth-srv": {
            lifecycle: "lazy",
            transport: "streamable-http",
            url: fakeServer.mcpUrl,
            auth: { type: "oauth" },
          },
          "slow-plain": {
            lifecycle: "lazy",
            transport: "streamable-http",
            url: `http://127.0.0.1:${slowAddr.port}/mcp`,
          },
        },
      }),
    );

    await extension(
      mockExt.api,
      {
        bootstrapCwd: dir,
        globalConfigPath: join(dir, "missing.json"),
        authStorageDir: authDir,
        browserOpen: fakeServer.browserOpen,
      },
    );
    await events.get("session_start")({}, ctx);

    // 1. Bare `/mcp:auth --reset` must notify Usage error, NOT "No OAuth server named --reset"
    notifications.length = 0;
    await commands.get("mcp:auth").handler("--reset", ctx);
    assert.deepEqual(notifications, [{ msg: "Usage: /mcp:auth <name> [--reset]", level: "error" }]);

    // 2. Leading `/mcp:auth --reset oauth-srv` must reset stored tokens and run interactive OAuth
    const provider = new McpOAuthProvider({
      serverName: "oauth-srv",
      authConfig: { type: "oauth" },
      storageDir: authDir,
      mode: "interactive",
      serverUrl: fakeServer.mcpUrl,
    });
    await provider.saveTokens({ access_token: "stale-valid-token", token_type: "Bearer" });
    await commands.get("mcp:auth").handler("--reset oauth-srv", ctx);
    assert.equal(fakeServer.browserOpenCount, 1, "Leading --reset must discard stored tokens and open browser");

    // 3. Cancelling `/mcp:start slow-plain` via `/mcp:stop slow-plain` must NOT emit a false error notification
    notifications.length = 0;
    const startPromise = commands.get("mcp:start").handler("slow-plain", ctx);
    await httpReached;
    await commands.get("mcp:stop").handler("slow-plain", ctx);
    releaseHttpConnect();
    await startPromise;

    assert.equal(
      notifications.some((n) => n.level === "error" || /Failed to start slow-plain/.test(n.msg)),
      false,
      `Expected no error notification when /mcp:start is cancelled by /mcp:stop, got: ${JSON.stringify(notifications)}`,
    );
    assert.ok(notifications.some((n) => n.msg === "pi-mcp: Stopped slow-plain" && n.level === "info"));
  } finally {
    releaseHttpConnect();
    await events.get("session_shutdown")?.({}, ctx);
    slowListener.closeAllConnections();
    await new Promise<void>((resolve) => slowListener.close(() => resolve()));
    await fakeServer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

