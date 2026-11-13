/**
 * OS browser process launcher and safe-URL authorization redirect gate.
 *
 * Isolates `node:child_process.spawn` browser invocation, `isSafeAuthorizationUrl`
 * scheme validation, and SSH `-L` / manual paste-back UI notifications from the
 * interactive OAuth flow coordinator (`src/authorize-flow.ts`).
 */

import { spawn } from "node:child_process";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { authPasteOption } from "./authorize-dialog.js";
import { isSafeAuthorizationUrl } from "./callback-url.js";
import { reportDiagnostic } from "./debug-log.js";
import { McpError } from "./errors.js";
import { sanitizeTerminalText } from "./terminal-text.js";

export interface BrowserOpenCommand {
  command: string;
  args: string[];
}

export interface BrowserSpawnOptions {
  detached: true;
  stdio: "ignore";
  windowsHide: true;
}

export interface BrowserChildProcess {
  once(event: "error", listener: (err: Error) => void): unknown;
  once(event: "spawn", listener: () => void): unknown;
  unref(): void;
}

export type BrowserSpawn = (
  command: string,
  args: readonly string[],
  options: BrowserSpawnOptions,
) => BrowserChildProcess;

export interface OpenBrowserDeps {
  platform?: NodeJS.Platform | undefined;
  spawnProcess?: BrowserSpawn | undefined;
  serverName?: string | undefined;
}

export interface BrowserLauncherContext {
  ui: Pick<ExtensionUIContext, "notify">;
}

export interface BrowserLauncherParams {
  serverName: string;
  port: number;
  ctx: BrowserLauncherContext;
  browserOpener: (url: string) => void | Promise<void>;
  isInactive: () => boolean;
  onUrlRecorded: (url: URL) => void;
}

export function browserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): BrowserOpenCommand {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: [url] };
}

/**
 * Open a URL in the user's default browser.
 * Works on macOS, Linux, and Windows.
 */
export function openBrowser(url: string, deps?: OpenBrowserDeps): Promise<void> {
  // WHY: This public entry point must enforce the URL policy independently of its callers,
  // and require a string primitive so a non-string object with a stateful `toString()`
  // cannot pass validation and mutate before `new URL(url)`.
  if (typeof url !== "string" || !isSafeAuthorizationUrl(url)) {
    return Promise.reject(
      new McpError(
        "Refusing to open unsafe authorization URL: only HTTPS (or loopback HTTP) URLs are allowed",
        deps?.serverName ?? "<oauth>",
        "protocol",
      ),
    );
  }
  const safeHref = new URL(url).toString();
  const spawnProcess: BrowserSpawn = deps?.spawnProcess ?? spawn;
  const { command, args } = browserOpenCommand(safeHref, deps?.platform);
  return new Promise<void>((resolve, reject) => {
    const child = spawnProcess(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });

    child.once("error", (err) => {
      reportDiagnostic({
        level: "error",
        event: "auth.browser_open_failed",
        message: `Failed to open browser: ${sanitizeTerminalText(err.message)}`,
      });
      reject(err);
    });

    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Build the `onAuthRequired` hook: refuse unsafe URLs, remember the last URL for
 * "Retry", open the browser, and tell the user how to finish on a remote host.
 */
export function createAuthorizationBrowserLauncher(
  params: BrowserLauncherParams,
): (url: URL) => Promise<void> {
  const { serverName, port, ctx, browserOpener, isInactive, onUrlRecorded } = params;
  return async (url: URL): Promise<void> => {
    if (!isSafeAuthorizationUrl(url)) {
      throw new McpError(
        `Refusing to open unsafe authorization URL for "${serverName}": only HTTPS (or loopback HTTP) URLs are allowed`,
        serverName,
        "protocol",
      );
    }
    const href = url.toString();
    onUrlRecorded(new URL(href));
    if (isInactive()) return;
    try {
      await browserOpener(href);
      ctx.ui.notify(
        `pi-mcp: Authorize ${serverName}: ${href} (On SSH, forward the callback with ssh -L ${port}:127.0.0.1:${port}, or choose "${authPasteOption}".)`,
        "info",
      );
    } catch (err) {
      const detail = sanitizeTerminalText(err instanceof Error ? err.message : String(err));
      ctx.ui.notify(
        `pi-mcp: Failed to open browser for ${serverName} (${detail}). Open ${href} manually or choose "${authPasteOption}".`,
        "error",
      );
    }
  };
}

/**
 * Re-open the last authorization URL when the user retries from the dialog.
 */
export function reopenAuthorizationBrowser(
  launchAuthorizationBrowser: (url: URL) => Promise<void>,
  getLatestAuthorizationUrl: () => URL | undefined,
  serverName: string,
): Promise<void> {
  const latestAuthorizationUrl = getLatestAuthorizationUrl();
  if (!latestAuthorizationUrl) {
    throw new McpError(
      `Authorization URL is not available for ${serverName}`,
      serverName,
      "protocol",
    );
  }
  return launchAuthorizationBrowser(latestAuthorizationUrl);
}
