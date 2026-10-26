import type { RegisteredMcpServer } from "@earendil-works/pi-coding-agent";
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import extension from "../src/index.js";
import { statePath } from "../src/auth-lock.js";
import { McpOAuthProvider } from "../src/oauth-provider.js";
import { createMockExtension, createMockContext } from "./helpers/mock-extension.js";

const mockServerPath = join(dirname(fileURLToPath(import.meta.url)), "mock-server.ts");
const tsxEsmLoader = import.meta.resolve("tsx/esm");

function stdioServer(): RegisteredMcpServer["config"] {
  return { command: "node", args: ["--import", tsxEsmLoader, mockServerPath] };
}

/** Silence the headless diagnostic fallback (`console.error`) around an expected failure. */
async function withoutStderr<T>(run: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
}

/** The `/mcp <name>` detail notification, ignoring unrelated diagnostics. */
function detailFor(messages: string[], serverName: string): string {
  return messages.find((message) => message.includes(`Server: ${serverName}\n`)) ?? "";
}

async function readStatusRows(
  tools: ReturnType<typeof createMockExtension>["tools"],
  ctx: ReturnType<typeof createMockContext>,
): Promise<Array<{ name: string; source?: string; auth?: string; error?: string }>> {
  const result = await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx);
  return JSON.parse(result.content[0].text);
}

it("reports config provenance, tool activation, and an untrusted project in /mcp <name> and mcp_status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-status-provenance-"));
  const mockExt = createMockExtension({
    mcpServers: [
      { name: "ext-srv", config: stdioServer(), extensionPath: "/ext/a.ts" },
      { name: "shared-srv", config: stdioServer(), extensionPath: "/ext/a.ts" },
    ],
  });
  const commands = mockExt.commands;
  const tools = mockExt.tools;
  const events = mockExt.events;
  const messages: string[] = [];
  const ui = { notify: (message: string) => messages.push(message) };
  const ctx = createMockContext({ cwd: dir, hasUI: true, isProjectTrusted: true, ui });
  const detail = async (serverName: string, target: typeof ctx): Promise<string> => {
    messages.length = 0;
    await commands.get("mcp").handler(serverName, target);
    return detailFor(messages, serverName);
  };

  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(
      join(dir, "global.json"),
      JSON.stringify({
        settings: { maxRetries: 0 },
        mcpServers: { "global-srv": stdioServer(), "shared-srv": stdioServer() },
      }),
    );
    await writeFile(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({
        settings: { maxRetries: 0 },
        mcpServers: { "project-srv": stdioServer(), "shared-srv": stdioServer() },
      }),
    );

    await extension(mockExt.api, { bootstrapCwd: dir, globalConfigPath: join(dir, "global.json") });
    await events.get("session_start")({}, ctx);

    const projectDetail = await detail("project-srv", ctx);
    assert.match(projectDetail, /^Source: project$/m);
    assert.match(projectDetail, /^Transport: stdio$/m);
    assert.match(projectDetail, /^Lifecycle: lazy$/m);
    assert.match(projectDetail, /^Tools: 0\/0 active$/m);
    assert.match(await detail("global-srv", ctx), /^Source: global$/m);
    assert.match(await detail("shared-srv", ctx), /^Source: project$/m);
    assert.match(await detail("ext-srv", ctx), /^Source: extension$/m);

    const rows = await readStatusRows(tools, ctx);
    assert.deepEqual(
      Object.fromEntries(rows.map((row) => [row.name, row.source])),
      {
        "global-srv": "global",
        "project-srv": "project",
        "shared-srv": "project",
        "ext-srv": "extension",
      },
    );

    // A connected server reports its live activation counts in the detail view.
    await tools.get("mcp_connect").execute("", { name: "ext-srv" }, undefined, undefined, ctx);
    const discovered = mockExt.activeTools.length;
    assert.ok(discovered > 0);
    const connectedDetail = await detail("ext-srv", ctx);
    assert.match(connectedDetail, new RegExp(`^Tools: ${discovered}/${discovered} active$`, "m"));
    assert.match(connectedDetail, /^State:  ready$/m);
    assert.doesNotMatch(connectedDetail, /^OAuth:/m);

    // An untrusted project drops its servers, falls back to the global entry for a shared name,
    // and explains in the detail view why .pi/mcp.json was not loaded.
    const untrusted = createMockContext({ cwd: dir, hasUI: true, isProjectTrusted: false, ui });
    await events.get("session_start")({}, untrusted);
    const untrustedDetail = await detail("global-srv", untrusted);
    assert.match(untrustedDetail, /^Project config: not loaded .*not trusted/m);
    assert.match(await detail("shared-srv", untrusted), /^Source: global$/m);

    messages.length = 0;
    await commands.get("mcp").handler("project-srv", untrusted);
    assert.ok(messages.some((message) => /No server named "project-srv"/.test(message)));
    const untrustedRows = await readStatusRows(tools, untrusted);
    assert.deepEqual(
      Object.fromEntries(untrustedRows.map((row) => [row.name, row.source])),
      { "global-srv": "global", "shared-srv": "global", "ext-srv": "extension" },
    );
  } finally {
    await events.get("session_shutdown")?.({}, ctx);
    await rm(dir, { recursive: true, force: true });
  }
});

it("surfaces a failure hint and keeps a corrupt OAuth state file isolated in /mcp <name>", async () => {
  const { startFakeOAuthServer } = await import("./helpers/fake-oauth-server.js");
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-status-failure-"));
  const authDir = join(dir, "auth");
  const fakeServer = await startFakeOAuthServer({ serverName: "oauth-srv", toolName: "oauth_echo" });
  const mockExt = createMockExtension();
  const commands = mockExt.commands;
  const tools = mockExt.tools;
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
  const detail = async (serverName: string): Promise<string> => {
    messages.length = 0;
    await commands.get("mcp").handler(serverName, ctx);
    return detailFor(messages, serverName);
  };

  try {
    await mkdir(join(dir, ".pi"));
    await mkdir(authDir, { recursive: true });
    await writeFile(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({
        settings: { maxRetries: 0 },
        mcpServers: {
          broken: { command: "missing-pi-mcp-executable", lifecycle: "lazy" },
          "oauth-srv": { transport: "streamable-http", url: fakeServer.mcpUrl, auth: { type: "oauth" }, lifecycle: "lazy" },
          "oauth-good": { transport: "streamable-http", url: fakeServer.mcpUrl, auth: { type: "oauth" }, lifecycle: "lazy" },
        },
      }),
    );

    // Corrupt stored state for one server, valid stored tokens for another.
    await writeFile(statePath("oauth-srv", authDir), "{corrupt-json-state", "utf8");
    const provider = new McpOAuthProvider({ serverName: "oauth-good", authConfig: { type: "oauth" }, storageDir: authDir });
    await provider.saveTokens({ access_token: "stored-token", token_type: "Bearer" });

    await extension(mockExt.api, {
      bootstrapCwd: dir,
      globalConfigPath: join(dir, "no-global.json"),
      authStorageDir: authDir,
      browserOpen: fakeServer.browserOpen,
    });
    await events.get("session_start")({}, ctx);

    await assert.rejects(
      tools.get("mcp_connect").execute("", { name: "broken" }, undefined, undefined, ctx),
      /MCP connection failed/,
    );
    const brokenDetail = await detail("broken");
    assert.match(brokenDetail, /^Last error: .+$/m);
    assert.match(brokenDetail, /^Hint: run with PI_MCP_DEBUG=1 pi/m);
    assert.match(brokenDetail, /^Source: project$/m);

    // A corrupt state file is reported as backed up, and never breaks the view.
    const corruptDetail = await detail("oauth-srv");
    assert.match(corruptDetail, /^OAuth: corrupt state file backed up \(re-auth required\)$/m);
    assert.match(await detail("oauth-good"), /^OAuth: credentials stored$/m);

    // Reading the corrupt file backs it up and deletes it, so re-seed it before
    // asserting that the same isolation holds for the mcp_status tool.
    await writeFile(statePath("oauth-srv", authDir), "{corrupt-json-state", "utf8");
    const rows = await readStatusRows(tools, ctx);
    const byName = new Map(rows.map((row) => [row.name, row]));
    assert.equal(byName.get("oauth-srv")?.auth, "corrupt state file backed up (re-auth required)");
    assert.equal(byName.get("oauth-good")?.auth, "credentials stored");
    assert.equal(byName.get("broken")?.error, "Connection failed; use mcp_connect to retry");
  } finally {
    await events.get("session_shutdown")?.({}, ctx);
    await fakeServer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("points a headless authorization failure at /mcp:auth", async () => {
  const { createServer } = await import("node:http");
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-status-auth-"));
  let base = "";
  const listener = createServer((req, res) => {
    if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }));
    } else if (req.url === "/.well-known/oauth-authorization-server") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] }));
    } else {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" });
      res.end("auth required");
    }
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  const mockExt = createMockExtension();
  const commands = mockExt.commands;
  const tools = mockExt.tools;
  const events = mockExt.events;
  const messages: string[] = [];
  const ctx = createMockContext({
    cwd: dir,
    hasUI: false,
    ui: { notify: (message: string) => messages.push(message) },
  });

  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({
        settings: { maxRetries: 0 },
        mcpServers: {
          headless: { transport: "streamable-http", url: `${base}/mcp`, auth: { type: "oauth", clientId: "local" }, lifecycle: "lazy" },
        },
      }),
    );
    await extension(mockExt.api, {
      bootstrapCwd: dir,
      globalConfigPath: join(dir, "no-global.json"),
      authStorageDir: join(dir, "auth"),
    });
    await events.get("session_start")({}, ctx);
    await withoutStderr(() => assert.rejects(
      tools.get("mcp_connect").execute("", { name: "headless" }, undefined, undefined, ctx),
      /requires an interactive Pi session/,
    ));

    messages.length = 0;
    await commands.get("mcp").handler("headless", ctx);
    const detail = detailFor(messages, "headless");
    assert.match(detail, /^OAuth: authorization may be required$/m);
    assert.match(detail, /^Hint: run \/mcp:auth headless \(or \/mcp:auth headless --reset if stored credentials expired\)$/m);
  } finally {
    await events.get("session_shutdown")?.({}, ctx);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
