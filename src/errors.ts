/**
 * Single error class for all MCP-related failures.
 * `code` field enables programmatic discrimination without needing
 * instanceof checks against a hierarchy of classes.
 */

export type McpErrorCode =
  | "config"      // Configuration loading or validation failed
  | "connection"  // Transport/connection failed
  | "auth"        // Authentication/authorization failed
  | "timeout"     // Request or connection timed out
  | "protocol"    // JSON-RPC protocol violation (a server error response, a malformed payload, or a call the caller cancelled)
  | "tool";       // Tool execution error (isError: true from server)

export class McpError extends Error {
  public readonly server: string;
  public readonly code: McpErrorCode;
  public override readonly cause: unknown;

  constructor(
    message: string,
    server: string,
    code: McpErrorCode,
    cause?: unknown,
  ) {
    super(message);
    this.name = "McpError";
    this.server = server;
    this.code = code;
    this.cause = cause;
  }

  /** Short user-facing message suitable for ctx.ui.notify() */
  get userMessage(): string {
    return `[${this.server}] ${this.message}`;
  }
}

export class AuthCancelledError extends Error {
  constructor(serverName: string) {
    super(`Authentication cancelled for ${serverName}`);
    this.name = "AuthCancelledError";
  }
}

export class AuthRequiredError extends Error {
  constructor(
    serverName: string,
    message = `Authorization required for ${serverName}. Connect in an interactive Pi session or use /mcp:auth ${serverName}.`,
  ) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export class AuthLockError extends AuthRequiredError {
  constructor(serverName: string, details?: string) {
    const message = details
      ? details.startsWith("Authorization lock") || details.startsWith("Another Pi process")
        ? details
        : `Another Pi process (${details}) is authorizing ${serverName}. Retry after it finishes.`
      : `Another Pi process is authorizing ${serverName}. Retry after it finishes.`;
    super(serverName, message);
    this.name = "AuthLockError";
  }
}

