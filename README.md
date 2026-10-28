# pi-mcp-extension

[![npm version](https://img.shields.io/npm/v/pi-mcp-extension.svg)](https://www.npmjs.com/package/pi-mcp-extension)
[![license](https://img.shields.io/npm/l/pi-mcp-extension.svg)](https://github.com/irahardianto/pi-mcp-extension/blob/main/LICENSE)
[![CI](https://github.com/irahardianto/pi-mcp-extension/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/irahardianto/pi-mcp-extension/actions/workflows/ci.yml)
[![Code Coverage](https://qlty.sh/gh/irahardianto/projects/pi-mcp-extension/coverage.svg)](https://qlty.sh/gh/irahardianto/projects/pi-mcp-extension)
[![Maintainability](https://qlty.sh/gh/irahardianto/projects/pi-mcp-extension/maintainability.svg)](https://qlty.sh/gh/irahardianto/projects/pi-mcp-extension)<br>
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/irahardianto/pi-mcp-extension/badge)](https://scorecard.dev/viewer/?uri=github.com/irahardianto/pi-mcp-extension)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/15659/badge)](https://www.bestpractices.dev/projects/15659)

**Connect [Pi](https://pi.dev) to any MCP server.** Supabase, DeepSource, Playwright, Context7, filesystem, databases — if it speaks [MCP](https://modelcontextprotocol.io), Pi can use it.

`pi-mcp-extension` is a production-ready [Model Context Protocol](https://modelcontextprotocol.io/) client extension for the [Pi coding agent](https://pi.dev). It manages server connections, discovers tools, and bridges them into Pi so the LLM can call them directly.

## Features

- **Multi-transport** — `stdio` subprocesses, `streamable-http` (including `"http"` and URL-only shorthand), and legacy `sse` out of the box
- **Auto-discovery** — Paginated `tools/list` with cursor following (MCP 2025-03-26 spec)
- **Live tool refresh** — `notifications/tools/list_changed` triggers re-discovery without restart
- **Clean cancellation** — `AbortSignal` propagation via `notifications/cancelled`
- **Smart reconnection** — Fixed delay retry schedule (1s → 3s → 5s → 10s → 30s), configurable max retries, and automatic recovery when a server transport closes unexpectedly
- **Health checks** — Opt-in periodic pings to detect stale connections
- **Safe process lifecycle** — Child PID tracking (`StdioClientTransport.pid`) with tree-aware cleanup: descendants of wrapper commands (`npx`, `npm exec`, `uvx`, `sh -c`) are terminated too, and inherited pipes are released so teardown never stalls
- **Stable tool names** — Sanitized, collision-avoiding names (max 64 chars) that stay constant across reconnects
- **No tool churn** — Activate/deactivate pattern ensures tools don't flicker during reconnection
- **Layered config & trust boundary** — Global `<agent dir>/mcp.json`, project `.pi/mcp.json` (loaded only in trusted projects via `ctx.isProjectTrusted()`, including Pi 1.3.0 partial overrides), and Pi 1.x extension-registered servers (`pi.registerMcpServer()`)
- **Rich tool results & annotations** — MCP `image` content passthrough (`ImageContent`), plus `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` surfaced in tool descriptions
- **On-demand agent tools & commands** — `mcp_status` and `mcp_connect` agent tools plus `/mcp`, `/mcp <name>` (with config provenance and failure hints), `/mcp:start`, `/mcp:stop`, and `/mcp:auth` slash commands with server-name autocomplete
- **Structured error handling** — Distinct error codes (`config`, `connection`, `auth`, `timeout`, `protocol`, `tool`) and actionable failure hints
- **Redacted debug logging** — Opt-in `PI_MCP_DEBUG=1` JSON Lines log (`<agent dir>/logs/pi-mcp.log`, `0600`, ~2 MB rotation) with automatic secret masking and zero TUI `stderr` noise
- **OAuth 2.1** — Browser and headless/SSH authorization with PKCE, protected-resource discovery, Dynamic Client Registration, startup prompts for eager servers, cross-process lock recovery, token refresh, and origin/issuer-bound local persistence (see [OAUTH.md](./OAUTH.md))

## Installation

```bash
pi install npm:pi-mcp-extension
```

Or try without installing:

```bash
pi -e npm:pi-mcp-extension
```

## Quick Start

1. Install the extension:
   ```bash
   pi install npm:pi-mcp-extension
   ```

2. *(Pi 1.x)* Disable Pi's built-in `mcp` extension so Pi does not warn that both extensions are enabled at the same time — either run `pi config` and uncheck `mcp` under **Built-in extensions**, or add `"extensions": ["-builtin:mcp"]` to `~/.pi/agent/settings.json`:
   ```jsonc
   {
     "extensions": [
       "-builtin:mcp"
     ]
   }
   ```

3. Create a config file at `~/.pi/agent/mcp.json` (global) or `.pi/mcp.json` (project-level). Both files support **JSONC** (`//` line and `/* ... */` block comments):
   ```jsonc
   {
     "mcpServers": {
       "supabase": {
         "transport": "streamable-http",
         "url": "https://mcp.supabase.com/mcp",
         "lifecycle": "eager"
       }
     }
   }
   ```

4. Start Pi — your MCP tools are ready. Use `/mcp` to check all servers or `/mcp <name>` to inspect one in detail.

## Configuration

Servers can be configured via JSON/JSONC files (`//` and `/* */` comments are supported) or registered programmatically by other Pi 1.x extensions:

| Source | Precedence & Scope |
|---|---|
| `.pi/mcp.json` | **Highest** — Project-level overrides per server and per explicitly stated setting. Loaded on `session_start` **only when the project is trusted** (`ctx.isProjectTrusted()`); never read at bootstrap or in untrusted projects. |
| `~/.pi/agent/mcp.json` | **Global** — Applies to all projects (honors `$PI_CODING_AGENT_DIR` with `~` expansion when set: `<agent dir>/mcp.json`). |
| `pi.registerMcpServer()` | **Extension-registered** — Discovered via `pi.getMcpServers()` and updated live on `mcp_servers_change` events when replacing `builtin:mcp`. Any server with the same name in `mcp.json` takes precedence. |

### Full Example

```jsonc
{
  "settings": {
    "toolPrefix": "mcp",         // Tools appear as mcp_<server>_<tool> (default: "mcp")
    "requestTimeoutMs": 30000,   // Per-request timeout in ms (default: 30000)
    "maxRetries": 5              // Max reconnection attempts, 0-10 (default: 5)
  },
  "mcpServers": {

    // ── HTTP-based servers ───────────────────────────────────────────────────
    "supabase": {
      "transport": "streamable-http",
      "url": "https://mcp.supabase.com/mcp",
      "auth": {
        "type": "oauth"
      },
      "lifecycle": "eager"
    },
    "deepsource": {
      "url": "https://mcp.deepsource.com/mcp", // "transport" defaults to "streamable-http" when "url" is set
      "lifecycle": "eager"
    },

    // ── Legacy SSE servers ───────────────────────────────────────────────────
    "legacy-server": {
      "transport": "sse",
      "url": "https://example.com/sse",
      "lifecycle": "lazy"
    },

    // ── stdio subprocess servers ─────────────────────────────────────────────
    "pathfinder": {
      "command": "/path/to/pathfinder-mcp",
      "transport": "stdio",
      "lifecycle": "eager"
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@context7/mcp"],
      "cwd": "./",
      "transport": "stdio",
      "lifecycle": "lazy"
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "transport": "stdio",
      "lifecycle": "lazy",
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

### Global Settings

In project-level `.pi/mcp.json`, `settings` keys carry no defaults — only the keys explicitly stated in the project file override global settings.

| Field | Type | Default | Description |
|---|---|---|---|
| `toolPrefix` | `string` | `"mcp"` | Prefix for registered tools: `<prefix>_<server>_<tool>`. Must match `^[a-zA-Z][a-zA-Z0-9_]*$`. |
| `requestTimeoutMs` | `number` | `30000` | Default per-request timeout in milliseconds |
| `maxRetries` | `number` | `5` | Max reconnection attempts (0–10) before giving up |

### Per-Server Config

For Pi 1.x compatibility, server entries also accept `type` as an alias for `transport`, `"http"` as an alias for `"streamable-http"`, `oauth` as an alias for `auth`, `timeout` (in seconds) as an alias for `requestTimeoutMs`, and `enabled: false` as a request to keep the server out of the eager set (`lifecycle: "lazy"`). Pi's `auth.provider` (`/login` provider token) is **rejected** at load time instead of being silently downgraded to OAuth 2.1 — use `auth` (OAuth) or static `headers`.

| Field | Type | Default | Description |
|---|---|---|---|
| `transport` (or `type`) | `"stdio" \| "streamable-http" \| "http" \| "sse"` | `"stdio"` (`"streamable-http"` when `url` is set without `command`) | Transport protocol (`"http"` is normalized to `"streamable-http"`) |
| `command` | `string` | — | Executable to spawn (**required** for `stdio`) |
| `args` | `string[]` | `[]` | Arguments for the command |
| `cwd` | `string` | session working directory | Working directory for a `stdio` server (rejected on `streamable-http` / `sse`). A relative path resolves against the session working directory and a leading `~` expands to your home directory |
| `env` | `Record<string, string>` | — | Extra environment variables for the child process (literal values, no `${VAR}` interpolation) |
| `url` | `string` | — | Server URL (**required** for `streamable-http` and `sse`) |
| `headers` | `Record<string, string>` | — | Static headers sent with `streamable-http` and `sse` requests. When `auth` is set, OAuth owns `Authorization`, so an `Authorization` entry here is ignored (other headers still apply) |
| `auth` (or `oauth`) | `object` | — | OAuth 2.1 configuration described below and in [OAUTH.md](./OAUTH.md) (`streamable-http` / `sse` only) |
| `lifecycle` | `"eager" \| "lazy"` | `"lazy"` (`"eager"` for `pi.registerMcpServer()` unless `enabled: false`) | `eager` = auto-start on `session_start`, `lazy` = connect on request via `mcp_connect`, `/mcp:start`, or `/mcp:auth` |
| `enabled` | `boolean` | `true` | Pi 1.3.0 switch: `false` keeps the entry configured but out of the eager set (normalized to `lifecycle: "lazy"`, even when `lifecycle: "eager"` is also set) |
| `requestTimeoutMs` (or `timeout`) | `number` | global setting | Per-server timeout override in ms (`timeout` is specified in seconds and multiplied by `1000`) |
| `healthCheckIntervalMs` | `number` | disabled | Opt-in ping interval in ms for proactive connection health monitoring |

### Project Override Entries

A trusted project's `.pi/mcp.json` may carry a Pi 1.3.0 **partial override** for a global server: an entry with no `command`, `url`, `type`, or `transport` changes only per-project settings and keeps the rest of the global entry, including credentials the project cannot set itself.

```jsonc
// ~/.pi/agent/mcp.json
{ "mcpServers": { "internal-tools": { "command": "internal-mcp", "lifecycle": "eager" } } }

// <project>/.pi/mcp.json — turn it off for this project only
{ "mcpServers": { "internal-tools": { "enabled": false } } }
```

An override may set `enabled`, `lifecycle`, and Pi's `exposure` / `toolExposure` (the two Pi-native exposure keys are accepted for Pi compatibility and ignored, because this extension decides tool activation itself). Any other key, or an override for a name no global entry defines, is reported as a config error naming the file and the server.

### OAuth Config

Configured under `auth` (or `oauth`). Token and client state are persisted per server in `<agent dir>/mcp-auth/<hash>.json` (`0700` directory, `0600` files on POSIX) with atomic writes, origin (`serverUrl`) and authorization-server (`issuer`) binding, and automatic backup of corrupt state files. See [OAUTH.md](./OAUTH.md) for architecture and troubleshooting details.

| Field | Type | Default | Description |
|---|---|---|---|
| `type` | `"oauth"` | `"oauth"` | Authentication type |
| `scope` | `string` | discovered | Requested scope when the server does not advertise one in `WWW-Authenticate` |
| `clientId` | `string` | dynamic registration | Pre-registered OAuth client ID (skips Dynamic Client Registration) |
| `clientSecret` | `string` | — | Secret for a pre-registered confidential client (used in memory; never written to disk) |
| `clientName` (or `oauth.clientName`) | `string` | `pi-mcp/<server name>` | `client_name` sent with Dynamic Client Registration, for servers that only accept known clients |
| `redirectUrl` (or `oauth.callbackUrl` / `oauth.callbackPort`) | `string` | `http://127.0.0.1:19876/callback` | Local HTTP loopback callback (`localhost`, `127.0.0.1`, or `::1` with path `/callback` and an explicit non-zero port; `callbackPort` maps to `http://127.0.0.1:<port>/callback`). Scans forward from `19876` when omitted; binds the exact host and port when configured. |

## Commands

Server-name arguments provide autocomplete suggestions from the configured MCP servers. `/mcp:auth` suggests only servers configured for OAuth.

| Slash Command | Description |
|---|---|
| `/mcp` | Show status summary of all configured servers |
| `/mcp <name>` | Show detailed status for one server: config source, transport/lifecycle, tool activation, OAuth credential status, failure hint, and stderr log |
| `/mcp:start <name>` | Connect a server and wait for tool discovery |
| `/mcp:stop <name>` | Cancel a pending connection, startup prompt, or authorization, or stop a running server and deactivate its tools |
| `/mcp:auth <name>` | Connect with stored OAuth credentials and client registration; request browser authorization only if needed |
| `/mcp:auth <name> --reset` | Discard stored tokens and client registration (re-running Dynamic Client Registration) and request fresh authorization |

In addition to user slash commands, two built-in **agent tools** let the LLM inspect and connect configured servers directly:

| Agent Tool | Parameters | Description |
|---|---|---|
| `mcp_status` | `{}` | List configured servers with `lifecycle`, `state`, `tools` (`discovered` / `active`), `auth` credential presence, `source` (`global` / `project` / `extension`), and safe `error` action hints (never returns tokens, headers, or authorization URLs) |
| `mcp_connect` | `{ name: string }` | Connect one named server, run interactive OAuth if needed, and verify that discovered tools are active before returning success (returns fixed actionable categories on failure instead of raw server response text) |

### Inspecting one server (`/mcp <name>`)

`/mcp <name>` answers "why is this server in this state?" without leaving Pi:

```text
Server: supabase
State:  stopped
Retries: 5
Transport: streamable-http
Lifecycle: lazy
Source: global
Tools: 0/0 active
OAuth: credentials stored
Last error: Connection timed out after 30000ms
Hint: run with PI_MCP_DEBUG=1 pi to log redacted diagnostics, or report server issues at https://github.com/irahardianto/pi-mcp-extension/issues

Recent output:
(no stderr output from supabase)
```

- `Source` is the entry that won: `global` (`<agent dir>/mcp.json`), `project` (`<cwd>/.pi/mcp.json`), or `extension` (`pi.registerMcpServer()`). `mcp_status` reports the same value as `source` on each row.
- When the project is untrusted, `Source` never says `project` and a `Project config: not loaded (<path>)` line explains why `mcp.json` in the workspace is not in effect.
- `Tools` compares discovered tools with the ones Pi has active; a server can be `ready` with `0/N active` when another extension restricts tools.
- `OAuth` appears only for servers with an `auth` config: `credentials stored`, `authorization may be required`, or `corrupt state file backed up (re-auth required)` (the corrupt file is backed up and the view still renders).
- A failed server adds one `Hint:` line: `/mcp:auth <name>` (plus `--reset` when stored credentials expired) for a missing/expired authorization, waiting for another Pi process holding the auth lock, or `PI_MCP_DEBUG=1 pi` plus the issue tracker for a connection failure.

### OAuth startup, headless/SSH, and concurrency behavior

- **Interactive sessions required for browser auth**: Print and RPC sessions fail promptly when interactive authorization is required.
- **Startup prompt for eager OAuth servers**: Silent startup and background reconnects never open a browser unprompted or trigger Dynamic Client Registration when no client credentials are stored. When an `eager` OAuth server needs interactive authorization at startup in an interactive Pi session, Pi presents a sequential `<name> needs authorization` prompt (`Authorize now` / `Not now`). Choosing `Authorize now` runs the interactive OAuth flow; choosing `Not now` leaves the server stopped, shows a `run /mcp:auth <name>` footer hint, and remembers the decline for the rest of the session.
- **Headless and SSH support**: While authorization is pending, Pi displays the authorization URL and offers `Retry: open browser again`, `Paste redirect URL`, and `Cancel authentication`. On remote/SSH or headless machines, open the URL locally and either forward the callback port (`ssh -L <port>:127.0.0.1:<port>`) or paste the browser's final `http://127.0.0.1:<port>/callback?code=...&state=...` redirect URL into `Paste redirect URL`. Only `https:` (or loopback `http:`) authorization URLs are passed to the system browser opener.
- **Coordinated connects and cross-process locks**: Concurrent connect requests join an in-flight attempt, while `--reset` supersedes a normal connect and shares one pending reset. Cross-process interactive flows are serialized per server via `<agent dir>/mcp-auth/<hash>.json.lock` with a 30s heartbeat and automatic reclamation of locks from dead local PIDs or stale heartbeats (>90s), while allowing silent token refreshes to persist rotated tokens.
- **Resetting stale client registrations (`--reset`)**: `/mcp:auth <name>` reuses the cached Dynamic Client Registration (`clientInfo.client_id`) stored in `<agent dir>/mcp-auth/<hash>.json`. If an OAuth provider expires or purges a previously registered client—for example, when the browser displays `{"message":"Unrecognized client_id"}` or `invalid_client` on the authorization page without redirecting back to the local callback—run `/mcp:auth <name> --reset` to discard the cached `client_id`, register a new client via Dynamic Client Registration, and start a fresh authorization flow.

### Connection readiness and active tools

`mcp_status` reports `tools.discovered` and `tools.active` for each server. Connection state `ready` means the MCP handshake and discovery completed. It does not mean that another Pi extension has kept every discovered tool active.

`mcp_connect` checks current tool activation before reporting success, including when the server is already connected. If discovered tools are inactive, it reports that condition instead of overriding another extension's tool restrictions. Check the active tool policy or conflicting extension. A reconnect is not a substitute for fixing an extension that removes tools at each user turn.

## Debug log

Set `PI_MCP_DEBUG=1` before starting Pi to record what the extension itself is doing — server state transitions, retries and backoff, OAuth refresh and cross-process lock contention, 401/403 classification, and session reloads:

```bash
PI_MCP_DEBUG=1 pi
```

The log is written to `<agent dir>/logs/pi-mcp.log` (JSON Lines, one event per line):

```json
{"ts":"2026-01-01T00:00:00.000Z","level":"info","event":"server.state","server":"github","message":"Server github state starting -> ready","from":"starting","to":"ready","ms":412}
```

- **Off by default.** Without `PI_MCP_DEBUG=1` no log file is created.
- **Private.** The directory is `0o700` and the file is `0o600`, like the OAuth credential files.
- **Bounded.** The file is rotated to `pi-mcp.log.1` at ~2 MB; a single backup is kept.
- **Redacted.** Only allow-listed field names are recorded, and a final pass masks anything that looks like a token (`access_token`, `refresh_token`, `client_secret`, `code=`, `code_verifier`, `Authorization:` / `Bearer …`).
- **Best-effort.** A failed log write never breaks a connection or a tool call.

Attach the file to a bug report. It contains no credentials.

While a Pi UI is active, the extension never writes diagnostics to Pi's stderr (that stream belongs to the TUI): events go to the log file instead, and user-actionable ones are surfaced as Pi notifications. Headless runs without a UI keep the stderr output they have always had — warnings, errors, and child-server output; informational events such as state transitions are recorded only in the debug log.

## How It Works

```text
┌─────────────────────────────────────────────────────────────────────────┐
│  Pi Agent (TUI / RPC, ExtensionAPI)                                     │
│                                                                         │
│  ┌────────────────────┐    ┌────────────────────────┐                   │
│  │ index.ts           │───▶│ register-commands      │ (/mcp, :start,    │
│  │ (entry & mcp_*     │    │ (/mcp* slash commands) │  :stop, :auth)    │
│  │  agent tools)      │    └───────────┬────────────┘                   │
│  └────┬──────────┬────┘                │                                │
│       │          └──────────────┐      │                                │
│       │                         ▼      ▼                                │
│       │                    ┌────────────────────────┐                   │
│       │                    │ connection-coordinator │                   │
│       │                    │ (in-flight connects,   │                   │
│       │                    │  authQueue, teardown)  │                   │
│       │                    └───────────┬────────────┘                   │
│       │                                │                                │
│       │                                ▼                                │
│       │                    ┌────────────────────────┐    ┌───────────┐  │
│       │                    │ server-manager         │───▶│tool-bridge│  │
│       │                    │ (stopped → starting    │    │(MCP → Pi) │  │
│       │                    │  → ready lifecycle)    │    └─────┬─────┘  │
│       ▼                    └───────────┬────────────┘          │        │
│  ┌────────────────────┐                ▼                       ▼        │
│  │ config             │    ┌────────────────────────┐    ┌───────────┐  │
│  │ (Zod + JSONC)      │    │ transport-factory &    │    │ TypeBox   │  │
│  └────────┬───────────┘    │ oauth-provider (SDK)   │    │ (schema)  │  │
│           │                └───────────┬────────────┘    └───────────┘  │
└───────────┼────────────────────────────┼────────────────────────────────┘
            │                            │
            ▼                            ▼
   Global/Project mcp.json       ┌──────────────┐
   + Registered Extensions       │ MCP Servers  │
                                 │ (stdio/http) │
                                 └──────────────┘
```

1. **Config is loaded** from global `<agent dir>/mcp.json`, trusted project `.pi/mcp.json` (checked via `ctx.isProjectTrusted()` on `session_start`), and extension-registered servers (`pi.getMcpServers()` / `mcp_servers_change`), with `mcp.json` taking precedence over extension-registered servers and project entries overriding global ones
2. **Eager servers connect** at `session_start` via `ConnectionCoordinator` (offering a sequential `Authorize now` / `Not now` prompt when an eager OAuth server needs authorization in an interactive session); lazy servers wait for `mcp_connect`, `/mcp:start`, or `/mcp:auth`
3. **Tools are discovered** via paginated `tools/list` calls (cursor-based, up to 100 pages) before a server enters `ready`
4. **JSON Schema → TypeBox** conversion registers tools with Pi-compatible parameter schemas (preserving nullable union ordering, resolving `$ref`s cycle-safely, and inferring/flattening `allOf` object schemas)
5. **Pi tools are registered** as `<prefix>_<server>_<tool>` (sanitized, max 64 chars with hash suffix) and pass through text and `image` content blocks (`ImageContent`)
6. **Tools activate/deactivate** automatically as servers connect/disconnect
7. **AbortSignal** is wired through to `notifications/cancelled` for clean cancellation
8. **Reconnection & recovery** uses a fixed delay schedule with configurable max retries on initial failure, health check failure, or unexpected transport close (`client.onclose`)
9. **`list_changed` notifications** trigger re-discovery, deactivating stale tools automatically
10. **Session shutdown** cancels pending auth/connection flows, stops the callback server, deactivates all tools, flushes the debug log, and cleanly stops all servers (with a `SIGKILL` safety net for `stdio` child processes)

## MCP Spec Compliance

Implements the **MCP 2025-03-26** specification for tool clients:

| Feature | Status |
|---|---|
| Protocol version `2025-03-26` (+ `2024-11-05` fallback) | ✅ |
| `stdio` transport | ✅ |
| `streamable-http` transport (including `"http"` / URL-only shorthand) | ✅ |
| `sse` transport (legacy backwards compat) | ✅ |
| OAuth 2.1 authorization (PKCE S256, RFC 9728 Protected Resource Metadata, RFC 7591 DCR) | ✅ |
| Cursor-based `tools/list` pagination | ✅ |
| `tools/call` with parameters & `image` content (`ImageContent`) passthrough | ✅ |
| `roots/list` capability (workspace root) | ✅ |
| `notifications/tools/list_changed` (live refresh) | ✅ |
| `notifications/cancelled` (AbortSignal) | ✅ |
| `notifications/message` (structured logging) | ✅ |
| `isError: true` distinction (protocol vs tool errors, non-text filtered on error) | ✅ |
| Tool annotations (`readOnlyHint`, `destructiveHint`, etc.) | ✅ |
| Resources bridge | ⏳ v2 |
| Prompts bridge | ⏳ v2 |
| Sampling | ⏳ v2 |

## Contributing / Architecture

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, workflow, and the pre-merge smoke-test checklist, and [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for a behavioral overview of how the runtime fits together (lifecycle, coordination, config trust, and credential storage).

## Development

```bash
# Install dependencies (clean lockfile install)
npm ci

# Lint (type-aware ESLint + structural/complexity checks)
npm run lint

# Type check (strict mode)
npm run typecheck

# Run all test suites
npm test

# Run all test suites with coverage floor (95% lines / 85% branches / 83% functions)
npm run test:coverage

# Run integration tests only (real stdio server)
npm run test:integration

# Verify npm tarball contents
npm pack --dry-run
```

### Testing

The test suite includes:
- **Config & Pi 1.x / 1.3.0 compatibility** (`tests/config.test.ts`, `tests/pi-1x-compat.test.ts`) — Zod schema, JSONC comments, `$PI_CODING_AGENT_DIR` resolution, global/project merge, project trust boundary (`ctx.isProjectTrusted()`), Pi 1.3.0 `enabled: false` and partial project overrides, `stdio` `cwd`, `oauth.clientName`, Pi 1.x schema aliases (`type: "http"`, URL-only HTTP, `oauth`, `timeout`), and dynamic `pi.getMcpServers()` / `mcp_servers_change`
- **Server lifecycle & coordination** (`tests/server-manager.test.ts`, `tests/stdio-process.test.ts`, `tests/transport-factory.test.ts`, `tests/connection-coordinator.test.ts`, `tests/connection-coordination.test.ts`) — Connect, retry, unexpected close recovery, shutdown with PID `SIGKILL` safety net, health check, concurrent connect/reset coordination, and cancellation
- **OAuth 2.1 & auth locks** (`tests/oauth-fixes.test.ts`, `tests/authorize-flow.test.ts`, `tests/auth-lock.test.ts`, `tests/auth-commands.test.ts`, `tests/auth-arguments.test.ts`, `tests/fake-oauth-server.test.ts`) — Challenge discovery, PKCE, Dynamic Client Registration, origin and issuer binding, startup authorization prompts, headless/SSH redirect URL paste-back, URL scheme validation, cross-process lock heartbeat, and stale lock reclamation
- **Tool bridge, status diagnostics & debug log** (`tests/tool-bridge.test.ts`, `tests/management-tools.test.ts`, `tests/server-status.test.ts`, `tests/status-commands.test.ts`, `tests/completions.test.ts`, `tests/debug-log.test.ts`) — JSON Schema → TypeBox conversion (`allOf` object inference, `$ref` cycle protection, union `null` ordering), name sanitization, image content passthrough, `isError` filtering, activate/deactivate, `mcp_status` / `mcp_connect`, `/mcp <name>` config provenance and failure hints, slash command completions, and redacted `PI_MCP_DEBUG=1` JSONL logging
- **Property-based fuzzing** (`tests/fuzz.test.ts`) — `fast-check` properties covering JSONC comment stripping, callback/redirect URL validation, `WWW-Authenticate` challenge parsing, JSON Schema → TypeBox conversion, tool naming, terminal/log secret sanitization, and custom header merging
- **Release flow & repository policy** (`tests/release.test.ts`, `tests/ruleset-audit.test.ts`, `tests/repo-policy.test.ts`) — Release PR orchestration and npm/git self-healing (`scripts/release.ts`), live GitHub ruleset drift auditing (`scripts/ruleset-audit.ts`), and CI/ESLint/Qlty policy invariants
- **End-to-end integration** — Real mock MCP and OAuth servers over `stdio` and HTTP with tool discovery and execution

## Security

Please report vulnerabilities privately, not in public issues. See [SECURITY.md](https://github.com/irahardianto/pi-mcp-extension/blob/main/SECURITY.md) for scope, supported versions, and how to report.

## License

MIT
