/**
 * Single error class for all MCP-related failures.
 * `code` field enables programmatic discrimination without needing
 * instanceof checks against a hierarchy of classes.
 */

export type McpErrorCode =
  | "config"      // Configuration loading or validation failed
  | "connection"  // Transport/connection failed
  | "protocol"    // JSON-RPC protocol violation (server error response, timeout, etc.)
  | "tool";       // Tool execution error (isError: true from server)

export class McpError extends Error {
  public readonly server: string;
  public readonly code: McpErrorCode;
  public readonly cause: unknown;

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
