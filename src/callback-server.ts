/**
 * MCP OAuth Callback Server
 *
 * Simple HTTP server that handles OAuth callbacks from the authorization server.
 * Uses Node.js http module for compatibility with no external dependencies.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import type { Socket } from "net";
import { URL } from "url";
import { CallbackUrlValidationError, isLocalCallbackHost, parseCallbackUrl } from "./callback-url.js";

interface PendingAuth {
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const DEFAULT_PORT = 19876;
const DEFAULT_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";

export interface CallbackServerOptions {
  /** Host to bind. Defaults to 127.0.0.1 for local-only callbacks. */
  host?: string | undefined;
  /** Whether to scan following ports when the preferred port is busy. */
  allowPortFallback?: boolean | undefined;
}

export interface CallbackServerConfig {
  preferredPort: number;
  host: string;
  allowPortFallback: boolean;
}
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const HTML_SUCCESS = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Pi - Authorization Successful</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#eee}
.container{text-align:center;padding:2rem}h1{color:#4ade80;margin-bottom:1rem}p{color:#aaa}</style>
</head><body>
<div class="container"><h1>✓ Authorization Successful</h1><p>You can close this window and return to Pi.</p></div>
<script>setTimeout(()=>window.close(),2000)</script>
</body></html>`;

const HTML_ERROR = (error: string) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Pi - Authorization Failed</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#eee}
.container{text-align:center;padding:2rem}h1{color:#f87171;margin-bottom:1rem}p{color:#aaa}
.error{color:#fca5a5;font-family:monospace;margin-top:1rem;padding:1rem;background:rgba(248,113,113,0.1);border-radius:.5rem;white-space:pre-wrap;word-break:break-word}</style>
</head><body>
<div class="container"><h1>✗ Authorization Failed</h1><p>An error occurred during authorization.</p><div class="error">${escapeHtml(error)}</div></div>
</body></html>`;

/**
 * Escape HTML entities to prevent XSS attacks.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Whether a `listen` failure is a port already taken by another process.
 */
function isAddressInUseError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

/**
 * Build callback server settings from the configured OAuth redirect URL.
 *
 * Local HTTP redirect URLs must use a fixed listener port because OAuth
 * providers require exact redirect URI registration. When no local redirect URL
 * is configured, the callback server keeps the historical default behavior and
 * scans forward from the default port if needed.
 */
export function callbackServerConfigFromRedirectUrl(redirectUrl?: string): CallbackServerConfig {
  // WHY: Only treat `undefined` (omitted) as default; an explicit empty string `""`
  // must fall through to `new URL("")` and throw a validation error.
  if (redirectUrl === undefined) {
    return {
      preferredPort: DEFAULT_PORT,
      host: DEFAULT_HOST,
      allowPortFallback: true,
    };
  }

  const url = new URL(redirectUrl);
  if (url.protocol !== "http:" || !isLocalCallbackHost(url.hostname)) {
    throw new Error("Manual OAuth redirect URL must use HTTP with localhost, 127.0.0.1, or ::1");
  }

  if (url.hash) {
    throw new Error("Manual OAuth redirect URL must not include a fragment");
  }

  if (url.username || url.password) {
    throw new Error("Manual OAuth redirect URL must not include credentials");
  }

  if (url.pathname !== CALLBACK_PATH) {
    throw new Error(`Local OAuth redirect URL must use path ${CALLBACK_PATH}`);
  }

  if (!url.port) {
    throw new Error("Manual OAuth redirect URL must include an explicit port (e.g. http://127.0.0.1:19876/callback)");
  }

  const preferredPort = Number(url.port);
  if (preferredPort === 0) {
    throw new Error("Manual OAuth redirect URL must use a fixed non-zero port");
  }

  return {
    preferredPort,
    host: url.hostname === "[::1]" ? "::1" : url.hostname,
    allowPortFallback: false,
  };
}

/**
 * Instance-scoped HTTP server that handles OAuth callbacks from the authorization server.
 */
export class CallbackServer {
  private server: Server | null = null;
  private actualServerPort: number | null = null;
  private actualServerHost: string | null = null;
  private readonly serverSockets = new Set<Socket>();
  private readonly pendingAuths = new Map<string, PendingAuth>();

  /**
   * Handle incoming HTTP requests to the callback server.
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    let parsed: ReturnType<typeof parseCallbackUrl>;
    try {
      const requestUrl = new URL(req.url || "/", "http://localhost").toString();
      parsed = parseCallbackUrl(requestUrl, {
        expectedState: (state) => this.pendingAuths.has(state),
      });
    } catch (err) {
      if (err instanceof CallbackUrlValidationError) {
        if (err.reason === "wrong_path") {
          res.writeHead(404, { "Content-Type": "text/plain", "Connection": "close" });
          res.end("Not found");
          return;
        }
        res.writeHead(400, { "Content-Type": "text/html", "Connection": "close" });
        res.end(HTML_ERROR(err.message));
        return;
      }
      res.writeHead(400, { "Content-Type": "text/html", "Connection": "close" });
      res.end(HTML_ERROR("Invalid callback request"));
      return;
    }

    // Handle OAuth errors
    if ("error" in parsed) {
      res.writeHead(200, { "Content-Type": "text/html", "Connection": "close" });
      res.end(HTML_ERROR(parsed.error));
      if (this.pendingAuths.has(parsed.state)) {
        const pending = this.pendingAuths.get(parsed.state)!;
        clearTimeout(pending.timeout);
        this.pendingAuths.delete(parsed.state);
        setTimeout(() => pending.reject(new Error(parsed.error)), 0);
      }
      return;
    }

    const pending = this.pendingAuths.get(parsed.state)!;

    // Clear timeout and resolve the pending promise
    clearTimeout(pending.timeout);
    this.pendingAuths.delete(parsed.state);
    pending.resolve(parsed.code);

    res.writeHead(200, { "Content-Type": "text/html", "Connection": "close" });
    res.end(HTML_SUCCESS);
  }

  private async closeCurrentServer(): Promise<void> {
    if (!this.server) return;

    const currentServer = this.server;
    this.server = null;
    this.actualServerPort = null;
    this.actualServerHost = null;

    for (const socket of Array.from(this.serverSockets)) {
      socket.destroy();
    }
    this.serverSockets.clear();

    await new Promise<void>((resolve) => {
      currentServer.close(() => {
        resolve();
      });
    });
  }

  /**
   * Backfill `actualServerPort` from the live listener address when it was not
   * recorded at listen time.
   */
  private _syncActualServerPort(): void {
    if (this.actualServerPort !== null) return;

    const address = this.server?.address();
    if (address && typeof address === "object" && "port" in address) {
      this.actualServerPort = address.port;
    }
  }

  /**
   * Reuse the running listener when it already matches the requested port/host,
   * otherwise close it. Returns the port to short-circuit `ensure` with, or
   * `null` when the caller must bind a new listener.
   */
  private async _reuseOrCloseExistingServer(preferredPort: number, host: string): Promise<number | null> {
    if (!this.server) return null;

    this._syncActualServerPort();
    const serverMatchesRequest = this.actualServerPort === preferredPort && this.actualServerHost === host;
    if (serverMatchesRequest && this.actualServerPort !== null) {
      return this.actualServerPort;
    }

    if (this.pendingAuths.size > 0) {
      throw new Error(
        `OAuth callback server is already handling an authorization flow on ${this.actualServerHost}:${this.actualServerPort}`
      );
    }

    await this.closeCurrentServer();
    return null;
  }

  /**
   * Bind a candidate listener, wiring socket tracking. Closes the candidate again
   * before rethrowing so a failed attempt leaks neither a socket nor a listener.
   */
  private async _tryListenOnPort(candidatePort: number, host: string): Promise<Server> {
    const candidateServer = createServer((req, res) => this.handleRequest(req, res));

    try {
      candidateServer.on("connection", (socket: Socket) => {
        this.serverSockets.add(socket);
        socket.once("close", () => {
          this.serverSockets.delete(socket);
        });
      });

      await new Promise<void>((resolve, reject) => {
        candidateServer.once("error", (err: Error) => {
          reject(err);
        });

        candidateServer.listen(candidatePort, host, () => {
          resolve();
        });
      });
      return candidateServer;
    } catch (error) {
      await new Promise<void>((resolve) => {
        candidateServer.close(() => resolve());
      });
      throw error;
    }
  }

  /**
   * Ensure the callback server is running.
   * Scans forward for an available local port when port fallback is enabled.
   *
   * @param preferredPort - The preferred port to use (default: 19876)
   * @returns The actual port the server is listening on
   */
  async ensure(preferredPort: number = DEFAULT_PORT, options: CallbackServerOptions = {}): Promise<number> {
    const host = options.host ?? DEFAULT_HOST;
    const allowPortFallback = options.allowPortFallback ?? true;

    const reusablePort = await this._reuseOrCloseExistingServer(preferredPort, host);
    if (reusablePort !== null) return reusablePort;

    const maxAttempts = allowPortFallback ? 25 : 1; // Try up to 25 ports unless a fixed redirect URI is configured

    for (let offset = 0; offset < maxAttempts; offset++) {
      const candidatePort = preferredPort + offset;

      try {
        this.server = await this._tryListenOnPort(candidatePort, host);
        this.actualServerPort = candidatePort;
        this.actualServerHost = host;
        this.server.unref(); // Don't block process exit
        return candidatePort;
      } catch (error) {
        // If not EADDRINUSE, rethrow
        if (!isAddressInUseError(error)) {
          throw error;
        }

        if (!allowPortFallback) {
          throw new Error(`OAuth callback port ${preferredPort} is already in use, and redirect URL requires this exact port`);
        }
      }
    }

    throw new Error(
      `OAuth callback port ${preferredPort} is already in use and no free port was found in range ${preferredPort}-${preferredPort + maxAttempts - 1}`
    );
  }

  /**
   * Wait for a callback with the given OAuth state.
   * Returns a promise that resolves with the authorization code.
   *
   * @param oauthState - The OAuth state parameter to wait for
   * @param timeoutMs - Timeout in milliseconds (default: 5 minutes)
   * @returns Promise that resolves with the authorization code
   */
  waitForCallback(
    oauthState: string,
    timeoutMs: number = TIMEOUT_MS
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingAuths.has(oauthState)) {
          this.pendingAuths.delete(oauthState);
          reject(new Error("OAuth callback timeout - authorization took too long"));
        }
      }, timeoutMs);

      this.pendingAuths.set(oauthState, { resolve, reject, timeout });
    });
  }

  /**
   * Cancel a pending authorization by state.
   *
   * @param oauthState - The OAuth state to cancel
   */
  cancel(oauthState: string): void {
    const pending = this.pendingAuths.get(oauthState);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingAuths.delete(oauthState);
      pending.reject(new Error("Authorization cancelled"));
    }
  }

  /**
   * Stop the callback server and reject all pending authorizations.
   */
  async stop(): Promise<void> {
    await this.closeCurrentServer();

    // Reject all pending auths (defer to allow any pending operations to complete)
    const pendingList = Array.from(this.pendingAuths.entries());
    this.pendingAuths.clear();
    setTimeout(() => {
      for (const [, pending] of pendingList) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("OAuth callback server stopped"));
      }
    }, 0);
  }

  /**
   * Check if the callback server is running.
   */
  isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Get the number of pending authorizations.
   */
  pendingCount(): number {
    return this.pendingAuths.size;
  }
}

// Export constants for testing/config
export { DEFAULT_PORT, DEFAULT_HOST, CALLBACK_PATH, TIMEOUT_MS };
