# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.11.1] - 2026-10-26

### Added
- Pi 1.3.0 `McpStdioServerConfig.cwd` is honored for stdio servers (`pi mcp add --cwd <dir>`), so a server can be spawned in its own working directory: a relative path resolves against the session working directory and a leading `~` expands to your home directory. A `cwd` on a `streamable-http` or `sse` entry is rejected at load time.
- Pi 1.3.0 `oauth.clientName` (also accepted as `auth.clientName`) sets the `client_name` sent with Dynamic Client Registration (default `pi-mcp/<server name>`), for authorization servers that only accept known clients.

### Fixed
- A Pi 1.3.0 project override entry in `<cwd>/.pi/mcp.json` (`{ "internal-tools": { "enabled": false } }` — no `command`/`url`) no longer fails validation with `"command" is required for stdio transport` and tears down every global MCP server for the session: the override is merged onto the raw global entry (keeping its command, URL, headers, and OAuth config) and may only set `enabled`, `lifecycle`, Pi's `exposure`, or `toolExposure` (the two exposure keys are accepted for Pi compatibility and ignored). An override for a name no global entry defines, or with any other key, is a config error naming the file and the server (#215).
- `enabled: false` in `mcp.json`, `.pi/mcp.json`, or a `pi.registerMcpServer()` config now keeps the server out of the eager set (normalized to `lifecycle: "lazy"`) even when `lifecycle: "eager"` is also set, and a non-boolean `enabled` is rejected at load time instead of being silently ignored (#215).
- Pi's `auth.provider` (`/login` provider token) is rejected with a `config` error at load time instead of being silently stripped and downgraded to OAuth 2.1 Dynamic Client Registration, which could register a client against a server the user never meant to authorize that way (#215).

## [1.11.0] - 2026-10-26

### Added
- `/mcp <name>` now explains a server instead of only printing its state: the config source (`global`, `project`, or `extension`), transport and lifecycle, `Tools: <active>/<discovered> active`, the OAuth credential summary for servers with an `auth` config, a single troubleshooting `Hint:` when the server failed (`/mcp:auth <name>` or `--reset` for authorization failures, auth-lock contention, or `PI_MCP_DEBUG=1 pi` plus the issue tracker for connection failures), and a note when the project's `.pi/mcp.json` was skipped because the project is untrusted. A corrupt stored OAuth state file is reported as backed up and never breaks the view (#196).
- `mcp_status` reports a `source` field (`global`, `project`, `extension`, or `unknown`) on every row, so an agent can tell a global entry from a project override or a `pi.registerMcpServer()` entry (#196).

## [1.10.2] - 2026-10-23

### Security

- Bump `zod` runtime dependency floor to `^4.6.7` (`GHSA-mrhx-c7xc-m3w5`) and update transitive lockfile dependencies `body-parser` to `2.4.0` (`GHSA-27r3-jxmh-p828`) and `fast-uri` to `3.1.9` (`GHSA-w74x-v6f9-j3xg`, `GHSA-xhq7-xmqj-769h`, `GHSA-wjr9-j795-jxcr`, `GHSA-333x-w4r6-6crp`).

## [1.10.1] - 2026-10-23

### Fixed

- Release tooling: the automated release now fetches the squash-merge commit of its release PR before creating the `vX.Y.Z` tag (the runner's clone has never seen that commit, so the tag previously failed after the merge and only the next run repaired it).
- Release tooling: the release PR's required checks are now satisfied by approving and awaiting the `pull_request` runs the PR itself records. The release PR is opened with `GITHUB_TOKEN`, so GitHub records those runs but never executes them (`action_required`), and `GITHUB_TOKEN` may not approve a workflow run — while check runs from a dispatched `workflow_dispatch` run never attach to the PR at all, so the first real release failed at the merge with "the base branch policy prohibits the merge". The approval uses the new `RELEASE_APPROVE_TOKEN` secret (a fine-grained PAT with Actions write access), and the wait watches exactly the run recorded on the pushed head, so a retried attempt can never accept an earlier attempt's checks.

## [1.10.0] - 2026-10-20

### Added
- Opt-in debug log: set `PI_MCP_DEBUG=1` to record the extension's own decisions (server state transitions, retries and backoff, OAuth token refresh, cross-process auth-lock contention, 401/403 classification, session reloads) as JSON Lines in `<agent dir>/logs/pi-mcp.log`. The directory is `0o700` and the file is `0o600`, the log is rotated to `pi-mcp.log.1` at ~2 MB, and only allow-listed field names are recorded — a final pass masks anything token-like (`access_token`, `refresh_token`, `client_secret`, `code=`, `code_verifier`, `Authorization:` / `Bearer …`). Without the environment variable no log file is created (#71).

### Changed
- The extension no longer writes diagnostics to Pi's stderr while a UI is active — that stream belongs to the TUI. Server output, reconnection notices, and OAuth events now go to the debug log (when enabled) or are dropped, and user-actionable events are surfaced as Pi notifications. Headless runs without a UI keep the stderr output they have always had — warnings, errors, and child-server output; new informational events (state transitions, token refresh, session lifecycle) are recorded only in the debug log (#71).

## [1.9.11] - 2026-10-19

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

### Security
- Validate OAuth callback state on both successful and error responses, preventing forged error callbacks from bypassing the state check.

### Fixed
- Tear down stale session state when a session reloads or config loading fails; refresh timeout settings and MCP roots when settings or the working directory change.
- Propagate cancellation through queued authorization, and coordinate and deduplicate startup OAuth prompts with manual authorization and stop requests.
- Accept `/mcp:auth --reset` with the flag before or after the server name, and report `/mcp:start` cancellations as informational rather than errors.

## [1.9.5] - 2026-10-17

### Security
- Sanitize stdio server output before logging or displaying it, stripping terminal control sequences and other unsafe characters.

### Fixed
- Apply effective request timeouts and cancellation signals to MCP operations, and keep health-check pings bounded and non-overlapping.
- Recover from unexpected SSE and Streamable HTTP disconnects, unblock SSE startup when closing, and surface failed recovery to the user.
- Use the session working directory for stdio servers and encoded MCP root URIs, and reliably terminate child processes after failed handshakes and shutdown.

## [1.9.4] - 2026-10-17

### Security
- Bind stored OAuth tokens, client information, and discovery state to the configured canonical server URL, preventing project configs that reuse a global server name at another URL from accessing or overwriting its credentials. Preserve Dynamic Client Registration authentication and redirect metadata, and validate client-secret expiry and registered redirects.

### Fixed
- Coordinate OAuth state writes and refresh-token rotation across processes; recover from stale locks and isolate corrupt per-server state.
- Recover from rejected credentials during connection, tool listing, and tool calls, including `403 insufficient_scope`; discover auth challenges when a server rejects `GET` with `405` and pass configured headers during authorization.

## [1.9.3] - 2026-10-17

### Fixed
- Improve JSON Schema compatibility for nullable and multi-type values, composed and empty objects, recursive `$ref`s, tuples, enums, and validation constraints, including schemas expected by Gemini and OpenAI.
- Prevent tool-name collisions within and across servers and discard stale concurrent tool refreshes; preserve structured tool results and empty resource text, reject already-aborted calls, and include prompt snippets in `mcp_status` and `mcp_connect`.

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
