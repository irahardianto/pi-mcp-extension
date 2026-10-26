import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ServerConfig } from "../src/config.js";
import { McpError } from "../src/errors.js";
import { AuthLockError, AuthRequiredError } from "../src/oauth-provider.js";
import type { ManagedServer } from "../src/server-manager.js";
import {
  formatProjectConfigNote,
  formatServerSource,
  lookupServerSource,
  withExtensionServers,
  type ConfigProvenanceInput,
} from "../src/server-provenance.js";
import {
  classifyFailure,
  collectServerStatus,
  formatFailureHint,
  formatServerDetail,
  formatStatusAuth,
  formatStatusError,
  toStatusRow,
  type ServerStatusSnapshot,
} from "../src/server-status.js";

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

function serverConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { args: [], transport: "stdio", lifecycle: "lazy", ...overrides };
}

function managedServer(overrides: Partial<ManagedServer> = {}): ManagedServer {
  return {
    name: "srv",
    config: serverConfig({ command: "node" }),
    state: "stopped",
    client: null,
    childPid: null,
    retryCount: 0,
    lastError: null,
    stderrLog: [],
    healthCheckTimer: null,
    retryTimer: null,
    ...overrides,
  };
}

function provenanceInput(overrides: Partial<ConfigProvenanceInput> = {}): ConfigProvenanceInput {
  return {
    origins: {},
    projectConfigPath: "/work/proj/.pi/mcp.json",
    projectConfigIncluded: true,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ServerStatusSnapshot> = {}): ServerStatusSnapshot {
  return {
    name: "srv",
    state: "stopped",
    transport: "stdio",
    lifecycle: "lazy",
    retryCount: 0,
    source: "global",
    tools: { discovered: 0, active: 0 },
    auth: undefined,
    lastError: null,
    recentOutput: "(no stderr output from srv)",
    ...overrides,
  };
}

describe("config provenance", () => {
  it("records extension servers while file origins stay authoritative and ignores Object.prototype keys", () => {
    const provenance = withExtensionServers(
      provenanceInput({ origins: { shared: "project", "global-only": "global" } }),
      ["shared", "ext-only", "toString"],
    );

    assert.equal(formatServerSource(lookupServerSource(provenance, "ext-only")), "extension");
    assert.equal(formatServerSource(lookupServerSource(provenance, "toString")), "extension");
    assert.equal(lookupServerSource(provenance, "constructor"), undefined);
    assert.equal(formatServerSource(lookupServerSource(provenance, "constructor")), "unknown");
    assert.equal(formatProjectConfigNote(provenance), undefined);
    assert.deepEqual(provenance.sources, {
      shared: "project",
      "global-only": "global",
      "ext-only": "extension",
      toString: "extension",
    });
  });

  it("explains a skipped project config instead of silently omitting it and sanitizes the path", () => {
    const provenance = withExtensionServers(
      provenanceInput({
        projectConfigPath: "/work/evil\u001b[31mproj/.pi/mcp.json",
        projectConfigIncluded: false,
      }),
      [],
    );

    const note = formatProjectConfigNote(provenance);
    assert.ok(note);
    assert.equal(note.includes("\u001b"), false);
    assert.match(note, /Project config: not loaded \(\/work\/evilproj\/\.pi\/mcp\.json\)/);
    assert.match(note, /not trusted/);
  });
});

describe("status formatting", () => {
  it("summarizes stored credentials for every auth state", () => {
    assert.equal(formatStatusAuth(undefined, false, undefined), "not configured");
    assert.equal(formatStatusAuth({ type: "oauth" }, true, true), "corrupt state file backed up (re-auth required)");
    assert.equal(formatStatusAuth({ type: "oauth" }, false, true), "credentials stored");
    assert.equal(formatStatusAuth({ type: "oauth" }, false, false), "authorization may be required");
  });

  it("keeps the mcp_status error hint short and actionable", () => {
    assert.equal(formatStatusError(null), undefined);
    assert.match(String(formatStatusError(new AuthRequiredError("srv"))), /Authorization required/);
    assert.equal(
      formatStatusError(new McpError("boom", "srv", "connection")),
      "Connection connection; use mcp_connect to retry",
    );
    assert.equal(formatStatusError(new Error("boom")), "Connection failed; use mcp_connect to retry");
  });

  it("classifies failures into the three troubleshooting paths", () => {
    assert.equal(classifyFailure(null), undefined);
    assert.equal(classifyFailure(new AuthRequiredError("srv")), "auth-required");
    assert.equal(classifyFailure(new AuthLockError("locked")), "auth-lock");
    assert.equal(classifyFailure(new McpError("boom", "srv", "timeout")), "connection");
    assert.equal(formatFailureHint(undefined, "srv"), undefined);
  });

  it("points each failure kind at the command that can fix it", () => {
    assert.match(String(formatFailureHint("auth-required", "srv")), /\/mcp:auth srv .*--reset/);
    assert.match(String(formatFailureHint("auth-lock", "srv")), /another Pi process is authorizing srv/);
    assert.match(String(formatFailureHint("connection", "srv")), /PI_MCP_DEBUG=1/);
    assert.match(String(formatFailureHint("connection", "srv")), /issues$/);
  });

  it("never lets a server-controlled name reach the terminal view unsanitized", () => {
    const hint = formatFailureHint("auth-required", "evil\u001b[31mname");
    assert.equal(hint?.includes("\u001b"), false);
    const detail = formatServerDetail(
      snapshot({ name: "evil\u001b[31mname", lastError: new Error("bad\u001b[0m") }),
      withExtensionServers(provenanceInput(), []),
    );
    assert.equal(detail.includes("\u001b"), false);
  });
});

describe("formatServerDetail", () => {
  it("shows transport, lifecycle, provenance, tool counts, and recent output", () => {
    const detail = formatServerDetail(
      snapshot({
        name: "supabase",
        state: "ready",
        transport: "streamable-http",
        lifecycle: "eager",
        source: "project",
        tools: { discovered: 4, active: 3 },
        recentOutput: "listening",
      }),
      withExtensionServers(provenanceInput(), []),
    );

    assert.match(detail, /^Server: supabase$/m);
    assert.match(detail, /^State:  ready$/m);
    assert.match(detail, /^Retries: 0$/m);
    assert.match(detail, /^Transport: streamable-http$/m);
    assert.match(detail, /^Lifecycle: eager$/m);
    assert.match(detail, /^Source: project$/m);
    assert.match(detail, /^Tools: 3\/4 active$/m);
    assert.match(detail, /^Recent output:\nlistening$/m);
    // A healthy server gets no OAuth, error, or hint noise.
    assert.doesNotMatch(detail, /^OAuth:/m);
    assert.doesNotMatch(detail, /^Last error:/m);
    assert.doesNotMatch(detail, /^Hint:/m);
  });

  it("adds OAuth, last error, hint, and the skipped-project note for a failed untrusted server", () => {
    const detail = formatServerDetail(
      snapshot({
        state: "stopped",
        retryCount: 5,
        source: "global",
        tools: { discovered: 2, active: 0 },
        auth: "credentials stored",
        lastError: new McpError("Connection timed out after 30000ms", "srv", "timeout"),
        recentOutput: "(no stderr output from srv)",
      }),
      withExtensionServers(provenanceInput({ projectConfigIncluded: false }), []),
    );

    assert.match(detail, /^OAuth: credentials stored$/m);
    assert.match(detail, /^Project config: not loaded .*not trusted/m);
    assert.match(detail, /^Last error: Connection timed out after 30000ms$/m);
    assert.match(detail, /^Hint: run with PI_MCP_DEBUG=1 pi/m);
  });
});

describe("collectServerStatus", () => {
  it("skips the credential probe entirely for a server without auth config", async () => {
    let probes = 0;
    const status = await collectServerStatus({
      server: managedServer(),
      tools: { discovered: 1, active: 1 },
      source: "extension",
      recentOutput: "out",
      readAuthStatus: async () => {
        probes++;
        return null;
      },
    });

    assert.equal(probes, 0);
    assert.equal(status.auth, undefined);
    assert.equal(status.tools.discovered, 1);
    assert.deepEqual(status.recentOutput, "out");
    assert.equal(status.transport, "stdio");
  });

  it("reports credential presence from the injected stored-state reader", async () => {
    const server = managedServer({
      name: "oauth",
      config: serverConfig({ transport: "streamable-http", url: "https://example.test/mcp", auth: { type: "oauth" } }),
    });
    const withTokens = await collectServerStatus({
      server,
      tools: { discovered: 0, active: 0 },
      source: "global",
      recentOutput: "",
      readAuthStatus: async () => ({ hasTokens: true }),
    });
    const withoutState = await collectServerStatus({
      server,
      tools: { discovered: 0, active: 0 },
      source: "global",
      readAuthStatus: async () => null,
    });

    assert.equal(withTokens.auth, "credentials stored");
    assert.equal(withoutState.auth, "authorization may be required");
    assert.equal(withoutState.recentOutput, "");
  });

  it("isolates a corrupt stored-state file instead of rejecting the status view", async () => {
    const server = managedServer({
      name: "corrupt",
      config: serverConfig({ transport: "streamable-http", url: "https://example.test/mcp", auth: { type: "oauth" } }),
    });

    const status = await withoutStderr(() => collectServerStatus({
      server,
      tools: { discovered: 0, active: 0 },
      source: "project",
      recentOutput: "",
      readAuthStatus: async () => {
        throw new McpError("corrupt state", "corrupt", "config");
      },
    }));

    assert.equal(status.auth, "corrupt state file backed up (re-auth required)");
  });
});

describe("toStatusRow", () => {
  it("renders the mcp_status row including the config source", () => {
    const row = toStatusRow(
      snapshot({
        name: "srv",
        lifecycle: "eager",
        state: "ready",
        tools: { discovered: 3, active: 2 },
        lastError: null,
        source: "project",
      }),
    );

    assert.deepEqual(row, {
      name: "srv",
      lifecycle: "eager",
      state: "ready",
      tools: { discovered: 3, active: 2 },
      auth: "not configured",
      error: undefined,
      source: "project",
    });
  });

  it("reports an unknown source rather than inventing one", () => {
    assert.equal(toStatusRow(snapshot({ source: undefined })).source, "unknown");
  });
});
