# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Upgrade the `zod` runtime dependency from 3.x to `^4.6.5` (#95). Existing `mcp.json` configs load and validate exactly as before. Some config validation messages that come from Zod's built-in errors now use Zod 4 wording (e.g. `Invalid url` → `Invalid URL`, `Number must be greater than 0` → `Too small: expected number to be >0`). Messages that pi-mcp defines itself are unchanged.

## [1.9.10] - 2026-10-19

### Fixed
- Tighten `isOAuthUnauthorizedError` message-text fallback patterns so unrelated `: 401` and `Unauthorized` substrings in non-HTTP errors no longer trigger unwanted OAuth flows (#81).

## [1.9.9] - 2026-10-18

### Security
- Sanitize server-controlled text (`notifications/message` payloads, error messages, and status summaries) with `sanitizeTerminalText` to strip ANSI/OSC/DCS/C0/C1 escape sequences, collapse line breaks, and bound length before writing to `stderr`, log buffers, or `ctx.ui.notify(...)` (#66).

## [1.9.8] - 2026-10-18

### Security
- **OAuth authorization-server issuer binding (GHSA-6qxp-vccf-f47h)**: Require patched `@modelcontextprotocol/sdk` (`^1.32.1`) and persist the authorization server `issuer` property on stored client information and OAuth tokens. This prevents an untrusted or compromised MCP server from directing stored refresh tokens or client credentials to an arbitrary authorization server. Existing credentials saved prior to this fix remain valid and are stamped with their authorization server issuer on first use. Users who may have connected to untrusted MCP servers should revoke credentials and run `/mcp:auth <server> --reset` to force fresh client registration and re-authorization.

## [1.9.7] - 2026-10-17

### Fixed
- Detach the retry-backoff `abort` listener from the connection `AbortSignal` when the backoff timer fires normally so retries do not accumulate stale listeners (#67).

## [1.9.6] - 2026-10-17

## [1.9.5] - 2026-10-17

## [1.9.4] - 2026-10-17

## [1.9.3] - 2026-10-17

## [1.9.2] - 2026-10-17

### Fixed
- **JSONC Config Support & Load-Time Validation (#28)**: Strip `//` and `/* */` JSONC comments before parsing `mcp.json`, wrap read/parse errors in `McpError` with the offending file path, enforce `/^[a-zA-Z][a-zA-Z0-9_]*$/` on `toolPrefix`, validate `auth.redirectUrl` (and `callbackUrl`/`callbackPort` aliases) at load time, and reject `auth` on `stdio` servers.

## [1.9.1] - 2026-10-17

### Added
- Support Pi 1.x extension-registered MCP servers via `pi.getMcpServers()` and live `mcp_servers_change` updates when replacing `builtin:mcp`, while preserving `mcp.json` precedence (#17).
- Support Pi 1.x server configuration aliases: URL-only HTTP entries (defaulting `transport` to `"streamable-http"`), `type` / `transport: "http"`, `oauth` (`redirectUrl`, `callbackUrl`, `callbackPort`), and `timeout` in seconds (#17).

### Changed
- Migrate peer dependencies and type imports from deprecated `@mariozechner/*` packages to `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` (#17).

### Security
- Enforce Pi's project trust boundary: never read `<cwd>/.pi/mcp.json` during bootstrap or when `ctx.isProjectTrusted()` is `false` (#17).

## [1.9.0] - 2026-10-17

### Added
- Eager OAuth servers that need interactive authorization at startup now offer a sequential `Authorize now` / `Not now` prompt instead of failing silently (#7).

### Fixed
- Silent startup and background reconnects no longer trigger Dynamic Client Registration when no client credentials are stored, avoiding orphan OAuth client registrations.

## [1.8.0] - 2026-10-17

### Added
- Headless/SSH authorization: the authorization URL is shown in Pi, and a new "Paste redirect URL" option completes the flow when the local callback is unreachable.

### Security
- Only `https:` (or loopback `http:`) authorization URLs are passed to the system browser opener.

## [1.7.3] - 2026-10-17

### Fixed
- Automatically reclaim stale OAuth authorization locks (`<hash>.json.lock`) using PID liveness checks, a 30-second heartbeat (90-second staleness threshold), and nonce-verified atomic lock replacement, while verifying lock ownership before interactive credential writes.
- Keep PKCE `codeVerifier` in memory per authorization flow and allow silent token refresh (`saveTokens`) to persist rotated tokens even while an interactive lock is held, falling back to an in-memory token cache if disk writes fail.
- Persist OAuth state files atomically via temporary files and back up corrupt state files to `<hash>.json.corrupt-<timestamp>` with a configuration error instead of silently ignoring corruption.

## [1.7.2] - 2026-10-17

### Changed
- `auth.redirectUrl` must include an explicit port (e.g. `http://127.0.0.1:19876/callback`). Previously a missing port fell back to 80.

### Fixed
- The stdio server SIGKILL safety net now captures the child PID from `StdioClientTransport.pid`.
- `/mcp:auth <name> --reset` reports failures to delete credentials instead of claiming success.
- OAuth-configured servers that surface `UnauthorizedError` or HTTP 401 transport errors during connection fail fast with `AuthRequiredError` instead of retrying, allowing interactive authorization to proceed (#1).

## [1.7.1] - 2026-10-17

### Fixed
- Resolve the global `mcp.json` and `mcp-auth` storage directory through `$PI_CODING_AGENT_DIR` (with tilde expansion) when set, falling back to `~/.pi/agent` (#5, #6).
- Project `.pi/mcp.json` files now override only the `settings` keys they explicitly state instead of replacing global settings with schema defaults (#6).

## [1.7.0] - 2026-10-17

### Added
- `mcp_status` and `mcp_connect` agent tools for on-demand inspection and connection of configured MCP servers, verifying active tools before reporting readiness (#8).

## [1.6.0] - 2026-10-17

### Added
- Server-name argument autocomplete for `/mcp`, `/mcp:start`, `/mcp:stop`, and `/mcp:auth` (#3).

## [1.5.4] - 2026-10-16

### Fixed
- Filter non-text content blocks when an MCP tool call returns `isError: true` and add image passthrough tests (#9).

## [1.5.3] - 2026-10-16

### Fixed
- Pass through MCP image content blocks (`type: "image"`) to Pi tool results (#9).

## [1.5.2] - 2026-10-16

### Fixed
- Automatically deactivate tools and reconnect when an MCP server's transport closes unexpectedly (#10).

## [1.5.1] - 2026-10-04

### Changed
- **Behavior change:** `/mcp:auth <name>` now reuses stored credentials and opens the browser
  only if authorization is actually required. Use `/mcp:auth <name> --reset` for the previous
  behavior (discard stored credentials and re-authorize) (#4).
- Eager startup and background reconnection never open a browser. When interactive
  authorization is required, the server stops and reports how to authorize, without retrying (#4).
- Interactive authorization requires an interactive Pi session. Print/RPC modes fail promptly (#4).

### Added
- Protected-resource metadata and scope are discovered from the server's `WWW-Authenticate`
  challenge (#4).
- A configured loopback `redirectUrl` binds its exact host and port (#4).
- Retry/Cancel controls while authorization is pending. Concurrent connects and resets are coordinated (#4).
- Server names containing spaces are supported in `/mcp:auth` (#4).

### Fixed
- Stop, cancellation, and shutdown cancel pending retries, callbacks, and late readiness (#4).

### Removed
- The `MCP_OAUTH_CALLBACK_PORT` documentation. This variable was documented in 1.5.0 but was
  never implemented. Configure `auth.redirectUrl` with an explicit port instead (#4).

## [1.5.0] - 2026-05-03

### Added
- OAuth 2.1 support with PKCE, dynamic client registration, and `/mcp:auth`.
