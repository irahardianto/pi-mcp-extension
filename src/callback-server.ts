/**
 * MCP OAuth Callback Server
 *
 * Simple HTTP server that handles OAuth callbacks from the authorization server.
 * Uses Node.js http module for compatibility with no external dependencies.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { URL } from "url";

interface PendingAuth {
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

let server: Server | null = null;
let actualServerPort: number | null = null;
const pendingAuths = new Map<string, PendingAuth>();

const DEFAULT_PORT = 19876;
const CALLBACK_PATH = "/callback";
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const HTML_SUCCESS = `<!DOCTYPE html>
<html><head><title>Pi - Authorization Successful</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#eee}
.container{text-align:center;padding:2rem}h1{color:#4ade80;margin-bottom:1rem}p{color:#aaa}</style>
</head><body>
<div class="container"><h1>✓ Authorization Successful</h1><p>You can close this window and return to Pi.</p></div>
<script>setTimeout(()=>window.close(),2000)</script>
</body></html>`;

const HTML_ERROR = (error: string) => `<!DOCTYPE html>
<html><head><title>Pi - Authorization Failed</title>
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
 * Handle incoming HTTP requests to the callback server.
 */
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Only handle the callback path
  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  // Enforce state parameter presence for CSRF protection
  if (!state) {
    const errorMsg = "Missing required state parameter - potential CSRF attack";
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(HTML_ERROR(errorMsg));
    return;
  }

  // Handle OAuth errors
  if (error) {
    const errorMsg = errorDescription || error;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML_ERROR(errorMsg));
    if (pendingAuths.has(state)) {
      const pending = pendingAuths.get(state)!;
      clearTimeout(pending.timeout);
      pendingAuths.delete(state);
      setTimeout(() => pending.reject(new Error(errorMsg)), 0);
    }
    return;
  }

  // Require authorization code
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(HTML_ERROR("No authorization code provided"));
    return;
  }

  // Validate state parameter
  if (!pendingAuths.has(state)) {
    const errorMsg = "Invalid or expired state parameter - potential CSRF attack";
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(HTML_ERROR(errorMsg));
    return;
  }

  const pending = pendingAuths.get(state)!;

  // Clear timeout and resolve the pending promise
  clearTimeout(pending.timeout);
  pendingAuths.delete(state);
  pending.resolve(code);

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(HTML_SUCCESS);
}

/**
 * Ensure the callback server is running.
 * Scans forward for an available local port if the preferred port is busy.
 *
 * @param preferredPort - The preferred port to use (default: 19876)
 * @returns The actual port the server is listening on
 */
export async function ensureCallbackServer(preferredPort: number = DEFAULT_PORT): Promise<number> {
  if (server) {
    // Already running, return the tracked actual port
    if (actualServerPort !== null) {
      return actualServerPort;
    }
    // Fallback: try to get the port from the server
    const address = server.address();
    if (address && typeof address === "object" && "port" in address) {
      actualServerPort = address.port;
      return address.port;
    }
    // If we still can't determine the port, return the preferred port
    // (this shouldn't happen in practice)
    return preferredPort;
  }

  const maxAttempts = 25; // Try up to 25 ports

  for (let offset = 0; offset < maxAttempts; offset++) {
    const candidatePort = preferredPort + offset;
    const candidateServer = createServer(handleRequest);

    try {
      await new Promise<void>((resolve, reject) => {
        candidateServer.once("error", (err: any) => {
          reject(err);
        });

        // Bind to 127.0.0.1 explicitly (IPv4) to avoid issues with IPv6
        candidateServer.listen(candidatePort, "127.0.0.1", () => {
          resolve();
        });
      });

      server = candidateServer;
      actualServerPort = candidatePort;
      server.unref(); // Don't block process exit
      return candidatePort;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      await new Promise<void>((resolve) => {
        candidateServer.close(() => resolve());
      });

      // If not EADDRINUSE, rethrow
      if (nodeError.code !== "EADDRINUSE") {
        throw error;
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
export function waitForCallback(
  oauthState: string,
  timeoutMs: number = TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingAuths.has(oauthState)) {
        pendingAuths.delete(oauthState);
        reject(new Error("OAuth callback timeout - authorization took too long"));
      }
    }, timeoutMs);

    pendingAuths.set(oauthState, { resolve, reject, timeout });
  });
}

/**
 * Cancel a pending authorization by state.
 *
 * @param oauthState - The OAuth state to cancel
 */
export function cancelCallback(oauthState: string): void {
  const pending = pendingAuths.get(oauthState);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingAuths.delete(oauthState);
    pending.reject(new Error("Authorization cancelled"));
  }
}

/**
 * Stop the callback server and reject all pending authorizations.
 */
export async function stopCallbackServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => {
        resolve();
      });
    });
    server = null;
    actualServerPort = null;
  }

  // Reject all pending auths (defer to allow any pending operations to complete)
  const pendingList = Array.from(pendingAuths.entries());
  pendingAuths.clear();
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
export function isCallbackServerRunning(): boolean {
  return server !== null;
}

/**
 * Get the number of pending authorizations.
 */
export function getPendingAuthCount(): number {
  return pendingAuths.size;
}

// Export constants for testing/config
export { DEFAULT_PORT, CALLBACK_PATH, TIMEOUT_MS };
