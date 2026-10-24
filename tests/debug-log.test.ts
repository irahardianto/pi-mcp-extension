import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEBUG_LOG_DIR_MODE,
  DEBUG_LOG_FILE_MODE,
  DEBUG_LOG_FILE_NAME,
  DEBUG_LOG_MAX_BYTES,
  DebugLog,
  getDebugLog,
  isDebugLogEnabled,
  reportDiagnostic,
  setDebugLog,
  setDiagnosticUi,
  type DebugLogFs,
} from "../src/debug-log.js";
import {
  buildLogEntry,
  describeError,
  formatLogLine,
  redactSecrets,
  sanitizeLogFields,
  sanitizeLogText,
} from "../src/debug-log-format.js";
import { McpError } from "../src/errors.js";
import { createMockContext, createMockExtension } from "./helpers/mock-extension.js";

// ─── Fake filesystem ──────────────────────────────────────────────────────────

interface FakeFile {
  content: string;
  mode: number;
}

/**
 * In-memory filesystem for the logger. Rotation is exercised without creating
 * a real 2 MB file.
 */
class FakeFs {
  readonly files = new Map<string, FakeFile>();
  readonly dirs = new Map<string, number>();
  readonly calls: string[] = [];

  get fs(): DebugLogFs {
    return {
      mkdir: async (path, options) => {
        this.calls.push(`mkdir:${path}`);
        this.dirs.set(path, options?.mode ?? 0o777);
        return undefined;
      },
      appendFile: async (path, data, options) => {
        this.calls.push(`append:${path}`);
        const existing = this.files.get(path);
        if (existing) {
          existing.content += data;
        } else {
          this.files.set(path, { content: data, mode: options?.mode ?? 0o666 });
        }
      },
      stat: async (path) => {
        const file = this.files.get(path);
        if (!file) {
          const err = new Error("ENOENT") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return { size: Buffer.byteLength(file.content, "utf8") };
      },
      rename: async (oldPath, newPath) => {
        this.calls.push(`rename:${oldPath}->${newPath}`);
        const file = this.files.get(oldPath);
        if (!file) {
          const err = new Error("ENOENT") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        this.files.delete(oldPath);
        this.files.set(newPath, file);
      },
      chmod: async (path, mode) => {
        this.calls.push(`chmod:${path}:${mode.toString(8)}`);
        const file = this.files.get(path);
        if (file) {
          file.mode = mode;
          return;
        }
        const dir = this.dirs.get(path);
        if (dir !== undefined) {
          this.dirs.set(path, mode);
          return;
        }
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
      unlink: async (path) => {
        this.calls.push(`unlink:${path}`);
        this.files.delete(path);
      },
    };
  }
}

function makeLogger(fake: FakeFs, now = new Date("2026-01-01T00:00:00.000Z")): DebugLog {
  return new DebugLog("/logs", { fs: fake.fs, now: () => now });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("debug log", () => {
  describe("isDebugLogEnabled", () => {
    it("is off unless PI_MCP_DEBUG is set to a truthy value", () => {
      assert.equal(isDebugLogEnabled({}), false);
      assert.equal(isDebugLogEnabled({ PI_MCP_DEBUG: "" }), false);
      assert.equal(isDebugLogEnabled({ PI_MCP_DEBUG: "0" }), false);
      assert.equal(isDebugLogEnabled({ PI_MCP_DEBUG: "false" }), false);
      assert.equal(isDebugLogEnabled({ PI_MCP_DEBUG: "no" }), false);
      assert.equal(isDebugLogEnabled({ PI_MCP_DEBUG: "1" }), true);
      assert.equal(isDebugLogEnabled({ PI_MCP_DEBUG: "true" }), true);
      assert.equal(isDebugLogEnabled({ PI_MCP_DEBUG: "YES" }), true);
      assert.equal(isDebugLogEnabled({ PI_MCP_DEBUG: " on " }), true);
    });
  });

  describe("redactSecrets", () => {
    it("masks tokens, client secrets, authorization codes, PKCE verifiers, and Authorization headers", () => {
      const cases: Array<[string, string]> = [
        ["access_token=abc123SECRET", "abc123SECRET"],
        ["refresh_token=rt-SECRET-value", "rt-SECRET-value"],
        ['"client_secret":"cs-SECRET-value"', "cs-SECRET-value"],
        ["clientSecret=cs-SECRET-value", "cs-SECRET-value"],
        ["code_verifier=verifier-SECRET", "verifier-SECRET"],
        ["codeVerifier=verifier-SECRET", "verifier-SECRET"],
        ["?code=authcode-SECRET&state=abc", "authcode-SECRET"],
        ["Authorization: Bearer tok-SECRET-value", "tok-SECRET-value"],
        ["authorization=Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
        ["sent Bearer tok-SECRET-value to server", "tok-SECRET-value"],
      ];
      for (const [input, secret] of cases) {
        const redacted = redactSecrets(input);
        assert.ok(
          !redacted.includes(secret),
          `Secret leaked for ${JSON.stringify(input)}: ${JSON.stringify(redacted)}`,
        );
        assert.ok(redacted.includes("[REDACTED]"), `Expected a mask in ${JSON.stringify(redacted)}`);
      }
    });

    it("leaves harmless text untouched", () => {
      const text = "Server github closed unexpectedly, reconnecting in 1000ms";
      assert.equal(redactSecrets(text), text);
    });
  });

  describe("sanitizeLogText", () => {
    it("strips terminal escapes, bounds the length, and masks secrets", () => {
      const cleaned = sanitizeLogText("a\x1b[31mred\x1b[0m");
      assert.equal(cleaned, "ared");
      assert.equal(sanitizeLogText("x".repeat(400)).length, 300);
      assert.ok(sanitizeLogText("x".repeat(400)).endsWith("…"));
      assert.ok(!sanitizeLogText("access_token=secret").includes("secret"));
    });
  });

  describe("sanitizeLogFields", () => {
    it("keeps only allow-listed field names", () => {
      const fields = sanitizeLogFields({
        server: "github",
        from: "starting",
        to: "ready",
        ms: 412,
        peerReloaded: true,
        access_token: "should-not-appear",
        authorization: "Bearer should-not-appear",
        // A nested object is not a valid field value; the runtime check drops it too.
        headers: { Authorization: "Bearer should-not-appear" } as unknown as string,
      });
      assert.deepEqual(fields, {
        server: "github",
        from: "starting",
        to: "ready",
        ms: 412,
        peerReloaded: true,
      });
    });

    it("drops undefined and non-finite numbers", () => {
      const fields = sanitizeLogFields({ attempt: undefined, delayMs: Number.NaN, count: 3 });
      assert.deepEqual(fields, { count: 3 });
    });
  });

  describe("describeError", () => {
    it("reports the McpError kind and a sanitized message", () => {
      const described = describeError(new McpError("boom access_token=leak", "github", "auth"));
      assert.equal(described.kind, "auth");
      assert.ok(!described.message.includes("leak"));
    });

    it("falls back to the error name and to 'unknown'", () => {
      assert.equal(describeError(new TypeError("nope")).kind, "TypeError");
      assert.equal(describeError("plain").kind, "unknown");
    });
  });

  describe("buildLogEntry / formatLogLine", () => {
    it("produces one JSON object per line with a stable shape", () => {
      const entry = buildLogEntry({
        ts: new Date("2026-01-01T00:00:00.000Z"),
        level: "info",
        event: "server.state",
        server: "github",
        message: "Server github state starting -> ready",
        fields: { from: "starting", to: "ready", ms: 412, secret: "drop-me" },
      });
      assert.equal(entry.ts, "2026-01-01T00:00:00.000Z");
      assert.equal(entry.level, "info");
      assert.equal(entry.event, "server.state");
      assert.equal(entry.server, "github");
      assert.equal(entry.message, "Server github state starting -> ready");
      assert.equal(entry.ms, 412);
      assert.equal(entry.secret, undefined);

      const line = formatLogLine(entry);
      assert.ok(line.endsWith("\n"));
      assert.equal(line.indexOf("\n"), line.length - 1);
      assert.deepEqual(JSON.parse(line), entry);
    });

    it("keeps a single line even when the message contains newlines", () => {
      const entry = buildLogEntry({
        ts: new Date(0),
        level: "warn",
        event: "server.stderr",
        message: "line1\nline2",
      });
      const line = formatLogLine(entry);
      assert.equal(line.split("\n").filter(Boolean).length, 1);
      assert.ok(!entry.message?.includes("\n"));
    });
  });

  describe("DebugLog", () => {
    it("writes JSON Lines to <dir>/pi-mcp.log with 0o600 in a 0o700 directory", async () => {
      const fake = new FakeFs();
      const logger = makeLogger(fake);
      logger.write({ level: "info", event: "server.state", server: "github", message: "ready" });
      await logger.flush();

      const file = fake.files.get(join("/logs", DEBUG_LOG_FILE_NAME));
      assert.ok(file, "Expected the log file to be created");
      assert.equal(file.mode, DEBUG_LOG_FILE_MODE);
      assert.equal(fake.dirs.get("/logs"), DEBUG_LOG_DIR_MODE);
      const parsed = JSON.parse(file.content) as { event: string; server: string };
      assert.equal(parsed.event, "server.state");
      assert.equal(parsed.server, "github");
    });

    it("rotates to a single backup when the size cap is reached", async () => {
      const fake = new FakeFs();
      const logger = makeLogger(fake);
      const filePath = join("/logs", DEBUG_LOG_FILE_NAME);
      const rotatedPath = join("/logs", "pi-mcp.log.1");
      fake.files.set(filePath, { content: "x".repeat(DEBUG_LOG_MAX_BYTES), mode: DEBUG_LOG_FILE_MODE });
      fake.files.set(rotatedPath, { content: "old backup", mode: DEBUG_LOG_FILE_MODE });

      logger.write({ level: "info", event: "server.state", message: "after rotation" });
      await logger.flush();

      assert.ok(
        fake.calls.includes(`unlink:${rotatedPath}`),
        `Expected the previous backup to be removed, got: ${JSON.stringify(fake.calls)}`,
      );
      assert.ok(
        fake.calls.includes(`rename:${filePath}->${rotatedPath}`),
        `Expected the log to be rotated, got: ${JSON.stringify(fake.calls)}`,
      );
      const rotated = fake.files.get(rotatedPath);
      assert.equal(rotated?.content.length, DEBUG_LOG_MAX_BYTES);
      const current = fake.files.get(filePath);
      assert.ok(current?.content.includes("after rotation"));
      assert.ok(!current?.content.includes("xxxxxxxx"));
    });

    it("does not rotate while the file stays below the cap", async () => {
      const fake = new FakeFs();
      const logger = makeLogger(fake);
      const filePath = join("/logs", DEBUG_LOG_FILE_NAME);
      fake.files.set(filePath, { content: "x".repeat(10), mode: DEBUG_LOG_FILE_MODE });

      logger.write({ level: "info", event: "server.state", message: "small" });
      await logger.flush();

      assert.ok(!fake.calls.some((call) => call.startsWith("rename:")));
      assert.equal(fake.files.get(filePath)?.content.includes("small"), true);
    });

    it("never throws when the filesystem fails", async () => {
      const failing: DebugLogFs = {
        mkdir: async () => {
          throw new Error("EACCES");
        },
        appendFile: async () => {
          throw new Error("EACCES");
        },
        stat: async () => ({ size: 0 }),
        rename: async () => {},
        chmod: async () => {},
        unlink: async () => {},
      };
      const logger = new DebugLog("/logs", { fs: failing, now: () => new Date(0) });
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };
      try {
        logger.write({ level: "info", event: "server.state", message: "x" });
        await logger.flush();
        logger.write({ level: "info", event: "server.state", message: "y" });
        await logger.flush();
      } finally {
        console.error = original;
      }
      // The failure is reported once, and never more than once.
      assert.equal(errors.length, 1);
      assert.ok(errors[0]?.includes("Debug log write failed"));
    });
  });

  describe("reportDiagnostic", () => {
    it("writes to the log file when a debug log is installed", async () => {
      const fake = new FakeFs();
      const logger = makeLogger(fake);
      setDebugLog(logger);
      setDiagnosticUi({ notify: () => {} }, true);
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };
      try {
        reportDiagnostic({
          level: "warn",
          event: "server.state",
          server: "github",
          message: "state changed",
          fields: { from: "starting", to: "ready" },
        });
        await logger.flush();
      } finally {
        console.error = original;
        setDebugLog(null);
        setDiagnosticUi(null, false);
      }

      assert.deepEqual(errors, []);
      const file = fake.files.get(join("/logs", DEBUG_LOG_FILE_NAME));
      assert.ok(file);
      const entry = JSON.parse(file.content) as { level: string; event: string; server: string };
      assert.equal(entry.level, "warn");
      assert.equal(entry.event, "server.state");
      assert.equal(entry.server, "github");
    });

    it("still reports to stderr in headless runs, even with a log installed", async () => {
      const fake = new FakeFs();
      const logger = makeLogger(fake);
      setDebugLog(logger);
      setDiagnosticUi(null, false);
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };
      try {
        reportDiagnostic({ level: "error", event: "config.error", message: "Config error" });
        await logger.flush();
      } finally {
        console.error = original;
        setDebugLog(null);
      }

      assert.deepEqual(errors, ["[pi-mcp] Config error"]);
      const file = fake.files.get(join("/logs", DEBUG_LOG_FILE_NAME));
      assert.ok(file);
      assert.ok(file.content.includes("Config error"));
    });

    it("drops the event while a UI is active and notifies only user-actionable ones", () => {
      const errors: string[] = [];
      const notifications: Array<{ message: string; level: string }> = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };
      try {
        setDiagnosticUi(
          {
            notify: (message, level) => {
              notifications.push({ message, level });
            },
          },
          true,
        );
        reportDiagnostic({ level: "info", event: "server.stderr", message: "child noise" });
        reportDiagnostic({
          level: "error",
          event: "server.tools_refresh_failed",
          message: "Failed to refresh tools",
          notify: true,
        });
      } finally {
        console.error = original;
        setDiagnosticUi(null, false);
      }

      assert.deepEqual(errors, [], "Nothing may be written to stderr while a UI is active");
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]?.message, "pi-mcp: Failed to refresh tools");
      assert.equal(notifications[0]?.level, "error");
    });

    it("falls back to stderr when no UI is available", () => {
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };
      try {
        setDiagnosticUi(null, false);
        reportDiagnostic({ level: "error", event: "config.error", message: "Config error: bad json" });
      } finally {
        console.error = original;
      }
      assert.deepEqual(errors, ["[pi-mcp] Config error: bad json"]);
    });

    it("keeps info-level telemetry off stderr in headless runs", () => {
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };
      try {
        setDiagnosticUi(null, false);
        reportDiagnostic({
          level: "info",
          event: "server.state",
          server: "github",
          message: "Server github state starting -> ready",
        });
        reportDiagnostic({ level: "info", event: "session.started", message: "pi-mcp session started" });
      } finally {
        console.error = original;
      }
      assert.deepEqual(errors, [], "info-level telemetry must stay off headless stderr");
    });

    it("still writes info events flagged stderr to headless stderr (child-server output)", () => {
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };
      try {
        setDiagnosticUi(null, false);
        reportDiagnostic({
          level: "info",
          event: "server.stderr",
          server: "github",
          message: "boot finished",
          stderr: true,
        });
      } finally {
        console.error = original;
      }
      assert.deepEqual(errors, ["[pi-mcp] boot finished"]);
    });

    it("keeps info telemetry off stderr in headless runs even when a log is installed", async () => {
      const fake = new FakeFs();
      const logger = makeLogger(fake);
      setDebugLog(logger);
      setDiagnosticUi(null, false);
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };
      try {
        reportDiagnostic({
          level: "info",
          event: "server.state",
          server: "github",
          message: "Server github state starting -> ready",
        });
        await logger.flush();
      } finally {
        console.error = original;
        setDebugLog(null);
      }

      assert.deepEqual(errors, []);
      const file = fake.files.get(join("/logs", DEBUG_LOG_FILE_NAME));
      assert.ok(file, "The event must still reach the log file");
      assert.ok(file.content.includes("starting -> ready"));
    });
  });

  describe("extension integration", () => {
    interface DebugLogSession {
      mockExt: ReturnType<typeof createMockExtension>;
      ctx: ReturnType<typeof createMockContext>;
      agentDir: string;
    }

    /**
     * Boots the real extension with `PI_MCP_DEBUG` and `PI_CODING_AGENT_DIR`
     * pointed at a temp agent dir, runs `body` between session_start and
     * session_shutdown, and always restores the environment.
     */
    async function withDebugLogSession(
      options: { debug: boolean; prefix: string },
      body: (session: DebugLogSession) => Promise<void>,
    ): Promise<void> {
      const dir = await mkdtemp(join(tmpdir(), options.prefix));
      const agentDir = join(dir, "agent");
      const previousDebug = process.env.PI_MCP_DEBUG;
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      if (options.debug) process.env.PI_MCP_DEBUG = "1";
      else delete process.env.PI_MCP_DEBUG;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        const { default: extension } = await import("../src/index.js");
        const mockExt = createMockExtension();
        const ctx = createMockContext({ cwd: dir, hasUI: false });
        await extension(mockExt.api, { bootstrapCwd: dir, globalConfigPath: join(dir, "mcp.json") });
        await mockExt.events.get("session_start")({}, ctx);
        try {
          await body({ mockExt, ctx, agentDir });
        } finally {
          await mockExt.events.get("session_shutdown")?.({}, ctx);
        }
      } finally {
        setDebugLog(null);
        if (previousDebug === undefined) delete process.env.PI_MCP_DEBUG;
        else process.env.PI_MCP_DEBUG = previousDebug;
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(dir, { recursive: true, force: true });
      }
    }

    it("creates <agentDir>/logs/pi-mcp.log when PI_MCP_DEBUG=1", async () => {
      await withDebugLogSession({ debug: true, prefix: "pi-mcp-debug-log-" }, async ({ agentDir }) => {
        const logger = getDebugLog();
        assert.ok(logger, "Expected a debug log to be installed");
        await logger.flush();

        const logPath = join(agentDir, "logs", DEBUG_LOG_FILE_NAME);
        const contents = await readFile(logPath, "utf-8");
        const entries = contents
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { event: string });
        assert.ok(
          entries.some((entry) => entry.event === "session.started"),
          `Expected a session.started entry, got: ${JSON.stringify(entries)}`,
        );
      });
    });

    it("writes the log file 0o600 inside a 0o700 directory", { skip: process.platform === "win32" && "WHY: file modes are POSIX-only by design; Windows fs.stat reports 0o666" }, async () => {
      await withDebugLogSession({ debug: true, prefix: "pi-mcp-debug-log-mode-" }, async ({ agentDir }) => {
        const logger = getDebugLog();
        assert.ok(logger, "Expected a debug log to be installed");
        await logger.flush();

        const logStat = await stat(join(agentDir, "logs", DEBUG_LOG_FILE_NAME));
        assert.equal(logStat.mode & 0o777, DEBUG_LOG_FILE_MODE);
        const dirStat = await stat(join(agentDir, "logs"));
        assert.equal(dirStat.mode & 0o777, DEBUG_LOG_DIR_MODE);
      });
    });

    it("creates no log file when PI_MCP_DEBUG is not set", async () => {
      await withDebugLogSession({ debug: false, prefix: "pi-mcp-no-debug-log-" }, async ({ agentDir }) => {
        assert.equal(getDebugLog(), null);
        await assert.rejects(() => stat(join(agentDir, "logs", DEBUG_LOG_FILE_NAME)), {
          code: "ENOENT",
        });
      });
    });

    it("never writes a secret to the log file, even when a caller passes one by mistake", async () => {
      await withDebugLogSession({ debug: true, prefix: "pi-mcp-debug-secret-" }, async ({ agentDir }) => {
        const logger = getDebugLog();
        assert.ok(logger);
        const secret = "s3cr3t-value";
        logger.write({
          level: "error",
          event: "oauth.refresh",
          server: "github",
          message: `token refresh failed access_token=${secret}`,
          fields: {
            kind: "auth",
            outcome: "rotated",
            peerReloaded: true,
            access_token: secret,
            client_secret: secret,
          },
        });
        await logger.flush();

        const contents = await readFile(
          join(agentDir, "logs", DEBUG_LOG_FILE_NAME),
          "utf-8",
        );
        assert.ok(!contents.includes(secret), `Secret leaked into the log: ${contents}`);
        assert.ok(contents.includes("[REDACTED]"));
        assert.ok(contents.includes('"peerReloaded":true'));
      });
    });
  });
});
