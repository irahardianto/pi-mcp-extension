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
import { formatResourceCatalog } from "../src/register-commands.js";
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

it("does not let a slow stale fetch overwrite a newer generation's cached catalog", async () => {
  const staleGate = createGate();
  let call = 0;
  const client = fakeClient({
    listResources: async () => {
      call += 1;
      const currentCall = call;
      if (currentCall === 1) await staleGate.promise;
      return { resources: [{ uri: `mock://v${currentCall}`, name: `v${currentCall}` }] };
    },
  });
  const bridge = new ResourceBridge();

  // Gen-0 request starts and stalls in flight.
  const staleInFlight = bridge.getCatalog("srv", client, OPTIONS);
  // list_changed advances generation to 1 while gen-0 is still in flight.
  bridge.invalidate("srv");
  // Gen-1 request completes first and caches v2 under generation 1.
  const fresh = await bridge.getCatalog("srv", client, OPTIONS);
  assert.deepEqual(fresh.resources.map((r) => r.uri), ["mock://v2"]);

  // Now the slow gen-0 request settles; it must NOT clobber the gen-1 cache entry.
  staleGate.open();
  const stale = await staleInFlight;
  assert.deepEqual(stale.resources.map((r) => r.uri), ["mock://v1"]);

  const cachedAfterStale = await bridge.getCatalog("srv", client, OPTIONS);
  assert.deepEqual(cachedAfterStale.resources.map((r) => r.uri), ["mock://v2"]);
  assert.equal(call, 2, "gen-1 catalog must remain cached after the slower gen-0 fetch settles");
});

it("does not resurrect a catalog fetched for a server that was forgotten mid-flight", async () => {
  const gate = createGate();
  let listCalls = 0;
  const client = fakeClient({
    listResources: async () => {
      listCalls += 1;
      if (listCalls === 1) await gate.promise;
      return { resources: [{ uri: listCalls === 1 ? "mock://dead-client" : "mock://new-client", name: "r" }] };
    },
  });
  const bridge = new ResourceBridge();

  const inFlight = bridge.getCatalog("srv", client, OPTIONS);
  bridge.forget("srv");
  gate.open();
  await inFlight;

  const afterRestart = await bridge.getCatalog("srv", client, OPTIONS);
  assert.deepEqual(afterRestart.resources.map((resource) => resource.uri), ["mock://new-client"]);
  assert.equal(listCalls, 2, "a forgotten server must not serve the previous client's catalog");
});

it("forgets a server's generation and catalog on forget()", async () => {
  const { client, calls } = pagedClient([{ resources: [{ uri: "mock://a", name: "a" }] }]);
  const bridge = new ResourceBridge();

  await bridge.getCatalog("srv", client, OPTIONS);
  bridge.forget("srv");
  await bridge.getCatalog("srv", client, OPTIONS);

  assert.equal(calls().listCalls, 2);
});

it("treats a -32601 resources/list response as no resources while keeping templates", async () => {
  const client = fakeClient({
    listResources: async () => {
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    },
    listResourceTemplates: async () => ({
      resourceTemplates: [{ uriTemplate: "mock://item/{id}", name: "item" }],
    }),
  });

  const catalog = await new ResourceBridge().getCatalog("srv", client, OPTIONS);

  assert.deepEqual(catalog.resources, []);
  assert.deepEqual(catalog.templates.map((t) => t.uriTemplate), ["mock://item/{id}"]);
});

it("stops at the 100-page guard when a malfunctioning server never clears nextCursor", async () => {
  let pages = 0;
  const client = fakeClient({
    listResources: async () => {
      pages += 1;
      return { resources: [{ uri: `mock://p/${pages}`, name: `p${pages}` }], nextCursor: `cursor-${pages}` };
    },
  });

  const catalog = await new ResourceBridge().getCatalog("srv", client, OPTIONS);

  assert.equal(pages, 100);
  assert.equal(catalog.resources.length, 100);
});

it("falls back to client.request when typed SDK resource helpers are absent", async () => {
  const methods: string[] = [];
  const client = {
    request: async (req: { method: string; params?: Record<string, unknown> }) => {
      methods.push(req.method);
      if (req.method === "resources/list") {
        return { resources: [{ uri: "mock://raw", name: "raw" }] };
      }
      if (req.method === "resources/templates/list") {
        return { resourceTemplates: [{ uriTemplate: "mock://tpl/{id}", name: "tpl" }] };
      }
      return { contents: [{ uri: String(req.params?.["uri"] ?? ""), text: "raw body" }] };
    },
  } as unknown as Client;
  const bridge = new ResourceBridge();

  const catalog = await bridge.getCatalog("srv", client, OPTIONS);
  const content = await bridge.readResource("srv", client, "mock://raw", OPTIONS);

  assert.deepEqual(catalog.resources.map((r) => r.uri), ["mock://raw"]);
  assert.deepEqual(catalog.templates.map((t) => t.uriTemplate), ["mock://tpl/{id}"]);
  assert.deepEqual(content, [{ type: "text", text: "raw body" }]);
  assert.deepEqual(methods, ["resources/list", "resources/templates/list", "resources/read"]);
});

it("converts text, empty text, image and binary resource contents", async () => {
  const client = fakeClient({
    readResource: async ({ uri }: { uri: string }) => ({
      contents: [
        { uri, mimeType: "text/plain", text: "" },
        { uri, mimeType: "text/markdown", text: "# Title" },
        { uri: "mock://image", mimeType: "image/png", blob: TINY_PNG },
        { uri: "mock://bin", mimeType: "application/octet-stream", blob: "AAECAwQ=" },
        { uri: "mock://untyped-bin", blob: "AAEC" },
      ],
    }),
  });

  const content = await new ResourceBridge().readResource("srv", client, "mock://docs", OPTIONS);

  assert.deepEqual(content, [
    { type: "text", text: "" },
    { type: "text", text: "# Title" },
    { type: "image", data: TINY_PNG, mimeType: "image/png" },
    { type: "text", text: "[Binary resource: mock://bin (application/octet-stream, 5 bytes)]" },
    { type: "text", text: "[Binary resource: mock://untyped-bin (application/octet-stream, 3 bytes)]" },
  ]);
});

it("falls back to a URI placeholder or string coercion for unrecognised content entries", () => {
  assert.deepEqual(convertResourceContents([{ uri: "mock://odd" }, null, "raw"]), [
    { type: "text", text: "[Resource: mock://odd]" },
    { type: "text", text: "null" },
    { type: "text", text: "raw" },
  ]);
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

it("redacts secrets and strips terminal escape sequences in resource failure messages", async () => {
  const client = fakeClient({
    readResource: async () => {
      throw new Error("GET https://api.example.com/resource?api_key=sk-secret-value-123 failed: \x1b[31mboom\x1b[0m");
    },
  });

  await assert.rejects(
    new ResourceBridge().readResource("srv", client, "mock://secret", OPTIONS),
    (err: unknown) => {
      assert.ok(err instanceof McpError);
      assert.ok(!err.message.includes("sk-secret-value-123"), "secret query parameter must be redacted");
      assert.ok(!err.message.includes("\x1b"), "ANSI escape sequence must be stripped");
      assert.match(err.message, /\[REDACTED\]/);
      return true;
    },
  );
});

it("sanitizes ANSI escape sequences in /mcp:resources catalog rendering", () => {
  const text = formatResourceCatalog("srv\x1b[31m", {
    resources: [
      {
        uri: "mock://\x1b[32mdoc",
        name: "name\x1b[0m",
        description: "desc\x1b]0;pwn\x07",
        mimeType: "text/\x1b[1mplain",
      },
    ],
    templates: [],
  });

  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text), "catalog output must not contain control characters");
  assert.match(text, /mock:\/\/doc — desc — text\/plain/);
});

it("bounds the /mcp:resources catalog rendering for a huge catalog", () => {
  const resources = Array.from({ length: 5000 }, (_, index) => ({ uri: `mock://r/${index}`, name: `r${index}` }));

  const text = formatResourceCatalog("srv", { resources, templates: [] });

  const lines = text.split("\n");
  assert.equal(lines.length, 52, "header + 50 rows + one summary line");
  assert.match(text, /5000 resource\(s\)/);
  assert.match(lines.at(-1) ?? "", /… and 4950 more/);
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

async function startMockSession(extraServers: Record<string, unknown> = {}): Promise<MockSession> {
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
        ...extraServers,
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

interface ListedResources {
  servers: Array<{ server: string; resources: ResourceItem[]; templates: TemplateItem[]; resourcesUnsupported?: boolean; error?: string }>;
  stoppedServers: string[];
}

/**
 * Poll `mcp_list_resources` until the catalog shows `expected` resources for its first row.
 * The list_changed notification travels over stdio, so there is no promise to await; polling a
 * bounded deadline beats a fixed sleep that flakes when the round trip is slower than it.
 */
async function waitForCatalogRows(
  listResources: () => Promise<ListedResources>,
  expected: number,
): Promise<ListedResources> {
  const deadline = Date.now() + 5000;
  let last = await listResources();
  while ((last.servers[0]?.resources.length ?? 0) !== expected) {
    if (Date.now() > deadline) {
      throw new Error(`catalog did not reach ${expected} resources within 5s (last: ${last.servers[0]?.resources.length ?? 0})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    last = await listResources();
  }
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

    const abortedController = new AbortController();
    abortedController.abort();
    await assert.rejects(
      mockExt.tools.get("mcp_list_resources").execute("", {}, abortedController.signal, undefined, ctx),
      (err: unknown) => err instanceof AuthCancelledError,
    );

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

it("keeps healthy catalogs when one server fails and notes a capability-less server", async () => {
  const mockServerEntry = (env: Record<string, string>) => ({
    command: "node",
    args: ["--import", TSX_ESM_LOADER, MOCK_SERVER_PATH],
    lifecycle: "lazy",
    env,
  });
  const session = await startMockSession({
    broken: mockServerEntry({ MOCK_FAIL_RESOURCES: "1" }),
    plain: mockServerEntry({ MOCK_NO_RESOURCES: "1" }),
  });
  const { extension: mockExt, ctx } = session;
  try {
    for (const name of ["mock", "broken", "plain"]) {
      await mockExt.tools.get("mcp_connect").execute("", { name }, undefined, undefined, ctx);
    }
    const listed: ListedResources = JSON.parse(
      (await mockExt.tools.get("mcp_list_resources").execute("", {}, undefined, undefined, ctx)).content[0].text,
    );
    const rows = new Map(listed.servers.map((row) => [row.server, row]));
    assert.equal(rows.get("mock")?.resources.length, 4, "a failing server must not hide a healthy catalog");
    assert.match(rows.get("broken")?.error ?? "", /MCP resource request failed for broken/);
    assert.deepEqual(rows.get("broken")?.resources, []);
    assert.equal(rows.get("plain")?.resourcesUnsupported, true, "a capability-less server is reported, not asked");
    assert.deepEqual(listed.stoppedServers, ["other"]);

    await assert.rejects(
      mockExt.tools.get("mcp_read_resource").execute("", { server: "plain", uri: "mock://docs/readme" }, undefined, undefined, ctx),
      /does not expose MCP resources/,
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
    const afterChange = await waitForCatalogRows(listResources, 5);
    assert.ok(
      afterChange.servers[0]?.resources.some((resource) => resource.uri === "mock://generated/1"),
      "a cached catalog must not survive list_changed",
    );
  } finally {
    await stopMockSession(session);
  }
});

it("serves /mcp:resources summaries, listings, reads, and errors", async () => {
  const session = await startMockSession();
  const { extension: mockExt, ctx } = session;
  try {
    const command = mockExt.commands.get("mcp:resources");
    assert.ok(command, "mcp:resources must be registered");

    await command.handler("", ctx);
    assert.match(lastNotification(session).message, /No connected MCP servers/);

    await mockExt.tools.get("mcp_connect").execute("", { name: "mock" }, undefined, undefined, ctx);

    await command.handler("", ctx);
    assert.match(lastNotification(session).message, /pi-mcp: MCP resources\n {2}mock — 4 resource\(s\), 1 template\(s\)/);

    await command.handler("mock", ctx);
    assert.match(lastNotification(session).message, /mock:\/\/docs\/readme — Mock readme document — text\/markdown/);
    assert.match(lastNotification(session).message, /mock:\/\/item\/\{id\} — Item by id — application\/json/);

    await command.handler("mock mock://docs/readme", ctx);
    assert.match(lastNotification(session).message, /Hello from the mock resource/);

    await command.handler("mock mock://empty", ctx);
    assert.match(lastNotification(session).message, /\(empty resource\)/);

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
