# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
