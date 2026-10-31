/**
 * MCP resource bridge tests.
 *
 * Unit tests drive {@link ResourceBridge} with a fake SDK client (pagination, caching,
 * invalidation, conversion), and integration tests drive the real extension against
 * `tests/mock-server.ts` over stdio for `mcp_list_resources`, `mcp_read_resource`, and
 * `/mcp:resources`.
 */

import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import extension from "../src/index.js";
import { ResourceBridge, convertResourceContents } from "../src/resource-bridge.js";
import { AuthCancelledError, McpError } from "../src/errors.js";
import { createMockExtension, createMockContext } from "./helpers/mock-extension.js";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const OPTIONS = { requestTimeoutMs: 1000 };

interface ResourceItem {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface TemplateItem {
  uriTemplate: string;
  name: string;
}

type ResourcePage = { resources: ResourceItem[]; nextCursor?: string };
type TemplatePage = { resourceTemplates: TemplateItem[]; nextCursor?: string };

function fakeClient(overrides: Record<string, unknown>): Client {
  return {
    listResources: async () => ({ resources: [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
    readResource: async () => ({ contents: [] }),
    ...overrides,
  } as unknown as Client;
}

/** Cursor-paging fake: each page index is a cursor value, so `cursor: "1"` is page 2. */
function pagedClient(resourcePages: ResourcePage[], templatePages: TemplatePage[] = []) {
  let listCalls = 0;
  let templateCalls = 0;
  const client = fakeClient({
    listResources: async (params?: { cursor?: string }) => {
      listCalls += 1;
      return resourcePages[Number(params?.cursor ?? "0")] ?? { resources: [] };
    },
    listResourceTemplates: async (params?: { cursor?: string }) => {
      templateCalls += 1;
      return templatePages[Number(params?.cursor ?? "0")] ?? { resourceTemplates: [] };
    },
  });
  return { client, calls: () => ({ listCalls, templateCalls }) };
}

function createGate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

// ─── Unit: discovery, caching, failure mapping ───────────────────────────────

it("paginates resources/list and resources/templates/list", async () => {
  const { client, calls } = pagedClient(
    [
      { resources: [{ uri: "mock://a", name: "a" }, { uri: "mock://b", name: "b" }], nextCursor: "1" },
      { resources: [{ uri: "mock://c", name: "c" }] },
    ],
    [{ resourceTemplates: [{ uriTemplate: "mock://item/{id}", name: "item" }] }],
  );

  const catalog = await new ResourceBridge().getCatalog("srv", client, OPTIONS);

  assert.deepEqual(catalog.resources.map((resource) => resource.uri), ["mock://a", "mock://b", "mock://c"]);
  assert.deepEqual(catalog.templates.map((template) => template.uriTemplate), ["mock://item/{id}"]);
  assert.deepEqual(calls(), { listCalls: 2, templateCalls: 1 });
});

it("stops paginating on an empty nextCursor instead of requesting another page", async () => {
  const { client, calls } = pagedClient([{ resources: [{ uri: "mock://a", name: "a" }], nextCursor: "" }]);

  const catalog = await new ResourceBridge().getCatalog("srv", client, OPTIONS);

  assert.equal(catalog.resources.length, 1);
  assert.equal(calls().listCalls, 1);
});

it("treats a -32601 resources/templates/list response as no templates", async () => {
  const client = fakeClient({
    listResources: async () => ({ resources: [{ uri: "mock://a", name: "a" }] }),
    listResourceTemplates: async () => {
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    },
  });

  const catalog = await new ResourceBridge().getCatalog("srv", client, OPTIONS);

  assert.deepEqual(catalog.resources.map((resource) => resource.uri), ["mock://a"]);
  assert.deepEqual(catalog.templates, []);
});

it("serves the cached catalog until a list_changed invalidation", async () => {
  const { client, calls } = pagedClient([{ resources: [{ uri: "mock://a", name: "a" }] }]);
  const bridge = new ResourceBridge();

  await bridge.getCatalog("srv", client, OPTIONS);
  await bridge.getCatalog("srv", client, OPTIONS);
  assert.deepEqual(calls(), { listCalls: 1, templateCalls: 1 }, "second read must come from the cache");

  bridge.invalidate("srv");
  await bridge.getCatalog("srv", client, OPTIONS);
  assert.deepEqual(calls(), { listCalls: 2, templateCalls: 2 }, "invalidation must refetch");
});

it("discards a catalog that finished after a list_changed invalidated it", async () => {
  const gate = createGate();
  let listCalls = 0;
  const client = fakeClient({
    listResources: async () => {
      listCalls += 1;
      if (listCalls === 1) await gate.promise;
      return { resources: [{ uri: listCalls === 1 ? "mock://stale" : "mock://fresh", name: "r" }] };
    },
  });
  const bridge = new ResourceBridge();

  const inFlight = bridge.getCatalog("srv", client, OPTIONS);
  bridge.invalidate("srv");
  gate.open();

  const staleReply = await inFlight;
  assert.deepEqual(staleReply.resources.map((resource) => resource.uri), ["mock://stale"]);

  const next = await bridge.getCatalog("srv", client, OPTIONS);
  assert.deepEqual(next.resources.map((resource) => resource.uri), ["mock://fresh"]);
  assert.equal(listCalls, 2, "the invalidated response must not have been cached");
});

it("forgets a server's generation and catalog on forget()", async () => {
  const { client, calls } = pagedClient([{ resources: [{ uri: "mock://a", name: "a" }] }]);
  const bridge = new ResourceBridge();

  await bridge.getCatalog("srv", client, OPTIONS);
  bridge.forget("srv");
  await bridge.getCatalog("srv", client, OPTIONS);

  assert.equal(calls().listCalls, 2);
});

it("converts text, empty text, image and binary resource contents", async () => {
  const client = fakeClient({
    readResource: async ({ uri }: { uri: string }) => ({
      contents: [
        { uri, mimeType: "text/plain", text: "" },
        { uri, mimeType: "text/markdown", text: "# Title" },
        { uri: "mock://image", mimeType: "image/png", blob: TINY_PNG },
        { uri: "mock://bin", mimeType: "application/octet-stream", blob: "AAECAwQ=" },
      ],
    }),
  });

  const content = await new ResourceBridge().readResource("srv", client, "mock://docs", OPTIONS);

  assert.deepEqual(content, [
    { type: "text", text: "" },
    { type: "text", text: "# Title" },
    { type: "image", data: TINY_PNG, mimeType: "image/png" },
    { type: "text", text: "[Binary resource: mock://bin (application/octet-stream, 5 bytes)]" },
  ]);
});

it("falls back to a URI placeholder for an unrecognised content entry", () => {
  assert.deepEqual(convertResourceContents([{ uri: "mock://odd" }]), [{ type: "text", text: "[Resource: mock://odd]" }]);
});

it("rejects an already-aborted catalog request as a cancellation", async () => {
  const { client } = pagedClient([{ resources: [{ uri: "mock://a", name: "a" }] }]);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    new ResourceBridge().getCatalog("srv", client, { requestTimeoutMs: 1000, signal: controller.signal }),
    (err: unknown) => err instanceof AuthCancelledError,
  );
});

it("maps an SDK request timeout to McpError(\"timeout\")", async () => {
  const client = fakeClient({
    readResource: async () => {
      throw Object.assign(new Error("Request timed out"), { code: -32001 });
    },
  });

  await assert.rejects(
    new ResourceBridge().readResource("srv", client, "mock://slow", OPTIONS),
    (err: unknown) => err instanceof McpError && err.code === "timeout",
  );
});

it("routes a 401 during resources/read to the auth callback", async () => {
  const client = fakeClient({
    readResource: async () => {
      throw new Error("HTTP 401 Unauthorized");
    },
  });
  const bridge = new ResourceBridge();
  const authErrors: string[] = [];
  bridge.setAuthErrorCallback((serverName) => {
    authErrors.push(serverName);
  });

  await assert.rejects(
    bridge.readResource("srv", client, "mock://secret", OPTIONS),
    (err: unknown) => err instanceof McpError && err.code === "protocol",
  );
  assert.deepEqual(authErrors, ["srv"]);
});

// ─── Integration: extension tools and slash command ──────────────────────────

const MOCK_SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), "mock-server.ts");
const TSX_ESM_LOADER = import.meta.resolve("tsx/esm");

interface MockSession {
  dir: string;
  extension: ReturnType<typeof createMockExtension>;
  ctx: ReturnType<typeof createMockContext>;
  notifications: Array<{ message: string; type?: "info" | "warning" | "error" }>;
}

async function startMockSession(): Promise<MockSession> {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-resources-"));
  const notifications: MockSession["notifications"] = [];
  await mkdir(join(dir, ".pi"));
  await writeFile(
    join(dir, ".pi", "mcp.json"),
    JSON.stringify({
      settings: { maxRetries: 0 },
      mcpServers: {
        mock: { command: "node", args: ["--import", TSX_ESM_LOADER, MOCK_SERVER_PATH], lifecycle: "lazy" },
        other: { command: "node", args: ["--import", TSX_ESM_LOADER, MOCK_SERVER_PATH], lifecycle: "lazy" },
      },
    }),
  );
  const mockExt = createMockExtension();
  const ctx = createMockContext({
    cwd: dir,
    hasUI: false,
    ui: {
      notify: (message, type) => {
        notifications.push(type ? { message, type } : { message });
      },
    },
  });
  await extension(mockExt.api, { bootstrapCwd: dir, globalConfigPath: join(dir, "absent-global.json") });
  await mockExt.events.get("session_start")({}, ctx);
  return { dir, extension: mockExt, ctx, notifications };
}

async function stopMockSession(session: MockSession): Promise<void> {
  await session.extension.events.get("session_shutdown")({}, session.ctx);
  await rm(session.dir, { recursive: true, force: true });
}

function lastNotification(session: MockSession): { message: string; type?: "info" | "warning" | "error" } {
  const last = session.notifications.at(-1);
  assert.ok(last, "expected a UI notification");
  return last;
}

it("lists and reads mock-server resources through the agent tools", async () => {
  const session = await startMockSession();
  const { extension: mockExt, ctx } = session;
  try {
    await mockExt.tools.get("mcp_connect").execute("", { name: "mock" }, undefined, undefined, ctx);

    const listResources = async (params: Record<string, unknown>) =>
      JSON.parse(
        (await mockExt.tools.get("mcp_list_resources").execute("", params, undefined, undefined, ctx)).content[0].text,
      );

    const all = await listResources({});
    assert.deepEqual(all.servers.map((row: { server: string }) => row.server), ["mock"]);
    assert.deepEqual(all.servers[0].resources.map((resource: ResourceItem) => resource.uri), [
      "mock://docs/readme",
      "mock://empty",
      "mock://image",
      "mock://binary",
    ]);
    assert.deepEqual(all.servers[0].templates.map((template: TemplateItem) => template.uriTemplate), ["mock://item/{id}"]);
    assert.deepEqual(all.stoppedServers, ["other"]);

    const filtered = await listResources({ server: "mock" });
    assert.equal(filtered.servers.length, 1);
    assert.deepEqual(filtered.stoppedServers, []);
    await assert.rejects(listResources({ server: "other" }), /is not connected/);
    await assert.rejects(listResources({ server: "missing" }), /Unknown MCP server name/);

    const read = async (uri: string) =>
      (await mockExt.tools.get("mcp_read_resource").execute("", { server: "mock", uri }, undefined, undefined, ctx)).content;

    assert.deepEqual(await read("mock://docs/readme"), [
      { type: "text", text: "# Mock readme\n\nHello from the mock resource." },
    ]);
    assert.deepEqual(await read("mock://empty"), [{ type: "text", text: "" }]);
    assert.deepEqual(await read("mock://image"), [{ type: "image", data: TINY_PNG, mimeType: "image/png" }]);
    assert.equal((await read("mock://binary"))[0]?.text, "[Binary resource: mock://binary (application/octet-stream, 5 bytes)]");
    assert.deepEqual(JSON.parse((await read("mock://item/42"))[0]?.text ?? ""), { id: "42" });

    await assert.rejects(read("mock://nope"), /MCP resource request failed for mock/);
    await assert.rejects(
      mockExt.tools.get("mcp_read_resource").execute("", { server: "missing", uri: "mock://x" }, undefined, undefined, ctx),
      /Unknown MCP server name/,
    );
  } finally {
    await stopMockSession(session);
  }
});

it("re-lists resources after notifications/resources/list_changed", async () => {
  const session = await startMockSession();
  const { extension: mockExt, ctx } = session;
  try {
    await mockExt.tools.get("mcp_connect").execute("", { name: "mock" }, undefined, undefined, ctx);
    const listResources = async () =>
      JSON.parse(
        (await mockExt.tools.get("mcp_list_resources").execute("", {}, undefined, undefined, ctx)).content[0].text,
      );
    assert.equal((await listResources()).servers[0].resources.length, 4);

    const addResourceTool = [...mockExt.tools.keys()].find((name) => name.includes("add_resource"));
    assert.ok(addResourceTool, "mock server must expose add_resource");
    await mockExt.tools.get(addResourceTool).execute("", {}, undefined, undefined, ctx);
    // The notification is handled asynchronously over stdio; give it one round trip to land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const afterChange = await listResources();
    assert.equal(afterChange.servers[0].resources.length, 5, "a cached catalog must not survive list_changed");
    assert.ok(afterChange.servers[0].resources.some((resource: ResourceItem) => resource.uri === "mock://generated/1"));
  } finally {
    await stopMockSession(session);
  }
});

it("serves /mcp:resources summaries, listings, reads, and errors", async () => {
  const session = await startMockSession();
  const { extension: mockExt, ctx } = session;
  try {
    await mockExt.tools.get("mcp_connect").execute("", { name: "mock" }, undefined, undefined, ctx);
    const command = mockExt.commands.get("mcp:resources");
    assert.ok(command, "mcp:resources must be registered");

    await command.handler("", ctx);
    assert.match(lastNotification(session).message, /pi-mcp: MCP resources\n {2}mock — 4 resource\(s\), 1 template\(s\)/);

    await command.handler("mock", ctx);
    assert.match(lastNotification(session).message, /mock:\/\/docs\/readme — Mock readme document — text\/markdown/);
    assert.match(lastNotification(session).message, /mock:\/\/item\/\{id\} — Item by id — application\/json/);

    await command.handler("mock mock://docs/readme", ctx);
    assert.match(lastNotification(session).message, /Hello from the mock resource/);

    await command.handler("mock mock://image", ctx);
    assert.match(lastNotification(session).message, /\[image image\/png, \d+ base64 chars\]/);

    await command.handler("missing", ctx);
    assert.match(lastNotification(session).message, /No server named "missing"/);
    assert.equal(lastNotification(session).type, "error");

    await command.handler("other", ctx);
    assert.match(lastNotification(session).message, /other is not connected/);

    await command.handler("mock mock://nope", ctx);
    assert.match(lastNotification(session).message, /Failed to read mock:\/\/nope/);
    assert.equal(lastNotification(session).type, "error");
  } finally {
    await stopMockSession(session);
  }
});
