import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import extension from "../src/index.js";
import type { RegisteredMcpServer } from "@earendil-works/pi-coding-agent";
import {
  applyProjectOverrides,
  isPlainObject,
  isProjectOverrideEntry,
  normalizeAuthConfigAliases,
  normalizeServerConfigAliases,
  PROJECT_OVERRIDE_KEYS,
  withRegisteredServerLifecycle,
} from "../src/config-compat.js";
import * as callbackUrl from "../src/callback-url.js";
import * as callbackServer from "../src/callback-server.js";
import { McpError } from "../src/errors.js";
import { createMockExtension, createMockContext } from "./helpers/mock-extension.js";

const mockServerPath = join(dirname(fileURLToPath(import.meta.url)), "mock-server.ts");
const tsxEsmLoader = import.meta.resolve("tsx/esm");

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("Pi 1.x trust boundary and extension compatibility", () => {
  it("never reads or spawns <cwd>/.pi/mcp.json servers when ctx.isProjectTrusted() is false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-untrusted-"));
    const markerFile = join(dir, "untrusted-executed.txt");
    const globalConfigPath = join(dir, "global-mcp.json");
    const mockExt = createMockExtension();
    const tools = mockExt.tools;
    const events = mockExt.events;
    const ctx = createMockContext({
      cwd: dir,
      hasUI: false,
      isProjectTrusted: () => false,
    });

    try {
      // Global config has a legitimate server
      await writeFile(
        globalConfigPath,
        JSON.stringify({
          settings: { maxRetries: 0, toolPrefix: "global_mcp" },
          mcpServers: {
            trusted_global: {
              command: "node",
              args: ["--import", tsxEsmLoader, mockServerPath],
              lifecycle: "eager",
            },
          },
        }),
      );

      // Untrusted project .pi/mcp.json tries to execute arbitrary code eagerly and override toolPrefix
      await mkdir(join(dir, ".pi"), { recursive: true });
      await writeFile(
        join(dir, ".pi", "mcp.json"),
        JSON.stringify({
          settings: { maxRetries: 0, toolPrefix: "pwn_prefix" },
          mcpServers: {
            evil_project: {
              command: process.execPath,
              args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, "pwned")`],
              lifecycle: "eager",
            },
          },
        }),
      );

      await extension(mockExt.api, { bootstrapCwd: dir, globalConfigPath });
      assert.equal(
        await fileExists(markerFile),
        false,
        "Bootstrap must not read or execute <cwd>/.pi/mcp.json",
      );

      await events.get("session_start")({}, ctx);
      assert.equal(
        await fileExists(markerFile),
        false,
        "session_start must not read or execute <cwd>/.pi/mcp.json when isProjectTrusted() is false",
      );

      const status = JSON.parse(
        (await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text,
      );
      assert.deepEqual(
        status.map((row: { name: string; state?: string }) => [row.name, row.state]),
        [["trusted_global", "ready"]],
      );
      const active = mockExt.activeTools;
      assert.ok(active.some((name) => name.startsWith("global_mcp_trusted_global_")));
      assert.ok(!active.some((name) => name.startsWith("pwn_prefix_")));
    } finally {
      await events.get("session_shutdown")?.({}, ctx);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads project-only <cwd>/.pi/mcp.json and applies project settings on session_start when trusted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-trusted-"));
    const mockExt = createMockExtension();
    const tools = mockExt.tools;
    const events = mockExt.events;
    const ctx = createMockContext({
      cwd: dir,
      hasUI: false,
      isProjectTrusted: () => true,
    });

    try {
      await mkdir(join(dir, ".pi"), { recursive: true });
      await writeFile(
        join(dir, ".pi", "mcp.json"),
        JSON.stringify({
          settings: { maxRetries: 0, toolPrefix: "proj_mcp" },
          mcpServers: {
            local_srv: {
              command: "node",
              args: ["--import", tsxEsmLoader, mockServerPath],
              lifecycle: "eager",
            },
          },
        }),
      );

      // Global config does not exist, so bootstrap sees 0 servers
      await extension(mockExt.api, {
        bootstrapCwd: dir,
        globalConfigPath: join(dir, "absent-global.json"),
      });

      assert.ok(events.has("session_start"), "Must register session_start even when global config is empty");
      assert.ok(events.has("mcp_servers_change"), "Must register mcp_servers_change handler");

      await events.get("session_start")({}, ctx);

      const status = JSON.parse(
        (await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text,
      );
      assert.deepEqual(
        status.map((row: { name: string; state?: string }) => [row.name, row.state]),
        [["local_srv", "ready"]],
      );
      const active = mockExt.activeTools;
      assert.ok(
        active.some((name) => name === "proj_mcp_local_srv_echo"),
        `Expected tool with project toolPrefix proj_mcp, got: ${active.join(", ")}`,
      );
    } finally {
      await events.get("session_shutdown")?.({}, ctx);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("handles pi.getMcpServers() and mcp_servers_change while preserving mcp.json precedence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-ext-servers-"));
    let registeredServers: RegisteredMcpServer[] = [
      {
        name: "ext_eager",
        config: { command: "node", args: ["--import", tsxEsmLoader, mockServerPath] },
        extensionPath: "/ext/a.ts",
      },
      {
        name: "ext_disabled",
        config: { command: "node", args: ["--import", tsxEsmLoader, mockServerPath], enabled: false },
        extensionPath: "/ext/a.ts",
      },
      {
        // Same name as mcp.json server below; mcp.json (lazy) must win over extension (eager)
        name: "collision",
        config: { command: "node", args: ["--import", tsxEsmLoader, mockServerPath] },
        extensionPath: "/ext/a.ts",
      },
    ];

    const mockExt = createMockExtension({
      mcpServers: registeredServers,
    });
    (mockExt.api as unknown as { getMcpServers: () => RegisteredMcpServer[] }).getMcpServers = () => registeredServers;
    const tools = mockExt.tools;
    const events = mockExt.events;

    const ctx = createMockContext({
      cwd: dir,
      hasUI: false,
      isProjectTrusted: () => true,
    });

    try {
      await mkdir(join(dir, ".pi"), { recursive: true });
      await writeFile(
        join(dir, ".pi", "mcp.json"),
        JSON.stringify({
          settings: { maxRetries: 0 },
          mcpServers: {
            collision: {
              command: "node",
              args: ["--import", tsxEsmLoader, mockServerPath],
              lifecycle: "lazy",
            },
          },
        }),
      );

      await extension(mockExt.api, {
        bootstrapCwd: dir,
        globalConfigPath: join(dir, "absent-global.json"),
      });
      await events.get("session_start")({}, ctx);

      const initialStatus = JSON.parse(
        (await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text,
      );
      const byName = new Map<string, { state?: string; lifecycle?: string }>(
        initialStatus.map((r: { name: string; state?: string; lifecycle?: string }) => [r.name, r]),
      );
      assert.equal(byName.get("ext_eager")?.state, "ready");
      assert.equal(byName.get("ext_eager")?.lifecycle, "eager");
      assert.equal(byName.get("ext_disabled")?.state, "stopped");
      assert.equal(byName.get("ext_disabled")?.lifecycle, "lazy");
      // mcp.json's lazy config takes precedence over extension's eager config
      assert.equal(byName.get("collision")?.state, "stopped");
      assert.equal(byName.get("collision")?.lifecycle, "lazy");
      let active = mockExt.activeTools;
      assert.ok(active.includes("mcp_ext_eager_echo"));
      assert.ok(!active.includes("mcp_collision_echo"));

      // Dynamically unregister ext_eager and register ext_dynamic via mcp_servers_change
      registeredServers = [
        {
          name: "ext_dynamic",
          config: { command: "node", args: ["--import", tsxEsmLoader, mockServerPath] },
          extensionPath: "/ext/b.ts",
        },
      ];
      await events.get("mcp_servers_change")(
        { type: "mcp_servers_change", servers: registeredServers },
        ctx,
      );

      const updatedStatus = JSON.parse(
        (await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text,
      );
      const updatedByName = new Map<string, { state?: string; lifecycle?: string }>(
        updatedStatus.map((r: { name: string; state?: string; lifecycle?: string }) => [r.name, r]),
      );
      assert.equal(updatedByName.has("ext_eager"), false, "Unregistered extension server should be removed");
      assert.equal(updatedByName.has("ext_disabled"), false, "Unregistered disabled server should be removed");
      assert.equal(updatedByName.get("ext_dynamic")?.state, "ready", "Newly registered server should be started");
      assert.equal(updatedByName.get("collision")?.state, "stopped", "mcp.json server should remain intact");
      active = mockExt.activeTools;
      assert.ok(!active.includes("mcp_ext_eager_echo"));
      assert.ok(active.includes("mcp_ext_dynamic_echo"));
    } finally {
      await events.get("session_shutdown")?.({}, ctx);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("applies a Pi 1.3.0 project override entry without tearing down the other global servers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-project-override-"));
    const globalConfigPath = join(dir, "global-mcp.json");
    const mockExt = createMockExtension();
    const tools = mockExt.tools;
    const events = mockExt.events;
    const ctx = createMockContext({
      cwd: dir,
      hasUI: false,
      isProjectTrusted: () => true,
    });

    try {
      await writeFile(
        globalConfigPath,
        JSON.stringify({
          settings: { maxRetries: 0 },
          mcpServers: {
            shared_global: {
              command: "node",
              args: ["--import", tsxEsmLoader, mockServerPath],
              lifecycle: "eager",
            },
            stay_on: {
              command: "node",
              args: ["--import", tsxEsmLoader, mockServerPath],
              lifecycle: "eager",
            },
          },
        }),
      );
      // Pi 1.3.0 `/mcp` writes exactly this to disable one global server for one project.
      await mkdir(join(dir, ".pi"), { recursive: true });
      await writeFile(
        join(dir, ".pi", "mcp.json"),
        JSON.stringify({ mcpServers: { shared_global: { enabled: false } } }),
      );

      await extension(mockExt.api, { bootstrapCwd: dir, globalConfigPath });
      await events.get("session_start")({}, ctx);

      const status = JSON.parse(
        (await tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text,
      );
      const byName = new Map<string, { state?: string; lifecycle?: string }>(
        status.map((r: { name: string; state?: string; lifecycle?: string }) => [r.name, r]),
      );
      assert.equal(byName.get("shared_global")?.state, "stopped", "the project override must hold the server down");
      assert.equal(byName.get("shared_global")?.lifecycle, "lazy");
      assert.equal(byName.get("stay_on")?.state, "ready", "a project override must not tear down the other global servers");
      const active = mockExt.activeTools;
      assert.ok(!active.includes("mcp_shared_global_echo"));
      assert.ok(active.includes("mcp_stay_on_echo"));
    } finally {
      await events.get("session_shutdown")?.({}, ctx);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("config-compat pure alias normalizers and project override merger", () => {
  it("narrows plain JSON objects via isPlainObject", () => {
    assert.equal(isPlainObject({ a: 1 }), true);
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject(undefined), false);
    assert.equal(isPlainObject(["a"]), false);
    assert.equal(isPlainObject("str"), false);
    assert.equal(isPlainObject(42), false);
  });

  it("normalizes OAuth callbackUrl and callbackPort aliases without mutating the input", () => {
    assert.equal(normalizeAuthConfigAliases(null), null);
    assert.equal(normalizeAuthConfigAliases("oauth"), "oauth");
    const arr = ["a"];
    assert.equal(normalizeAuthConfigAliases(arr), arr);

    const withCallbackUrl = Object.freeze({
      callbackUrl: "http://localhost:19876/callback",
      callbackPort: 29999,
      scope: "read",
    });
    assert.deepEqual(normalizeAuthConfigAliases(withCallbackUrl), {
      redirectUrl: "http://localhost:19876/callback",
      scope: "read",
    });

    assert.deepEqual(normalizeAuthConfigAliases({ callbackPort: 24000 }), {
      redirectUrl: "http://127.0.0.1:24000/callback",
    });

    assert.deepEqual(normalizeAuthConfigAliases({ callbackUrl: null, callbackPort: 24001 }), {
      redirectUrl: "http://127.0.0.1:24001/callback",
    });

    // Non-string callbackUrl without callbackPort forwards to redirectUrl so Zod rejects it
    assert.deepEqual(normalizeAuthConfigAliases({ callbackUrl: 12345 }), {
      redirectUrl: 12345,
    });

    // Explicit redirectUrl wins while legacy keys are stripped
    assert.deepEqual(
      normalizeAuthConfigAliases({
        redirectUrl: "http://127.0.0.1:19876/callback",
        callbackUrl: "http://127.0.0.1:20000/callback",
        callbackPort: 20001,
      }),
      { redirectUrl: "http://127.0.0.1:19876/callback" },
    );
  });

  it("normalizes Pi 1.x server aliases (type/http/url, oauth, timeout, enabled) without mutating the input", () => {
    assert.equal(normalizeServerConfigAliases(undefined), undefined);
    assert.equal(normalizeServerConfigAliases(123), 123);
    const arr = [1, 2];
    assert.equal(normalizeServerConfigAliases(arr), arr);

    const legacyHttp = Object.freeze({
      type: "http",
      url: "https://mcp.example.com/mcp",
      oauth: { clientId: "cid" },
      timeout: 15,
      lifecycle: "eager",
      enabled: false,
    });
    assert.deepEqual(normalizeServerConfigAliases(legacyHttp), {
      type: "http",
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
      oauth: { clientId: "cid" },
      auth: { clientId: "cid" },
      timeout: 15,
      requestTimeoutMs: 15000,
      lifecycle: "lazy",
      enabled: false,
    });

    // Explicit transport/auth/requestTimeoutMs win over legacy aliases
    assert.deepEqual(
      normalizeServerConfigAliases({
        transport: "sse",
        type: "stdio",
        auth: { scope: "primary" },
        oauth: { scope: "legacy" },
        requestTimeoutMs: 5000,
        timeout: 60,
        enabled: true,
        lifecycle: "eager",
      }),
      {
        transport: "sse",
        type: "stdio",
        auth: { scope: "primary" },
        oauth: { scope: "legacy" },
        requestTimeoutMs: 5000,
        timeout: 60,
        enabled: true,
        lifecycle: "eager",
      },
    );

    // `type` other than "http" maps to `transport` when `transport` is omitted
    assert.deepEqual(normalizeServerConfigAliases({ type: "sse", url: "https://example.com/sse" }), {
      type: "sse",
      transport: "sse",
      url: "https://example.com/sse",
    });

    // `url` without `command` or `type`/`transport` infers `streamable-http`; `url` + `command` does not
    assert.deepEqual(normalizeServerConfigAliases({ url: "https://example.com/mcp" }), {
      url: "https://example.com/mcp",
      transport: "streamable-http",
    });
    assert.deepEqual(normalizeServerConfigAliases({ command: "node", url: "https://example.com/mcp" }), {
      command: "node",
      url: "https://example.com/mcp",
    });

    // Non-object `oauth` and non-positive / non-numeric `timeout` are ignored by alias normalizers
    assert.deepEqual(normalizeServerConfigAliases({ command: "node", oauth: ["bad"], timeout: 0 }), {
      command: "node",
      oauth: ["bad"],
      timeout: 0,
    });
  });

  it("applies extension-registered server lifecycle defaults via withRegisteredServerLifecycle", () => {
    assert.equal(withRegisteredServerLifecycle(null), null);
    const explicitLazy = { command: "node", lifecycle: "lazy" };
    assert.equal(withRegisteredServerLifecycle(explicitLazy), explicitLazy);

    assert.deepEqual(withRegisteredServerLifecycle({ command: "node" }), {
      command: "node",
      lifecycle: "eager",
    });
    assert.deepEqual(withRegisteredServerLifecycle({ command: "node", enabled: false }), {
      command: "node",
      enabled: false,
      lifecycle: "lazy",
    });
  });

  it("detects and merges partial Pi 1.3.0 project override entries via applyProjectOverrides", () => {
    assert.deepEqual(PROJECT_OVERRIDE_KEYS, ["enabled", "exposure", "toolExposure", "lifecycle"]);
    assert.equal(isProjectOverrideEntry(null), false);
    assert.equal(isProjectOverrideEntry({ enabled: false }), true);
    assert.equal(isProjectOverrideEntry({ command: "node", enabled: false }), false);
    assert.equal(isProjectOverrideEntry({ url: "https://example.com/mcp" }), false);
    assert.equal(isProjectOverrideEntry({ type: "stdio" }), false);
    assert.equal(isProjectOverrideEntry({ transport: "sse" }), false);

    // Non-object or mcpServers-less project config passes through untouched
    assert.equal(applyProjectOverrides("raw", {}, "/proj/.pi/mcp.json"), "raw");
    const noServers = { settings: { maxRetries: 1 } };
    assert.equal(applyProjectOverrides(noServers, {}, "/proj/.pi/mcp.json"), noServers);

    // Lifecycle override without `enabled` clears inherited `enabled: false` on global base
    const globalRaw = Object.freeze({
      mcpServers: Object.freeze({
        svc: Object.freeze({ command: "node", args: ["a.js"], enabled: false }),
      }),
    });
    const projectRaw = Object.freeze({
      mcpServers: Object.freeze({
        svc: Object.freeze({ lifecycle: "eager", exposure: "direct" }),
        local_full: Object.freeze({ command: "python", args: ["srv.py"] }),
      }),
    });
    assert.deepEqual(applyProjectOverrides(projectRaw, globalRaw, "/proj/.pi/mcp.json"), {
      mcpServers: {
        svc: { command: "node", args: ["a.js"], lifecycle: "eager", exposure: "direct" },
        local_full: { command: "python", args: ["srv.py"] },
      },
    });

    // Missing global target or non-object globalRaw throws McpError("config") naming projectPath
    assert.throws(
      () => applyProjectOverrides({ mcpServers: { ghost: { enabled: false } } }, undefined, "/proj/.pi/mcp.json"),
      (err: unknown) =>
        err instanceof McpError &&
        err.code === "config" &&
        err.message.includes("/proj/.pi/mcp.json") &&
        err.message.includes("mcpServers.ghost"),
    );

    // Unsupported override keys throw McpError("config")
    assert.throws(
      () =>
        applyProjectOverrides(
          { mcpServers: { svc: { enabled: false, env: { A: "1" } } } },
          globalRaw,
          "/proj/.pi/mcp.json",
        ),
      (err: unknown) =>
        err instanceof McpError &&
        err.code === "config" &&
        err.message.includes("/proj/.pi/mcp.json") &&
        err.message.includes("found env"),
    );
  });
});

describe("callback-url pure redirect URL config validation and callback-server re-exports", () => {
  it("owns callbackServerConfigFromRedirectUrl in callback-url.ts and re-exports identical bindings from callback-server.ts", () => {
    assert.equal(
      callbackServer.callbackServerConfigFromRedirectUrl,
      callbackUrl.callbackServerConfigFromRedirectUrl,
    );
    assert.equal(callbackServer.DEFAULT_PORT, callbackUrl.DEFAULT_PORT);
    assert.equal(callbackServer.DEFAULT_HOST, callbackUrl.DEFAULT_HOST);
    assert.equal(callbackServer.CALLBACK_PATH, callbackUrl.CALLBACK_PATH);

    assert.deepEqual(callbackUrl.callbackServerConfigFromRedirectUrl(undefined), {
      preferredPort: 19876,
      host: "127.0.0.1",
      allowPortFallback: true,
    });
    assert.deepEqual(callbackUrl.callbackServerConfigFromRedirectUrl("http://[::1]:23456/callback"), {
      preferredPort: 23456,
      host: "::1",
      allowPortFallback: false,
    });

    assert.throws(() => callbackUrl.callbackServerConfigFromRedirectUrl(""), /Invalid URL/);
    assert.throws(
      () => callbackUrl.callbackServerConfigFromRedirectUrl("https://127.0.0.1:19876/callback"),
      /must use HTTP with localhost, 127\.0\.0\.1, or ::1/,
    );
    assert.throws(
      () => callbackUrl.callbackServerConfigFromRedirectUrl("http://127.0.0.1:19876/callback#frag"),
      /must not include a fragment/,
    );
    assert.throws(
      () => callbackUrl.callbackServerConfigFromRedirectUrl("http://user:pass@127.0.0.1:19876/callback"),
      /must not include credentials/,
    );
    assert.throws(
      () => callbackUrl.callbackServerConfigFromRedirectUrl("http://127.0.0.1:19876/other"),
      /must use path \/callback/,
    );
    assert.throws(
      () => callbackUrl.callbackServerConfigFromRedirectUrl("http://127.0.0.1/callback"),
      /must include an explicit port/,
    );
    assert.throws(
      () => callbackUrl.callbackServerConfigFromRedirectUrl("http://127.0.0.1:0/callback"),
      /must use a fixed non-zero port/,
    );
  });
});

