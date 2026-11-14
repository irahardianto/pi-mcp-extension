import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import extension from "../src/index.js";
import { acquireAuthLock, AuthLockError, AuthRequiredError, getAuthStatus, McpOAuthProvider } from "../src/oauth-provider.js";
import { AuthCancelledError, McpError } from "../src/errors.js";
import { formatMcpConnectError, formatConnectSuccess, registerManagementTools, type ManagementToolDeps } from "../src/register-tools.js";
import { createMockExtension, createMockContext } from "./helpers/mock-extension.js";

for (const { name, error, options, expected } of [
  {
    name: "an aborted request before reporting a protocol failure",
    error: new McpError("private diagnostic", "server", "protocol"),
    options: { aborted: true },
    expected: "MCP connection cancelled. Retry when ready.",
  },
  {
    name: "an authorization cancellation",
    error: new AuthCancelledError("server"),
    options: {},
    expected: "MCP connection cancelled. Retry when ready.",
  },
  {
    name: "an unknown server before reporting authorization requirements",
    error: new AuthRequiredError("server"),
    options: { serverExists: false },
    expected: "Unknown MCP server name. Use mcp_status to list configured servers.",
  },
  {
    name: "an authorization lock before the broader authorization-required error",
    error: new AuthLockError("server", "private diagnostic"),
    options: {},
    expected: "Another Pi process is authorizing this server. Retry after it finishes.",
  },
  {
    name: "authorization required in an interactive session",
    error: new AuthRequiredError("server"),
    options: {},
    expected: "MCP authorization required. Retry with mcp_connect or /mcp:auth.",
  },
  {
    name: "authorization required without a UI",
    error: new AuthRequiredError("server"),
    options: { hasUI: false },
    expected: "MCP authorization requires an interactive Pi session.",
  },
  {
    name: "a protocol error as a discovery failure",
    error: new McpError("private diagnostic", "server", "protocol"),
    options: {},
    expected: "MCP tool discovery failed. Check the server and retry.",
  },
  {
    name: "a request timeout without blaming the configuration",
    error: new McpError("private diagnostic", "server", "timeout"),
    options: {},
    expected: "MCP server did not respond in time. Check that it is running and retry.",
  },
  {
    name: "a generic failure without exposing its diagnostic text",
    error: new Error("private diagnostic"),
    options: {},
    expected: "MCP connection failed. Check the server configuration and retry.",
  },
  {
    name: "a non-Error rejection without exposing its value",
    error: "private diagnostic",
    options: {},
    expected: "MCP connection failed. Check the server configuration and retry.",
  },
]) {
  it(`formats ${name}`, () => {
    assert.equal(formatMcpConnectError(error, {
      aborted: false, serverExists: true, hasUI: true, ...options,
    }), expected);
  });
}

it("propagates in-flight mcp_list_resources cancellation instead of recording a per-server error row", async () => {
  const mockExt = createMockExtension();
  let nextFailure: () => Error = () => new AuthCancelledError("docs");
  const server = {
    name: "docs",
    state: "ready",
    client: { getServerCapabilities: () => ({ resources: {} }) },
  };
  const deps = {
    manager: {
      getAllServers: () => [server],
      resolveRequestTimeoutMs: () => 1000,
    },
    coordinator: {},
    bridge: {},
    resources: {
      getCatalog: async () => {
        throw nextFailure();
      },
    },
    getProvenance: () => ({ origins: {}, extensionServers: [], projectConfigPath: "", projectConfigIncluded: false }),
  } as unknown as ManagementToolDeps;

  registerManagementTools(mockExt.api, deps);
  const listResources = mockExt.tools.get("mcp_list_resources");

  await assert.rejects(
    listResources.execute("", { server: "docs" }),
    (err: unknown) => err instanceof AuthCancelledError && err.message.includes("docs"),
  );

  const midFlight = new AbortController();
  nextFailure = () => {
    midFlight.abort();
    return new Error("transport closed during abort");
  };
  await assert.rejects(
    listResources.execute("", {}, midFlight.signal),
    (err: unknown) => err instanceof AuthCancelledError && err.message.includes("docs"),
  );
});

it("formats a successful mcp_connect message that reflects the configured exposure", () => {
  assert.equal(
    formatConnectSuccess("svc", { discovered: 6, active: 3, expected: 3 }),
    "MCP server svc ready; tools discovered and active.",
  );
  assert.equal(
    formatConnectSuccess("svc", { discovered: 6, active: 0, expected: 0 }),
    "MCP server svc ready; no tool is configured as direct — all 6 are deferred, codemode, or hidden.",
  );
  // A tool_search-loaded tool must not leave the message claiming nothing is callable.
  assert.equal(
    formatConnectSuccess("svc", { discovered: 6, active: 2, expected: 0 }),
    "MCP server svc ready; no tool is configured as direct — all 6 are deferred, codemode, or hidden (2 loaded through tool_search or codemode).",
  );
  assert.equal(
    formatConnectSuccess("svc", { discovered: 0, active: 0, expected: 0 }),
    "MCP server svc ready; it advertises no tools.",
  );
});

it("reports mcp_connect success when exposure keeps most tools out of the model (#257)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-exposure-"));
  const mock = join(dirname(fileURLToPath(import.meta.url)), "mock-server.ts");
  const tsxEsmLoader = import.meta.resolve("tsx/esm");
  const mockExt = createMockExtension();
  const tools = mockExt.tools;
  const events = mockExt.events;
  const ctx = createMockContext({ cwd: dir, hasUI: false });
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi", "mcp.json"), JSON.stringify({
      settings: { maxRetries: 0 },
      mcpServers: {
        partial: {
          command: "node",
          args: ["--import", tsxEsmLoader, mock],
          lifecycle: "lazy",
          exposure: "hidden",
          toolExposure: { "get_*": "direct", add: "deferred" },
        },
      },
    }));
    await extension(mockExt.api, { bootstrapCwd: dir, globalConfigPath: join(dir, "absent-global.json") });
    await events.get("session_start")({}, ctx);

    const result = await tools.get("mcp_connect").execute("", { name: "partial" }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /ready; tools discovered and active/);
    assert.deepEqual(
      [...mockExt.activeTools].sort(),
      ["mcp_partial_get_cwd", "mcp_partial_get_status"],
      "only the tools configured as direct may be active",
    );
    // The mock server advertises six tools; four stay hidden or deferred by configuration.
    const rows = JSON.parse((await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text);
    assert.deepEqual(rows[0].tools, { discovered: 6, active: 2, expected: 2 });

    // A tool_search-loaded deferred tool must not mask a direct tool another extension removed:
    // `active` (2) still equals `expected` (2), so only a per-name check catches it — and
    // `mcp_status` surfaces `inactiveDirect: 1` so callers see the masked missing tool.
    mockExt.activeTools = ["mcp_partial_add", "mcp_partial_get_cwd"];
    await assert.rejects(
      tools.get("mcp_connect").execute("", { name: "partial" }, undefined, undefined, ctx),
      /configured as direct are inactive.*inactiveDirect/,
      "an activated deferred tool must not mask an inactive direct tool",
    );
    assert.deepEqual(mockExt.activeTools, ["mcp_partial_add", "mcp_partial_get_cwd"]);
    const maskedRows = JSON.parse((await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text);
    assert.deepEqual(maskedRows[0].tools, { discovered: 6, active: 2, expected: 2, inactiveDirect: 1 });
  } finally {
    await events.get("session_shutdown")?.({}, ctx);
    await rm(dir, { recursive: true, force: true });
  }
});

it("registers agent-visible status and connect tools without eagerly starting a lazy server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-management-"));
  const mock = join(dirname(fileURLToPath(import.meta.url)), "mock-server.ts");
  const tsxEsmLoader = import.meta.resolve("tsx/esm");
  const mockExt = createMockExtension();
  const tools = mockExt.tools;
  const events = mockExt.events;
  const commands = mockExt.commands;
  const ctx = createMockContext({ cwd: dir, hasUI: false });
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi", "mcp.json"), JSON.stringify({
      settings: { maxRetries: 0 },
      mcpServers: { lazy: { command: "node", args: ["--import", tsxEsmLoader, mock], lifecycle: "lazy" } },
    }));
    await extension(mockExt.api, { bootstrapCwd: dir, globalConfigPath: join(dir, "absent-global.json") });
    assert.ok(tools.has("mcp_status"));
    assert.ok(tools.has("mcp_connect"));
    assert.equal(
      tools.get("mcp_status")?.promptSnippet,
      "Inspect configured MCP servers, their connection state, discovered tools, and authentication status.",
    );
    assert.equal(
      tools.get("mcp_connect")?.promptSnippet,
      "Connect or reconnect to a configured MCP server by name and register its tools.",
    );
    await events.get("session_start")({}, ctx);
    let active = mockExt.activeTools;
    assert.equal(active.length, 0);
    const status = await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx);
    assert.deepEqual(JSON.parse(status.content[0].text).map((row: { name: string; lifecycle: string; state: string }) => [row.name, row.lifecycle, row.state]), [["lazy", "lazy", "stopped"]]);
    await assert.rejects(tools.get("mcp_connect").execute("", { name: "unknown" }, undefined, undefined, ctx), /Unknown MCP server name/);
    const abortedStarter = new AbortController();
    const abortedJoiner = new AbortController();
    const first = tools.get("mcp_connect").execute("", { name: "lazy" }, abortedStarter.signal, undefined, ctx);
    const second = tools.get("mcp_connect").execute("", { name: "lazy" }, abortedJoiner.signal, undefined, ctx);
    const third = tools.get("mcp_connect").execute("", { name: "lazy" }, undefined, undefined, ctx);
    abortedStarter.abort();
    abortedJoiner.abort();
    const [, , result] = await Promise.all([
      assert.rejects(first, /cancelled/),
      assert.rejects(second, /cancelled/),
      third,
    ]);
    active = mockExt.activeTools;
    assert.match(result.content[0].text, /ready/);
    assert.ok(active.some((name) => name.includes("echo")));
    assert.ok(commands.has("mcp:start") && commands.has("mcp:stop") && commands.has("mcp:auth"));
    const discovered = active.length;
    const connectedStatus = JSON.parse((await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text);
    assert.deepEqual(connectedStatus[0].tools, { discovered, active: discovered, expected: discovered });
    // Another extension may apply an intentional tool restriction after discovery.
    mockExt.activeTools = mockExt.activeTools.slice(1);
    await assert.rejects(
      tools.get("mcp_connect").execute("", { name: "lazy" }, undefined, undefined, ctx),
      /connected, but some tools configured as direct are inactive/,
    );
    active = mockExt.activeTools;
    assert.equal(active.length, discovered - 1, "Connect must not override another extension's restriction");
    mockExt.activeTools = [];
    await assert.rejects(
      tools.get("mcp_connect").execute("", { name: "lazy" }, undefined, undefined, ctx),
      /connected, but some tools configured as direct are inactive/,
    );
    active = mockExt.activeTools;
    assert.deepEqual(active, []);
    const inactiveStatus = JSON.parse((await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text);
    assert.equal(inactiveStatus[0].state, "ready", "Transport readiness and tool activation are separate states");
    assert.deepEqual(inactiveStatus[0].tools, {
      discovered,
      active: 0,
      expected: discovered,
      inactiveDirect: discovered,
    });
    await events.get("session_shutdown")({}, ctx);
    active = mockExt.activeTools;
    assert.equal(active.length, 0);
  } finally {
    await events.get("session_shutdown")?.({}, ctx);
    await rm(dir, { recursive: true, force: true });
  }
});

it("reports headless OAuth as an actionable failure without opening a browser or exposing secrets", async () => {
  const { createServer } = await import("node:http");
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-headless-"));
  const mockExt = createMockExtension();
  const tools = mockExt.tools;
  const events = mockExt.events;
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
  const ctx = createMockContext({
    cwd: dir,
    hasUI: false,
    ui: { notify: () => {}, select: () => assert.fail("No UI") },
  });
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi", "mcp.json"), JSON.stringify({
      settings: { maxRetries: 2 },
      mcpServers: { private: { transport: "streamable-http", url: `${base}/mcp`, auth: { type: "oauth", clientId: "local" }, headers: { Authorization: "Bearer secret-never-report" }, lifecycle: "lazy" } },
    }));
    await extension(mockExt.api, { bootstrapCwd: dir, globalConfigPath: join(dir, "no-global.json"), authStorageDir: join(dir, "auth") });
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
  const mockExt = createMockExtension();
  const tools = mockExt.tools;
  const events = mockExt.events;
  const ctx = createMockContext({ cwd: dir, hasUI: false });
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi", "mcp.json"), JSON.stringify({ settings: { maxRetries: 1 }, mcpServers: { broken: { command: "missing-pi-mcp-executable" } } }));
    await extension(mockExt.api, { bootstrapCwd: dir, globalConfigPath: join(dir, "no-global.json") });
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
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  const mockExt = createMockExtension();
  const tools = mockExt.tools;
  const events = mockExt.events;
  const commands = mockExt.commands;
  let opens = 0;
  let choices = 0;
  const ctx = createMockContext({
    cwd: dir,
    hasUI: true,
    ui: { notify: () => {}, select: async (_title: string, options: string[]) => options.at(choices++ === 0 ? 0 : -1) },
  });
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi", "mcp.json"), JSON.stringify({
      settings: { maxRetries: 2 }, mcpServers: {
        "local team": { lifecycle: "lazy", transport: "streamable-http", url: `${base}/mcp`, auth: { type: "oauth", clientId: "local-client" } },
      },
    }));
    await extension(mockExt.api, {
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
    const provider = new McpOAuthProvider({ serverName: "local team", authConfig: { clientId: "local-client" }, storageDir: storage });
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
  const mockExt = createMockExtension();
  const tools = mockExt.tools;
  const events = mockExt.events;
  const ctx = createMockContext({ cwd: dir, hasUI: false });
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi", "mcp.json"), JSON.stringify({
      settings: { maxRetries: 0 },
      mcpServers: { local: { transport: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: credential }, lifecycle: "lazy" } },
    }));
    await extension(mockExt.api, { bootstrapCwd: dir, globalConfigPath: join(dir, "no-global.json") });
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

it("isolates a corrupt OAuth state file in mcp_status and recovers on first connect attempt with maxRetries 0", async () => {
  const { statePath } = await import("../src/auth-lock.js");
  const { startFakeOAuthServer } = await import("./helpers/fake-oauth-server.js");
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-corrupt-isolation-"));
  const authDir = join(dir, "auth");
  const fakeServer = await startFakeOAuthServer({ serverName: "corrupt-oauth", toolName: "recovered_tool" });
  const mockExt = createMockExtension();
  const tools = mockExt.tools;
  const events = mockExt.events;
  const ctx = createMockContext({
    cwd: dir,
    hasUI: true,
    ui: {
      notify: () => {},
      select: (_title: string, _opts: string[], opts?: { signal?: AbortSignal }) =>
        new Promise<string | undefined>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
    },
  });

  try {
    await mkdir(join(dir, ".pi"));
    await mkdir(authDir, { recursive: true });
    await writeFile(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({
        settings: { maxRetries: 0 },
        mcpServers: {
          "corrupt-oauth": {
            lifecycle: "lazy",
            transport: "streamable-http",
            url: fakeServer.mcpUrl,
            auth: { type: "oauth" },
          },
          "healthy-oauth": {
            lifecycle: "lazy",
            transport: "streamable-http",
            url: `${fakeServer.baseUrl}/mcp`,
            auth: { type: "oauth" },
          },
        },
      }),
    );

    // Seed valid state for healthy-oauth and corrupt JSON for corrupt-oauth
    const healthyProvider = new McpOAuthProvider({ serverName: "healthy-oauth", authConfig: { type: "oauth" }, storageDir: authDir });
    await healthyProvider.saveTokens({ access_token: "healthy-token", token_type: "Bearer" });
    await writeFile(statePath("corrupt-oauth", authDir), "{corrupt-json-state", "utf8");

    await extension(mockExt.api, {
      bootstrapCwd: dir,
      globalConfigPath: join(dir, "no-global.json"),
      authStorageDir: authDir,
      browserOpen: fakeServer.browserOpen,
    });
    await events.get("session_start")({}, ctx);

    // Part 1: mcp_status isolates the corrupt file for corrupt-oauth without failing for healthy-oauth
    const origErr = console.error;
    console.error = () => {};
    let statusRows: Array<{ name: string; auth?: string; [key: string]: unknown }> = [];
    try {
      const statusRes = await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx);
      statusRows = JSON.parse(statusRes.content[0].text);
    } finally {
      console.error = origErr;
    }

    const corruptRow = statusRows.find((r) => r.name === "corrupt-oauth");
    const healthyRow = statusRows.find((r) => r.name === "healthy-oauth");
    assert.equal(corruptRow?.auth, "corrupt state file backed up (re-auth required)");
    assert.equal(healthyRow?.auth, "credentials stored");

    // Part 2: Write another corrupt state file and verify _connect recovers in a single attempt (maxRetries: 0)
    await writeFile(statePath("corrupt-oauth", authDir), "{corrupt-on-connect", "utf8");
    const origErr2 = console.error;
    console.error = () => {};
    try {
      const connectRes = await tools.get("mcp_connect").execute("", { name: "corrupt-oauth" }, undefined, undefined, ctx);
      assert.match(connectRes.content[0].text, /ready/);
    } finally {
      console.error = origErr2;
    }
    const active = mockExt.activeTools;
    assert.ok(active.some((t) => t.includes("recovered_tool")));
  } finally {
    await events.get("session_shutdown")?.({}, ctx);
    await fakeServer.close();
    await rm(dir, { recursive: true, force: true });
  }
});


it("reports a tools/list timeout from mcp_connect as a timeout, not as tool discovery or config error (#209)", async () => {
  const { createServer } = await import("node:http");
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-discovery-timeout-"));
  const mockExt = createMockExtension();
  const tools = mockExt.tools;
  const events = mockExt.events;
  const ctx = createMockContext({ cwd: dir, hasUI: false });
  const listener = createServer((req, res) => {
    if (req.url !== "/mcp" || req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const msg = JSON.parse(body) as { id?: number; method?: string };
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "slow-tools", version: "1.0.0" },
          },
        }));
        return;
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      // tools/list hangs forever — the SDK request timeout is the only rejection.
    });
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi", "mcp.json"), JSON.stringify({
      settings: { maxRetries: 0, requestTimeoutMs: 100 },
      mcpServers: { slow: { transport: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp`, lifecycle: "lazy" } },
    }));
    await extension(mockExt.api, { bootstrapCwd: dir, globalConfigPath: join(dir, "absent-global.json") });
    await events.get("session_start")({}, ctx);
    await assert.rejects(
      tools.get("mcp_connect").execute("", { name: "slow" }, undefined, undefined, ctx),
      /did not respond in time/,
    );
    const status = JSON.parse((await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text);
    assert.equal(status[0].error, "Connection timeout; use mcp_connect to retry");
  } finally {
    await events.get("session_shutdown")?.({}, ctx);
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("wires session_tree, input, before_agent_start, tool_execution_end, and before_provider_request to keep active and declared tool order deterministic (#278)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-order-hooks-"));
  const mock = join(dirname(fileURLToPath(import.meta.url)), "mock-server.ts");
  const tsxEsmLoader = import.meta.resolve("tsx/esm");
  const mockExt = createMockExtension({ activeTools: ["bash", "read"] });
  const events = mockExt.events;
  const ctx = createMockContext({ cwd: dir, hasUI: false });
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi", "mcp.json"), JSON.stringify({
      settings: { maxRetries: 0 },
      mcpServers: { mock: { command: "node", args: ["--import", tsxEsmLoader, mock], lifecycle: "eager" } },
    }));
    await extension(mockExt.api, { bootstrapCwd: dir, globalConfigPath: join(dir, "absent-global.json") });

    assert.ok(events.has("session_tree"), "Must register session_tree handler");
    assert.ok(events.has("input"), "Must register input handler");
    assert.ok(events.has("before_agent_start"), "Must register before_agent_start handler");
    assert.ok(events.has("tool_execution_end"), "Must register tool_execution_end handler");
    assert.ok(events.has("before_provider_request"), "Must register before_provider_request handler");

    await events.get("session_start")({}, ctx);
    const expectedActive = [...mockExt.activeTools];
    assert.equal(expectedActive[0], "bash");
    assert.equal(expectedActive[1], "read");
    const ownedSorted = expectedActive.slice(2);
    assert.ok(ownedSorted.length >= 2);
    assert.deepEqual(ownedSorted, [...ownedSorted].sort());

    // Simulate `/tree` restoring unsorted transcript tool order.
    mockExt.activeTools = ["bash", "read", ...[...ownedSorted].reverse()];
    await events.get("session_tree")({}, ctx);
    assert.deepEqual(mockExt.activeTools, expectedActive);

    // Simulate an external shortcut/command scrambling active tools while idle: `input`
    // normalizes before `_prepareRun` snapshots `systemPromptOptions.selectedTools`, and
    // returns `undefined` so user input passes through untouched.
    mockExt.activeTools = ["bash", "read", ...[...ownedSorted].reverse()];
    const inputResult = await events.get("input")(
      { type: "input", text: "hello", source: "interactive" },
      ctx,
    );
    assert.equal(inputResult, undefined);
    assert.deepEqual(mockExt.activeTools, expectedActive);

    // Simulate another extension scrambling active tool order on a custom-message run (no `input`)
    // or in an earlier `before_agent_start` handler; returns `undefined` so prompt options stay untouched.
    mockExt.activeTools = ["bash", "read", ...[...ownedSorted].reverse()];
    const beforeStartResult = await events.get("before_agent_start")({}, ctx);
    assert.equal(beforeStartResult, undefined);
    assert.deepEqual(mockExt.activeTools, expectedActive);

    // Simulate `tool_search` activating matched MCP tools in BM25 score order mid-run;
    // `tool_execution_end` normalizes before `prepareNextTurnWithContext` builds `sections.tools`.
    mockExt.activeTools = ["bash", "read", ...[...ownedSorted].reverse()];
    const toolEndResult = await events.get("tool_execution_end")(
      { type: "tool_execution_end", toolCallId: "call-1", toolName: "tool_search", result: {}, isError: false },
      ctx,
    );
    assert.equal(toolEndResult, undefined);
    assert.deepEqual(mockExt.activeTools, expectedActive);

    const firstOwned = ownedSorted[0]!;
    const lastOwned = ownedSorted[ownedSorted.length - 1]!;
    const googlePayload = {
      config: {
        tools: [{ functionDeclarations: [{ name: lastOwned }, { name: "bash" }, { name: firstOwned }] }],
      },
    };
    const orderedGoogle = (await events.get("before_provider_request")(
      { payload: googlePayload },
      ctx,
    )) as typeof googlePayload;
    assert.deepEqual(
      orderedGoogle.config.tools[0]?.functionDeclarations.map((decl) => decl.name),
      [firstOwned, "bash", lastOwned],
    );

    const bedrockPayload = {
      toolConfig: {
        tools: [{ toolSpec: { name: lastOwned } }, { toolSpec: { name: firstOwned } }, { cachePoint: { type: "default" } }],
      },
    };
    const orderedBedrock = (await events.get("before_provider_request")(
      { payload: bedrockPayload },
      ctx,
    )) as typeof bedrockPayload;
    assert.deepEqual(orderedBedrock.toolConfig.tools, [
      { toolSpec: { name: firstOwned } },
      { toolSpec: { name: lastOwned } },
      { cachePoint: { type: "default" } },
    ]);

    const piMessagesPayload = {
      model: "claude-sonnet-4-6",
      context: {
        messages: [
          {
            role: "system",
            content: "sys",
            toolsAdded: [{ name: lastOwned }, { name: "bash" }, { name: firstOwned }],
            timestamp: 0,
          },
        ],
      },
      options: {},
    };
    const orderedPiMessages = (await events.get("before_provider_request")(
      { payload: piMessagesPayload },
      ctx,
    )) as typeof piMessagesPayload;
    assert.deepEqual(
      orderedPiMessages.context.messages[0]?.toolsAdded.map((decl) => decl.name),
      [firstOwned, "bash", lastOwned],
    );
  } finally {
    await events.get("session_shutdown")?.({}, ctx);
    await rm(dir, { recursive: true, force: true });
  }
});

it("extension lifecycle activates reaching discovery tools, warns once when unreachable, and hides stopped/removed server tools (#257)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-exposure-e2e-"));
  const mock = join(dirname(fileURLToPath(import.meta.url)), "mock-server.ts");
  const tsxEsmLoader = import.meta.resolve("tsx/esm");
  const notifications: Array<{ message: string; level: string | undefined }> = [];
  const noopExecute = async () => ({ content: [{ type: "text", text: "ok" }] as [{ type: "text"; text: string }] });
  const mockExt = createMockExtension({
    activeTools: ["read"],
    tools: [
      { name: "read", description: "Read", execute: noopExecute },
      { name: "codemode", description: "Codemode", reachesTools: true, execute: noopExecute },
      { name: "tool_search", description: "Search", reachesTools: true, execute: noopExecute },
    ],
  });
  const ctx = createMockContext({
    cwd: dir,
    hasUI: true,
    ui: {
      notify: (message, level) => {
        notifications.push({ message, level });
      },
    },
  });
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({
        settings: { maxRetries: 0 },
        mcpServers: {
          mock: {
            command: "node",
            args: ["--import", tsxEsmLoader, mock],
            env: {
              MOCK_INSTRUCTIONS: "Prefer search_docs before fetch_doc; cite URIs.",
            },
            lifecycle: "eager",
            description: "Mock reference server",
            exposure: "codemode",
            toolExposure: { echo: "direct", add: "deferred" },
          },
        },
      }),
    );

    await extension(mockExt.api, {
      bootstrapCwd: dir,
      globalConfigPath: join(dir, "absent-global.json"),
    });
    await mockExt.events.get("session_start")({}, ctx);

    // Both codemode and tool_search are auto-activated in deterministic order, and only echo is direct
    assert.deepEqual(mockExt.activeTools, ["read", "codemode", "tool_search", "mcp_mock_echo"]);
    const addTool = mockExt.tools.get("mcp_mock_add");
    const echoTool = mockExt.tools.get("mcp_mock_echo");
    assert.equal(addTool.exposure, "deferred");
    assert.equal(echoTool.exposure, "direct");
    assert.deepEqual(addTool.namespace, {
      name: "mcp_mock",
      aliases: ["mock", "mcp__mock"],
      description: "Mock reference server",
      instructions: "Prefer search_docs before fetch_doc; cite URIs.",
    });

    // before_agent_start populates sections.mcp_servers for connected indirect servers
    const promptSections: Record<string, string> = {};
    await mockExt.events.get("before_agent_start")({ systemPromptOptions: { sections: promptSections } }, ctx);
    assert.match(promptSections["mcp_servers"] ?? "", /- mcp_mock \(codemode, tool_search\): Mock reference server/);
    // No-op when before_agent_start carries no systemPromptOptions
    await mockExt.events.get("before_agent_start")({}, ctx);

    // Simulate tool_search loading `add` while a policy deactivates `echo` -> /mcp mock surfaces masked state
    mockExt.activeTools = ["read", "codemode", "tool_search", "mcp_mock_add"];
    notifications.length = 0;
    await mockExt.commands.get("mcp").handler("mock", ctx);
    assert.match(
      notifications.at(-1)?.message ?? "",
      /^Tools: 1\/6 active \(1 configured direct, 1 direct inactive\)$/m,
    );

    // /tree resets activeTools to an earlier turn's loadout; session_tree restores reaching
    // discovery tools without re-activating inactive direct tools (`mcp_mock_echo`)
    mockExt.activeTools = ["read"];
    await mockExt.events.get("session_tree")({}, ctx);
    assert.deepEqual(mockExt.activeTools, ["read", "codemode", "tool_search"]);

    // /mcp:stop hides every registered tool of the stopped server and marks it `not connected` in <mcp_servers>
    await mockExt.commands.get("mcp:stop").handler("mock", ctx);
    assert.equal(mockExt.tools.get("mcp_mock_echo").exposure, "hidden");
    assert.equal(mockExt.tools.get("mcp_mock_add").exposure, "hidden");
    assert.deepEqual(mockExt.activeTools, ["read", "codemode", "tool_search"]);
    await mockExt.events.get("before_agent_start")({ systemPromptOptions: { sections: promptSections } }, ctx);
    assert.match(
      promptSections["mcp_servers"] ?? "",
      /- mcp_mock \(codemode, tool_search, not connected — mcp_connect "mock"\): Mock reference server/,
    );

    // Reloading with a lazy indirect server pre-activates discovery tools at session_start before connecting,
    // while an enabled:false server only contributes once manually connected (/mcp:start) and survives /tree
    await writeFile(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({
        settings: { maxRetries: 0 },
        mcpServers: {
          lazy_docs: {
            command: "node",
            args: ["--import", tsxEsmLoader, mock],
            lifecycle: "lazy",
            exposure: "deferred",
          },
          manual_code: {
            command: "node",
            args: ["--import", tsxEsmLoader, mock],
            env: {
              MOCK_INSTRUCTIONS: "Handshake fallback line\nIgnored detail line",
            },
            enabled: false,
            exposure: "codemode",
          },
        },
      }),
    );
    mockExt.activeTools = ["read"];
    await mockExt.events.get("session_start")({}, ctx);
    // lazy_docs is enabled + deferred -> tool_search pre-activated; manual_code is enabled:false -> codemode stays off
    assert.deepEqual(mockExt.activeTools, ["read", "tool_search"]);
    await mockExt.events.get("before_agent_start")({ systemPromptOptions: { sections: promptSections } }, ctx);
    assert.match(promptSections["mcp_servers"] ?? "", /mcp_lazy_docs \(tool_search, not connected/);
    assert.ok(!(promptSections["mcp_servers"] ?? "").includes("manual_code"));

    // Manually starting enabled:false `manual_code` activates codemode, surfaces handshake instructions,
    // and survives both /tree and mcp_servers_change reconciliations
    await mockExt.commands.get("mcp:start").handler("manual_code", ctx);
    assert.deepEqual(mockExt.activeTools, ["read", "tool_search", "codemode"]);
    await mockExt.events.get("before_agent_start")({ systemPromptOptions: { sections: promptSections } }, ctx);
    assert.match(promptSections["mcp_servers"] ?? "", /- mcp_manual_code \(codemode\): Handshake fallback line/);
    mockExt.activeTools = ["read"];
    await mockExt.events.get("session_tree")({}, ctx);
    assert.deepEqual(mockExt.activeTools, ["read", "codemode", "tool_search"]);
    mockExt.activeTools = ["read"];
    mockExt.mcpServers.push({
      name: "noop_direct",
      config: { command: "node", args: ["--import", tsxEsmLoader, mock], lifecycle: "lazy" },
      extensionPath: "/ext/noop.ts",
    } as never);
    await mockExt.events.get("mcp_servers_change")({ servers: mockExt.mcpServers }, ctx);
    assert.deepEqual(mockExt.activeTools, ["read", "codemode", "tool_search"]);
    mockExt.mcpServers.length = 0;
    await mockExt.events.get("mcp_servers_change")({ servers: [] }, ctx);

    // Partial --exclude-tools (1 indirect tool excluded, others still in getAllTools) allows mcp_connect
    const origGetAllTools = mockExt.api.getAllTools.bind(mockExt.api);
    mockExt.api.getAllTools = () =>
      origGetAllTools().filter((t: { name: string }) => t.name !== "mcp_lazy_docs_echo");
    const partialRes = await mockExt.tools.get("mcp_connect").execute("c-part", { name: "lazy_docs" }, undefined, undefined, ctx);
    assert.match(partialRes.content[0].text, /MCP server lazy_docs ready/);
    await mockExt.commands.get("mcp:stop").handler("lazy_docs", ctx);

    // Full --tools filtering (no mcp_lazy_docs_* tools in getAllTools) fails mcp_connect, warns, and annotates /mcp lazy_docs + mcp_status
    mockExt.api.getAllTools = () =>
      origGetAllTools().filter((t: { name: string }) => !t.name.startsWith("mcp_lazy_docs_"));
    notifications.length = 0;
    await assert.rejects(
      () => mockExt.tools.get("mcp_connect").execute("c-filt", { name: "lazy_docs" }, undefined, undefined, ctx),
      /filtered out its indirect tools; include mcp_\* in --tools/,
    );
    assert.ok(notifications.some((n) => n.level === "warning" && n.message.includes("include mcp_* in --tools")));
    notifications.length = 0;
    await mockExt.commands.get("mcp").handler("lazy_docs", ctx);
    assert.match(
      notifications.at(-1)?.message ?? "",
      /^Tools: 0\/6 active \(0 configured direct, indirect filtered by --tools \/ --exclude-tools\)$/m,
    );
    const filteredStatusRows = JSON.parse(
      (await mockExt.tools.get("mcp_status").execute("s-filt", {}, undefined, undefined, ctx)).content[0].text,
    ) as Array<{ name: string; tools: Record<string, unknown> }>;
    assert.deepEqual(filteredStatusRows.find((r) => r.name === "lazy_docs")?.tools, {
      discovered: 6,
      active: 0,
      expected: 0,
      indirectFiltered: true,
    });
    mockExt.api.getAllTools = origGetAllTools;

    // Reloading with autoEnableCodemode: false and neither discovery tool active warns once per session
    await writeFile(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({
        autoEnableCodemode: false,
        settings: { maxRetries: 0 },
        mcpServers: {
          mock: {
            command: "node",
            args: ["--import", tsxEsmLoader, mock],
            lifecycle: "eager",
            exposure: "codemode",
          },
        },
      }),
    );
    mockExt.activeTools = ["read"];
    notifications.length = 0;
    await mockExt.events.get("session_start")({}, ctx);
    const warnings = notifications.filter((n) => n.level === "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, /\(autoEnableCodemode is false\)/);

    // Dynamic extension server registration and removal: hides unregistered tools, disambiguates
    // colliding `-` vs `_` server namespaces in both `_toolRegistry` and `<mcp_servers>`, and
    // rebinds back to the unhashed namespace once the colliding peer is removed.
    mockExt.mcpServers.push({
      name: "dyn-peer",
      config: {
        command: "node",
        args: ["--import", tsxEsmLoader, mock],
        exposure: "deferred",
        description: "Hyphen peer",
      },
      extensionPath: "/ext/dyn-hyphen.ts",
    } as never);
    await mockExt.events.get("mcp_servers_change")({ servers: mockExt.mcpServers }, ctx);
    assert.ok(mockExt.activeTools.includes("tool_search"));
    assert.equal(mockExt.tools.get("mcp_dyn_peer_echo").namespace?.name, "mcp_dyn_peer");
    assert.deepEqual(mockExt.tools.get("mcp_dyn_peer_echo").namespace?.aliases, [
      "dyn-peer",
      "mcp__dyn_peer",
    ]);

    mockExt.mcpServers.push({
      name: "dyn_peer",
      config: {
        command: "node",
        args: ["--import", tsxEsmLoader, mock],
        lifecycle: "lazy",
        exposure: "deferred",
        description: "Underscore peer",
      },
      extensionPath: "/ext/dyn-underscore.ts",
    } as never);
    await mockExt.events.get("mcp_servers_change")({ servers: mockExt.mcpServers }, ctx);
    const hyphenDisambiguated = mockExt.tools.get("mcp_dyn_peer_echo").namespace;
    assert.match(hyphenDisambiguated?.name ?? "", /^mcp_dyn_peer_[0-9a-f]{8}$/);
    assert.ok(!hyphenDisambiguated?.aliases?.includes("dyn-peer"));
    await mockExt.events.get("before_agent_start")({ systemPromptOptions: { sections: promptSections } }, ctx);
    assert.match(
      promptSections["mcp_servers"] ?? "",
      new RegExp(`- ${hyphenDisambiguated!.name} \\(tool_search\\): Hyphen peer`),
    );
    assert.match(
      promptSections["mcp_servers"] ?? "",
      /- mcp_dyn_peer \(tool_search, not connected — mcp_connect "dyn_peer"\): Underscore peer/,
    );

    // Removing `dyn_peer` restores `dyn-peer` to its canonical unhashed `mcp_dyn_peer` namespace
    mockExt.mcpServers.pop();
    await mockExt.events.get("mcp_servers_change")({ servers: mockExt.mcpServers }, ctx);
    assert.equal(mockExt.tools.get("mcp_dyn_peer_echo").namespace?.name, "mcp_dyn_peer");
    assert.deepEqual(mockExt.tools.get("mcp_dyn_peer_echo").namespace?.aliases, [
      "dyn-peer",
      "mcp__dyn_peer",
    ]);

    mockExt.mcpServers.length = 0;
    await mockExt.events.get("mcp_servers_change")({ servers: [] }, ctx);
    assert.equal(mockExt.tools.get("mcp_dyn_peer_echo").exposure, "hidden");

    await writeFile(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({ settings: { maxRetries: 0 }, mcpServers: {} }),
    );
    await mockExt.events.get("session_start")({}, ctx);
    promptSections["mcp_servers"] = "stale";
    await mockExt.events.get("before_agent_start")({ systemPromptOptions: { sections: promptSections } }, ctx);
    assert.equal("mcp_servers" in promptSections, false);
  } finally {
    await mockExt.events.get("session_shutdown")?.({}, ctx);
    await rm(dir, { recursive: true, force: true });
  }
});


