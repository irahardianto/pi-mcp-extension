import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  browserOpenCommand,
  createAuthorizationBrowserLauncher,
  openBrowser,
  reopenAuthorizationBrowser,
  type BrowserChildProcess,
  type BrowserSpawnOptions,
} from "../src/authorize-browser.js";
import {
  browserOpenCommand as reExportedBrowserOpenCommand,
  openBrowser as reExportedOpenBrowser,
} from "../src/authorize-flow.js";
import { authPasteOption } from "../src/authorize-dialog.js";
import {
  DebugLog,
  getDebugLog,
  isUiActive,
  setDebugLog,
  setDiagnosticUi,
  type DebugLogEntry,
} from "../src/debug-log.js";
import { McpError } from "../src/errors.js";

class FakeBrowserChild extends EventEmitter implements BrowserChildProcess {
  unreferenced = false;

  unref(): void {
    this.unreferenced = true;
  }
}

describe("authorize-browser", () => {
  describe("re-export and dependency boundary", () => {
    it("re-exports browserOpenCommand and openBrowser from src/authorize-flow.ts", () => {
      assert.equal(reExportedBrowserOpenCommand, browserOpenCommand);
      assert.equal(reExportedOpenBrowser, openBrowser);
    });

    it("keeps node:child_process out of src/authorize-flow.ts", async () => {
      const flowPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../src/authorize-flow.ts",
      );
      const source = await fs.readFile(flowPath, "utf8");
      assert.doesNotMatch(source, /child_process/);
    });
  });

  describe("browserOpenCommand", () => {
    const sampleUrl = "https://auth.example.com/authorize?client_id=abc&state=xyz";

    it("selects open on darwin, rundll32 on win32, and xdg-open on linux/other POSIX", () => {
      assert.deepEqual(browserOpenCommand(sampleUrl, "darwin"), {
        command: "open",
        args: [sampleUrl],
      });
      assert.deepEqual(browserOpenCommand(sampleUrl, "win32"), {
        command: "rundll32",
        args: ["url.dll,FileProtocolHandler", sampleUrl],
      });
      assert.deepEqual(browserOpenCommand(sampleUrl, "linux"), {
        command: "xdg-open",
        args: [sampleUrl],
      });
      assert.deepEqual(browserOpenCommand(sampleUrl, "freebsd"), {
        command: "xdg-open",
        args: [sampleUrl],
      });
    });

    it("passes shell metacharacters literally without shell splitting", () => {
      const trickyUrl = 'https://auth.example.com/authorize?x=$(id)&q="a b"&semi=;whoami';
      for (const platform of ["darwin", "win32", "linux"] as const) {
        const result = browserOpenCommand(trickyUrl, platform);
        assert.equal(result.args.at(-1), trickyUrl);
      }
    });
  });

  describe("openBrowser", () => {
    it("spawns detached with stdio ignore and windowsHide, unrefs on spawn, and resolves", async () => {
      const child = new FakeBrowserChild();
      let capturedCommand = "";
      let capturedArgs: readonly string[] = [];
      let capturedOptions: BrowserSpawnOptions | undefined;

      const promise = openBrowser("https://auth.example.com/authorize?state=s1", {
        platform: "linux",
        spawnProcess: (command, args, options) => {
          capturedCommand = command;
          capturedArgs = args;
          capturedOptions = options;
          queueMicrotask(() => {
            child.emit("spawn");
          });
          return child;
        },
      });

      await promise;
      assert.equal(capturedCommand, "xdg-open");
      assert.deepEqual(capturedArgs, ["https://auth.example.com/authorize?state=s1"]);
      assert.deepEqual(capturedOptions, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      assert.equal("shell" in (capturedOptions ?? {}), false);
      assert.equal(child.unreferenced, true);
    });

    it("logs a sanitized diagnostic without the URL on spawn error and rejects", async () => {
      const lines: string[] = [];
      const prevLogger = getDebugLog();
      const prevUiActive = isUiActive();
      const logger = new DebugLog("/virtual/logs/pi-mcp.log", {
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        fs: {
          mkdir: async () => undefined,
          appendFile: async (_filePath, data) => {
            lines.push(data);
          },
          stat: async () => ({ size: 0 }),
          rename: async () => undefined,
          chmod: async () => undefined,
        },
      });
      setDebugLog(logger);
      setDiagnosticUi({ notify: () => {} }, true);

      try {
        const child = new FakeBrowserChild();
        const secretUrl =
          "https://auth.example.com/authorize?state=secret-csrf-state&code_challenge=pkce-xyz";

        await assert.rejects(
          () =>
            openBrowser(secretUrl, {
              platform: "darwin",
              spawnProcess: () => {
                queueMicrotask(() => {
                  child.emit("error", new Error("spawn \u001b[31mopen\u001b[0m ENOENT"));
                });
                return child;
              },
            }),
          /ENOENT/,
        );

        await logger.flush();
        assert.equal(lines.length, 1);
        const entry = JSON.parse(lines[0]!) as DebugLogEntry;
        assert.equal(entry.level, "error");
        assert.equal(entry.event, "auth.browser_open_failed");
        assert.equal(entry.message, "Failed to open browser: spawn open ENOENT");
        assert.equal(entry.message.includes("secret-csrf-state"), false);
        assert.equal(entry.message.includes("auth.example.com"), false);
        assert.equal(child.unreferenced, false);
      } finally {
        setDebugLog(prevLogger);
        setDiagnosticUi(null, prevUiActive);
      }
    });
  });

  describe("createAuthorizationBrowserLauncher", () => {
    it("rejects unsafe schemes before recording or opening the URL", async () => {
      const unsafeUrls = [
        new URL("javascript:alert(1)"),
        new URL("file:///etc/passwd"),
        new URL("data:text/html,<script>alert(1)</script>"),
        new URL("http://evil.example.com/authorize?state=123"),
      ];

      for (const unsafeUrl of unsafeUrls) {
        let recorded = false;
        let opened = false;
        const notifications: Array<{ message: string; type: string | undefined }> = [];
        const launch = createAuthorizationBrowserLauncher({
          serverName: "remote-srv",
          port: 51734,
          ctx: {
            ui: {
              notify: (message, type) => {
                notifications.push({ message, type });
              },
            },
          },
          browserOpener: () => {
            opened = true;
          },
          isInactive: () => false,
          onUrlRecorded: () => {
            recorded = true;
          },
        });

        await assert.rejects(
          () => launch(unsafeUrl),
          (err: unknown) => {
            assert.ok(err instanceof McpError);
            assert.equal(err.code, "protocol");
            assert.equal(err.server, "remote-srv");
            assert.match(err.message, /Refusing to open unsafe authorization URL for "remote-srv"/);
            return true;
          },
        );
        assert.equal(recorded, false, `must not record unsafe URL ${unsafeUrl.protocol}`);
        assert.equal(opened, false, `must not open unsafe URL ${unsafeUrl.protocol}`);
        assert.deepEqual(notifications, []);
      }
    });

    it("opens safe HTTPS and loopback HTTP URLs, clones the recorded URL, and emits the SSH -L hint", async () => {
      const safeUrls = [
        new URL("https://auth.example.com/oauth/authorize?client_id=c1&state=s1"),
        new URL("http://127.0.0.1:8080/oauth/authorize?state=s2"),
        new URL("http://localhost:8080/oauth/authorize?state=s3"),
        new URL("http://[::1]:8080/oauth/authorize?state=s4"),
      ];

      for (const safeUrl of safeUrls) {
        let recordedUrl: URL | undefined;
        const openedUrls: string[] = [];
        const notifications: Array<{ message: string; type: string | undefined }> = [];
        const launch = createAuthorizationBrowserLauncher({
          serverName: "my-mcp",
          port: 43123,
          ctx: {
            ui: {
              notify: (message, type) => {
                notifications.push({ message, type });
              },
            },
          },
          browserOpener: async (href) => {
            openedUrls.push(href);
          },
          isInactive: () => false,
          onUrlRecorded: (url) => {
            recordedUrl = url;
          },
        });

        await launch(safeUrl);

        assert.ok(recordedUrl);
        assert.notEqual(recordedUrl, safeUrl, "recorded URL should be a defensive copy");
        assert.equal(recordedUrl.toString(), safeUrl.toString());
        assert.deepEqual(openedUrls, [safeUrl.toString()]);
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0]?.type, "info");
        assert.equal(
          notifications[0]?.message,
          `pi-mcp: Authorize my-mcp: ${safeUrl.toString()} (On SSH, forward the callback with ssh -L 43123:127.0.0.1:43123, or choose "${authPasteOption}".)`,
        );
      }
    });

    it("records a safe URL without opening the browser or notifying when inactive", async () => {
      let recordedUrl: URL | undefined;
      let opened = false;
      const notifications: string[] = [];
      const launch = createAuthorizationBrowserLauncher({
        serverName: "aborted-srv",
        port: 19876,
        ctx: {
          ui: {
            notify: (message) => {
              notifications.push(message);
            },
          },
        },
        browserOpener: () => {
          opened = true;
        },
        isInactive: () => true,
        onUrlRecorded: (url) => {
          recordedUrl = url;
        },
      });

      const authUrl = new URL("https://auth.example.com/authorize?state=abc");
      await launch(authUrl);

      assert.equal(recordedUrl?.toString(), authUrl.toString());
      assert.equal(opened, false);
      assert.deepEqual(notifications, []);
    });

    it("sanitizes Error and non-Error browserOpener failures and emits the paste fallback error notification", async () => {
      const notifications: Array<{ message: string; type: string | undefined }> = [];
      let callCount = 0;
      const launch = createAuthorizationBrowserLauncher({
        serverName: "headless-srv",
        port: 33333,
        ctx: {
          ui: {
            notify: (message, type) => {
              notifications.push({ message, type });
            },
          },
        },
        browserOpener: async () => {
          callCount += 1;
          if (callCount === 1) {
            throw new Error("spawn \u001b[31mxdg-open\u001b[0m ENOENT\nsecond line");
          }
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject("plain\u0007failure");
        },
        isInactive: () => false,
        onUrlRecorded: () => {},
      });

      const authUrl = new URL("https://auth.example.com/authorize?state=xyz");
      await launch(authUrl);
      await launch(authUrl);

      assert.equal(notifications.length, 2);
      assert.deepEqual(notifications[0], {
        type: "error",
        message: `pi-mcp: Failed to open browser for headless-srv (spawn xdg-open ENOENT second line). Open ${authUrl.toString()} manually or choose "${authPasteOption}".`,
      });
      assert.deepEqual(notifications[1], {
        type: "error",
        message: `pi-mcp: Failed to open browser for headless-srv (plainfailure). Open ${authUrl.toString()} manually or choose "${authPasteOption}".`,
      });
    });
  });

  describe("reopenAuthorizationBrowser", () => {
    it("throws a protocol McpError when no authorization URL has been recorded yet", () => {
      assert.throws(
        () =>
          reopenAuthorizationBrowser(
            async () => {
              assert.fail("launcher must not be called without a recorded URL");
            },
            () => undefined,
            "srv-missing-url",
          ),
        (err: unknown) => {
          assert.ok(err instanceof McpError);
          assert.equal(err.code, "protocol");
          assert.equal(err.server, "srv-missing-url");
          assert.equal(err.message, "Authorization URL is not available for srv-missing-url");
          return true;
        },
      );
    });

    it("replays the latest recorded authorization URL through launchAuthorizationBrowser", async () => {
      const replayed: string[] = [];
      const latestUrl = new URL("https://auth.example.com/authorize?state=retry-state");

      await reopenAuthorizationBrowser(
        async (url) => {
          replayed.push(url.toString());
        },
        () => latestUrl,
        "srv-retry",
      );

      assert.deepEqual(replayed, [latestUrl.toString()]);
    });
  });
});
