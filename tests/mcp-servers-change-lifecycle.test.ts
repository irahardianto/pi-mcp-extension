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
});
