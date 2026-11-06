import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import extension from "../src/index.js";
import type { ExtensionUIContext, RegisteredMcpServer } from "@earendil-works/pi-coding-agent";
import { createMockExtension, createMockContext } from "./helpers/mock-extension.js";

const mockServerPath = join(dirname(fileURLToPath(import.meta.url)), "mock-server.ts");
const tsxEsmLoader = import.meta.resolve("tsx/esm");

function serverEntry(name: string, config: Record<string, unknown> = {}): RegisteredMcpServer {
  return {
    name,
    config: { command: "node", args: ["--import", tsxEsmLoader, mockServerPath], ...config },
    extensionPath: "/ext/a.ts",
  };
}

/** Harness: a mock Pi extension whose registry the test can mutate between events. */
async function createChangeHarness(options?: {
  servers?: RegisteredMcpServer[];
  hasUI?: boolean;
  ui?: Partial<ExtensionUIContext>;
}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-change-"));
  const globalConfigPath = join(dir, "global-mcp.json");
  await writeFile(globalConfigPath, JSON.stringify({ settings: { maxRetries: 0 } }));

  let registeredServers: RegisteredMcpServer[] = options?.servers ?? [];
  const mockExt = createMockExtension({ mcpServers: registeredServers });
  // WHY: createMockExtension closes over its initial array, so a test that swaps the
  // registry contents needs the live accessor Pi itself provides.
  (mockExt.api as unknown as { getMcpServers: () => RegisteredMcpServer[] }).getMcpServers = () =>
    registeredServers;

  const ctx = createMockContext({
    cwd: dir,
    hasUI: options?.hasUI ?? false,
    isProjectTrusted: () => true,
    ...(options?.ui ? { ui: options.ui } : {}),
  });
  await extension(mockExt.api, { bootstrapCwd: dir, globalConfigPath });

  return {
    ctx,
    mockExt,
    dir,
    setRegistered: (next: RegisteredMcpServer[]) => {
      registeredServers = next;
    },
    emitChange: (servers: RegisteredMcpServer[]) =>
      mockExt.events.get("mcp_servers_change")({ type: "mcp_servers_change", servers }, ctx),
    status: async (): Promise<Array<{ name: string; state: string; lifecycle: string }>> =>
      JSON.parse(
        (await mockExt.tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text,
      ),
    cleanup: async () => {
      await mockExt.events.get("session_shutdown")?.({}, ctx);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("mcp_servers_change reconciliation (#216)", () => {
  it("never resurrects a server unregistered by a concurrent change event", async () => {
    const harness = await createChangeHarness({ servers: [serverEntry("ext_srv")] });
    try {
      await harness.mockExt.events.get("session_start")({}, harness.ctx);
      assert.deepEqual(
        (await harness.status()).map((row) => [row.name, row.state]),
        [["ext_srv", "ready"]],
        "harness precondition: the registered server is connected before the race",
      );

      // Back-to-back registrations, exactly as Pi's registry emits them (`void emit(...)`):
      // an update of ext_srv followed by its removal, with no awaiting in between.
      const updated = [serverEntry("ext_srv", { timeout: 45 })];
      harness.setRegistered(updated);
      const update = harness.emitChange(updated);
      harness.setRegistered([]);
      const unregister = harness.emitChange([]);
      await Promise.all([update, unregister]);

      assert.deepEqual(
        await harness.status(),
        [],
        "a stale reconcile must not re-add a server that was unregistered while it awaited teardown",
      );
      assert.ok(
        !harness.mockExt.activeTools.some((name) => name.startsWith("mcp_ext_srv_")),
        "the resurrected server must not leave its tools active",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps the newest registration when an update lands during an in-flight teardown", async () => {
    const harness = await createChangeHarness({ servers: [serverEntry("ext_srv")] });
    try {
      await harness.mockExt.events.get("session_start")({}, harness.ctx);

      // Disable-then-re-enable in one turn: the disabled config must never be applied, and
      // the re-enabled server must survive the teardown the first event started.
      const disabled = [serverEntry("ext_srv", { enabled: false })];
      harness.setRegistered(disabled);
      const disable = harness.emitChange(disabled);
      const reenabled = [serverEntry("ext_srv", { timeout: 45 })];
      harness.setRegistered(reenabled);
      const enable = harness.emitChange(reenabled);
      await Promise.all([disable, enable]);

      const rows = await harness.status();
      assert.equal(rows.length, 1, "exactly one server instance must remain");
      assert.equal(rows[0]?.state, "ready", "the re-enabled server must not be replaced by the stale config");
      assert.equal(rows[0]?.lifecycle, "eager");
      assert.ok(
        harness.mockExt.activeTools.some((name) => name.startsWith("mcp_ext_srv_")),
        "the re-enabled server's tools must stay registered",
      );

      // Re-registering the disabled config must actually stop the server. A turn that applied
      // the superseded config would record it as already applied and turn this into a no-op,
      // leaving a running server behind a config that says it is disabled.
      harness.setRegistered(disabled);
      await harness.emitChange(disabled);
      assert.equal(
        (await harness.status())[0]?.state,
        "stopped",
        "the applied config must be the newest one, so disabling it later takes effect",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("ignores change events emitted before session_start and picks the registration up there", async () => {
    const harness = await createChangeHarness();
    try {
      // Pi's registry announces servers registered after extension load, before any session.
      harness.setRegistered([serverEntry("ext_late")]);
      await harness.emitChange([serverEntry("ext_late")]);

      assert.deepEqual(
        await harness.status(),
        [],
        "a pre-session change event must not attach or start servers",
      );
      assert.deepEqual(harness.mockExt.activeTools, [], "no tools may be registered before session_start");

      await harness.mockExt.events.get("session_start")({}, harness.ctx);
      assert.deepEqual(
        (await harness.status()).map((row) => [row.name, row.state]),
        [["ext_late", "ready"]],
        "session_start must still adopt the server registered before it ran",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("adopts a server registered while session_start was still bringing servers up", async () => {
    // The registration lands after session_start has already snapshotted the registry, so only
    // the reconcile it runs when it finishes can pick it up — nothing else will until an
    // unrelated later registration.
    let harness: Awaited<ReturnType<typeof createChangeHarness>> | undefined;
    let registeredDuringStartup = false;
    harness = await createChangeHarness({
      servers: [serverEntry("ext_first")],
      ui: {
        setStatus: () => {
          if (registeredDuringStartup) return;
          registeredDuringStartup = true;
          const next = [serverEntry("ext_first"), serverEntry("ext_during")];
          harness?.setRegistered(next);
          void harness?.emitChange(next);
        },
      },
    });

    try {
      await harness.mockExt.events.get("session_start")({}, harness.ctx);
      const rows = await harness.status();
      assert.ok(
        rows.some((row) => row.name === "ext_during" && row.state === "ready"),
        `a server registered during session_start must be picked up when it finishes: ${JSON.stringify(rows)}`,
      );
      assert.ok(
        harness.mockExt.activeTools.some((name) => name.startsWith("mcp_ext_during_")),
        "the server registered during startup must have its tools registered",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("reports a malformed registered config once, not once per reconcile", async () => {
    const notifications: string[] = [];
    const harness = await createChangeHarness({
      servers: [{ name: "bad", config: {}, extensionPath: "/ext/a.ts" } as unknown as RegisteredMcpServer],
      hasUI: true,
      ui: {
        notify: (message: string) => {
          notifications.push(message);
        },
      },
    });

    try {
      await harness.mockExt.events.get("session_start")({}, harness.ctx);
      const configErrors = notifications.filter((message) => message.includes("Config error"));
      assert.equal(
        configErrors.length,
        1,
        `a malformed registration must be reported once per session start, got: ${JSON.stringify(configErrors)}`,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("ignores change events emitted after session_shutdown", async () => {
    const harness = await createChangeHarness({ servers: [serverEntry("ext_srv")] });
    try {
      await harness.mockExt.events.get("session_start")({}, harness.ctx);
      await harness.mockExt.events.get("session_shutdown")({}, harness.ctx);

      harness.setRegistered([serverEntry("ext_after")]);
      await harness.emitChange([serverEntry("ext_after")]);

      assert.deepEqual(
        (await harness.status()).map((row) => row.name),
        ["ext_srv"],
        "a post-shutdown change event must not register a server on a shut-down session",
      );
      assert.ok(
        !harness.mockExt.activeTools.some((name) => name.startsWith("mcp_ext_after_")),
        "no server may be spawned for a shut-down session",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("skips starting a superseded config when a newer change event arrives during removeServer teardown", async () => {
    const harness = await createChangeHarness({ servers: [serverEntry("ext_srv")] });
    try {
      await harness.mockExt.events.get("session_start")({}, harness.ctx);

      const markerFile = join(harness.dir, "superseded-spawned.txt");
      const superseded: RegisteredMcpServer[] = [
        {
          name: "ext_srv",
          config: {
            command: process.execPath,
            args: [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, "spawned");`,
            ],
          },
          extensionPath: "/ext/a.ts",
        },
      ];

      // Start Turn 1 with `superseded`, then wait one microtask so Turn 1 enters
      // reconcileRegisteredServers and suspends inside `await manager.removeServer("ext_srv")`
      // before Event 2 unregisters the server.
      harness.setRegistered(superseded);
      const first = harness.emitChange(superseded);
      await Promise.resolve();
      harness.setRegistered([]);
      const second = harness.emitChange([]);
      await Promise.all([first, second]);

      let markerCreated = false;
      try {
        await writeFile(markerFile, "", { flag: "r" });
        markerCreated = true;
      } catch {
        markerCreated = false;
      }
      assert.equal(
        markerCreated,
        false,
        "a config superseded while removeServer was awaiting child teardown must never be spawned",
      );
      assert.deepEqual(await harness.status(), []);
    } finally {
      await harness.cleanup();
    }
  });

  it("coalesces a synchronous registration burst so a malformed entry is reported once", async () => {
    const notifications: string[] = [];
    const harness = await createChangeHarness({
      hasUI: true,
      ui: {
        notify: (message: string) => {
          notifications.push(message);
        },
      },
    });
    try {
      await harness.mockExt.events.get("session_start")({}, harness.ctx);

      const badEntry = { name: "bad", config: {}, extensionPath: "/ext/a.ts" } as unknown as RegisteredMcpServer;
      const first = [badEntry];
      const second = [badEntry, serverEntry("ext_good")];
      harness.setRegistered(first);
      const p1 = harness.emitChange(first);
      harness.setRegistered(second);
      const p2 = harness.emitChange(second);
      await Promise.all([p1, p2]);

      const configErrors = notifications.filter((message) => message.includes("Config error"));
      assert.equal(
        configErrors.length,
        1,
        `a burst of registrations must validate once for the coalesced turn, got: ${JSON.stringify(configErrors)}`,
      );
      assert.deepEqual(
        (await harness.status()).map((row) => [row.name, row.state]),
        [["ext_good", "ready"]],
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("gates change events during a subsequent session_start reload so they do not race startSession", async () => {
    const notifications: string[] = [];
    let harness: Awaited<ReturnType<typeof createChangeHarness>> | undefined;
    let reloadPhase = false;
    let emittedDuringReload = false;
    const badEntry = { name: "bad", config: {}, extensionPath: "/ext/a.ts" } as unknown as RegisteredMcpServer;

    harness = await createChangeHarness({
      servers: [serverEntry("ext_first")],
      hasUI: true,
      ui: {
        notify: (message: string) => {
          notifications.push(message);
        },
        setStatus: () => {
          if (!reloadPhase || emittedDuringReload) return;
          emittedDuringReload = true;
          const next = [badEntry, serverEntry("ext_first"), serverEntry("ext_reload")];
          harness?.setRegistered(next);
          void harness?.emitChange(next);
        },
      },
    });

    try {
      await harness.mockExt.events.get("session_start")({}, harness.ctx);
      reloadPhase = true;
      await harness.mockExt.events.get("session_start")({}, harness.ctx);

      const rows = await harness.status();
      assert.ok(
        rows.some((row) => row.name === "ext_reload" && row.state === "ready"),
        `server registered during a subsequent session_start must be adopted: ${JSON.stringify(rows)}`,
      );
      const configErrors = notifications.filter((message) => message.includes("Config error"));
      assert.equal(
        configErrors.length,
        1,
        `change event during a subsequent session_start must reconcile once in finally, got: ${JSON.stringify(configErrors)}`,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps config in sync with ServerManager when a session switch interrupts an in-flight removal", async () => {
    const notifications: string[] = [];
    const harness = await createChangeHarness({
      servers: [serverEntry("ext_srv")],
      hasUI: true,
      ui: {
        notify: (message: string) => {
          notifications.push(message);
        },
      },
    });
    try {
      await harness.mockExt.events.get("session_start")({}, harness.ctx);

      // Start removing ext_srv, let Turn 1 enter removeServer("ext_srv"), then re-register
      // the same config and switch sessions while the old child teardown is still in flight.
      harness.setRegistered([]);
      const unregister = harness.emitChange([]);
      await Promise.resolve();

      harness.setRegistered([serverEntry("ext_srv")]);
      await harness.mockExt.events.get("session_start")({}, harness.ctx);
      await unregister;

      assert.deepEqual(
        (await harness.status()).map((row) => [row.name, row.state]),
        [["ext_srv", "ready"]],
        "the new session must rebuild and start ext_srv after an interrupted removal",
      );
      assert.deepEqual(
        notifications.filter((message) => message.includes("Unknown server")),
        [],
        `must never fail with Unknown server: ${JSON.stringify(notifications)}`,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("collapses bursts and preserves startup registrations when the host only supplies event.servers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-event-only-"));
    const globalConfigPath = join(dir, "global-mcp.json");
    await writeFile(globalConfigPath, JSON.stringify({ settings: { maxRetries: 0 } }));

    const mockExt = createMockExtension();
    // Simulate a host without pi.getMcpServers() where registrations arrive only on event.servers.
    delete (mockExt.api as { getMcpServers?: unknown }).getMcpServers;

    let emittedDuringStartup = false;
    const ctx = createMockContext({
      cwd: dir,
      hasUI: false,
      isProjectTrusted: () => {
        if (!emittedDuringStartup) {
          emittedDuringStartup = true;
          void mockExt.events.get("mcp_servers_change")(
            { type: "mcp_servers_change", servers: [serverEntry("ext_event")] },
            ctx,
          );
        }
        return true;
      },
    });

    await extension(mockExt.api, { bootstrapCwd: dir, globalConfigPath });
    try {
      await mockExt.events.get("session_start")({}, ctx);
      const afterStart = JSON.parse(
        (await mockExt.tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text,
      ) as Array<{ name: string; state: string }>;
      assert.deepEqual(
        afterStart.map((row) => [row.name, row.state]),
        [["ext_event", "ready"]],
        "post-startup reconcile must retain the event.servers payload when getMcpServers is absent",
      );

      // Burst: update followed by unregister via event.servers only.
      const p1 = mockExt.events.get("mcp_servers_change")(
        { type: "mcp_servers_change", servers: [serverEntry("ext_event", { timeout: 45 })] },
        ctx,
      );
      const p2 = mockExt.events.get("mcp_servers_change")(
        { type: "mcp_servers_change", servers: [] },
        ctx,
      );
      await Promise.all([p1, p2]);

      const afterBurst = JSON.parse(
        (await mockExt.tools.get("mcp_status").execute("", {}, undefined, undefined, ctx)).content[0].text,
      ) as Array<{ name: string; state: string }>;
      assert.deepEqual(afterBurst, [], "event.servers fallback must collapse bursts to the latest event payload");
    } finally {
      await mockExt.events.get("session_shutdown")?.({}, ctx);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

