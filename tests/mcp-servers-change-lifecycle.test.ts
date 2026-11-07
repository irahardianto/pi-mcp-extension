import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
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

      const markerFile = join(harness.dir, "superseded-spawned.txt");
      const badEntry = { name: "bad", config: {}, extensionPath: "/ext/a.ts" } as unknown as RegisteredMcpServer;
      const superseded: RegisteredMcpServer[] = [
        badEntry,
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
      // before Event 2 unregisters ext_srv (keeping badEntry so we also verify badEntry is
      // reported once for the winning snapshot rather than twice across the superseded turn).
      harness.setRegistered(superseded);
      const first = harness.emitChange(superseded);
      await Promise.resolve();
      harness.setRegistered([badEntry]);
      const second = harness.emitChange([badEntry]);
      await Promise.all([first, second]);

      await assert.rejects(
        () => access(markerFile),
        { code: "ENOENT" },
        "a config superseded while removeServer was awaiting child teardown must never be spawned",
      );
      assert.deepEqual(await harness.status(), []);
      const configErrors = notifications.filter((message) => message.includes("Config error"));
      assert.equal(
        configErrors.length,
        1,
        `a turn superseded during removeServer must not duplicate config-error toasts: ${JSON.stringify(configErrors)}`,
      );
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

  it("drains an in-flight removal before session_start finishes when the server stays unregistered", async () => {
    const harness = await createChangeHarness({ servers: [serverEntry("ext_srv")] });
    try {
      await harness.mockExt.events.get("session_start")({}, harness.ctx);

      // Start removing ext_srv, let Turn 1 call removeAppliedServer("ext_srv") and suspend
      // inside manager.removeServer("ext_srv"), then run session_start while ext_srv stays [].
      harness.setRegistered([]);
      const unregister = harness.emitChange([]);
      await Promise.resolve();

      await harness.mockExt.events.get("session_start")({}, harness.ctx);
      assert.deepEqual(
        await harness.status(),
        [],
        "session_start must not resolve while an unregistered server is still lingering in ServerManager",
      );
      await unregister;
    } finally {
      await harness.cleanup();
    }
  });

  it("aborts an in-flight reconcile eager start when a newer change unregisters or replaces the server", async () => {
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

      // Event 1 registers an eager server that exits with code 1 once it receives initialize.
      // Because removedOrChanged is empty, one microtask puts Turn 1 directly inside
      // await coordinator.startEagerServers with the child process already spawned.
      const slowFailing: RegisteredMcpServer[] = [
        {
          name: "ext_slow",
          config: {
            command: process.execPath,
            args: ["-e", 'process.stdin.once("data", () => process.exit(1))'],
          },
          extensionPath: "/ext/a.ts",
        },
      ];
      harness.setRegistered(slowFailing);
      const p1 = harness.emitChange(slowFailing);
      await Promise.resolve();

      // Event 2 unregisters ext_slow while Turn 1 is inside startEagerServers, and Event 3
      // re-registers ext_slow with the working mock server (ABA while startEagerServers is in flight).
      harness.setRegistered([]);
      const p2 = harness.emitChange([]);
      const working = [serverEntry("ext_slow")];
      harness.setRegistered(working);
      const p3 = harness.emitChange(working);
      await Promise.all([p1, p2, p3]);

      assert.deepEqual(
        notifications.filter((message) => message.includes("Failed to start ext_slow")),
        [],
        `an eager start superseded while connecting must be cancelled without toasting: ${JSON.stringify(notifications)}`,
      );
      assert.deepEqual(
        (await harness.status()).map((row) => [row.name, row.state]),
        [["ext_slow", "ready"]],
        "re-registering the server after aborting its in-flight eager start must bring the final server up",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("stops an in-flight reconcile eager start on session_start and keeps session inactive if shut down during startup", async () => {
    const ctx1Notifications: string[] = [];
    const ctx2Notifications: string[] = [];
    const harness = await createChangeHarness({
      servers: [serverEntry("ext_ready")],
      hasUI: true,
      ui: {
        notify: (message: string) => {
          ctx1Notifications.push(message);
        },
      },
    });
    const dir2 = await mkdtemp(join(tmpdir(), "pi-mcp-change-ctx2-"));
    const ctx2 = createMockContext({
      cwd: dir2,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        notify: (message: string) => {
          ctx2Notifications.push(message);
        },
      },
    });

    try {
      await harness.mockExt.events.get("session_start")({}, harness.ctx);

      const slowFailing: RegisteredMcpServer[] = [
        serverEntry("ext_ready"),
        {
          name: "ext_slow",
          config: {
            command: process.execPath,
            args: ["-e", 'process.stdin.once("data", () => process.exit(1))'],
          },
          extensionPath: "/ext/a.ts",
        },
      ];
      harness.setRegistered(slowFailing);
      const p1 = harness.emitChange(slowFailing);
      await Promise.resolve();

      // Switch to ctx2 while Turn 1 is inside startEagerServers on ctx1.
      await harness.mockExt.events.get("session_start")({}, ctx2);
      await p1;

      assert.deepEqual(
        ctx1Notifications.filter((message) => message.includes("Failed to start ext_slow")),
        [],
        `the superseded session ctx1 must not toast for an eager start aborted by session_start: ${JSON.stringify(ctx1Notifications)}`,
      );
      assert.equal(
        ctx2Notifications.filter((message) => message.includes("Failed to start ext_slow")).length,
        1,
        `the active session ctx2 must report the start failure exactly once: ${JSON.stringify(ctx2Notifications)}`,
      );
      assert.deepEqual(
        (await harness.status()).map((row) => [row.name, row.state]),
        [
          ["ext_ready", "ready"],
          ["ext_slow", "stopped"],
        ],
        "ext_ready must stay ready and ext_slow must remain in ServerManager as stopped",
      );

      // Now start a session and shut it down while runSessionStart is still in flight; the
      // superseded startup must not mutate ServerManager after shutdown or flip sessionActive back to true.
      harness.setRegistered([serverEntry("ext_during_shutdown")]);
      const starting = harness.mockExt.events.get("session_start")({}, ctx2);
      await Promise.resolve();
      await harness.mockExt.events.get("session_shutdown")({}, ctx2);
      await starting;

      assert.ok(
        !(await harness.status()).some((row) => row.name === "ext_during_shutdown"),
        "a startup superseded by session_shutdown must not rebuild ServerManager after shutdown",
      );

      harness.setRegistered([serverEntry("ext_post_shutdown")]);
      await harness.emitChange([serverEntry("ext_post_shutdown")]);
      assert.ok(
        !harness.mockExt.activeTools.some((name) => name.startsWith("mcp_ext_post_shutdown_")),
        "session_start finally must not re-activate a session that was shut down while starting",
      );
    } finally {
      await harness.cleanup();
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it("aborts a session_start eager start when mcp_servers_change replaces it, and keeps servers stopped on session_shutdown", async () => {
    const notifications: string[] = [];
    const slowInitial: RegisteredMcpServer = {
      name: "ext_startup_slow",
      config: {
        command: process.execPath,
        args: ["-e", 'process.stdin.once("data", () => process.exit(1))'],
      },
      extensionPath: "/ext/a.ts",
    };
    const harness = await createChangeHarness({
      servers: [slowInitial],
      hasUI: true,
      ui: {
        notify: (message: string) => {
          notifications.push(message);
        },
      },
    });

    try {
      const startPromise = harness.mockExt.events.get("session_start")({}, harness.ctx);
      await Promise.resolve();

      // Replace ext_startup_slow with a working mock server while session_start is inside runEagerStarts.
      const replacement = [serverEntry("ext_startup_slow")];
      harness.setRegistered(replacement);
      const changePromise = harness.emitChange(replacement);
      await startPromise;
      await changePromise;

      assert.deepEqual(
        notifications.filter((message) => message.includes("Failed to start ext_startup_slow")),
        [],
        `aborted initial eager start must not emit a failure toast: ${JSON.stringify(notifications)}`,
      );
      assert.deepEqual(
        (await harness.status()).map((row) => [row.name, row.state]),
        [["ext_startup_slow", "ready"]],
        "replacement server should finish ready after session_start drains the post-startup reconcile",
      );

      // Now register a slow server via mcp_servers_change and shut the session down while it is starting.
      const withShutdownSlow: RegisteredMcpServer[] = [
        serverEntry("ext_startup_slow"),
        {
          name: "ext_shutdown_slow",
          config: {
            command: process.execPath,
            args: ["-e", 'process.stdin.once("data", () => process.exit(1))'],
          },
          extensionPath: "/ext/a.ts",
        },
      ];
      harness.setRegistered(withShutdownSlow);
      const reconcilePromise = harness.emitChange(withShutdownSlow);
      await Promise.resolve();

      await harness.mockExt.events.get("session_shutdown")({}, harness.ctx);
      await reconcilePromise;

      assert.deepEqual(
        notifications.filter((message) => message.includes("Failed to start ext_shutdown_slow")),
        [],
        `session_shutdown must not emit a failure toast for an aborted eager start: ${JSON.stringify(notifications)}`,
      );
      assert.deepEqual(
        (await harness.status()).map((row) => [row.name, row.state]),
        [
          ["ext_startup_slow", "stopped"],
          ["ext_shutdown_slow", "stopped"],
        ],
        "session_shutdown must stop in-flight extension servers without removing them from ServerManager",
      );
    } finally {
      await harness.cleanup();
    }
  });
});
