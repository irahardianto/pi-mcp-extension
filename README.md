# pi-mcp-extension

[![npm version](https://img.shields.io/npm/v/pi-mcp-extension.svg)](https://www.npmjs.com/package/pi-mcp-extension)
[![license](https://img.shields.io/npm/l/pi-mcp-extension.svg)](https://github.com/irahardianto/pi-mcp-extension/blob/main/LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/irahardianto/pi-mcp-extension/badge)](https://scorecard.dev/viewer/?uri=github.com/irahardianto/pi-mcp-extension)

**Connect [Pi](https://pi.dev) to any MCP server.** Supabase, DeepSource, Playwright, Context7, filesystem, databases — if it speaks [MCP](https://modelcontextprotocol.io), Pi can use it.

`pi-mcp-extension` is a production-ready [Model Context Protocol](https://modelcontextprotocol.io/) client extension for the [Pi coding agent](https://pi.dev). It manages server connections, discovers tools, and bridges them into Pi so the LLM can call them directly.

## Features

- **Multi-transport** — `stdio` subprocesses, `streamable-http` (including `"http"` and URL-only shorthand), and legacy `sse` out of the box
- **Auto-discovery** — Paginated `tools/list` with cursor following (MCP 2025-03-26 spec)
- **Live tool refresh** — `notifications/tools/list_changed` triggers re-discovery without restart
- **Clean cancellation** — `AbortSignal` propagation via `notifications/cancelled`
- **Smart reconnection** — Fixed delay retry schedule (1s → 3s → 5s → 10s → 30s), configurable max retries, and automatic recovery when a server transport closes unexpectedly
- **Health checks** — Opt-in periodic pings to detect stale connections
- **Safe process lifecycle** — Child PID tracking (`StdioClientTransport.pid`) with safety-net `SIGKILL` for orphaned subprocesses
- **Stable tool names** — Sanitized, collision-avoiding names (max 64 chars) that stay constant across reconnects
- **No tool churn** — Activate/deactivate pattern ensures tools don't flicker during reconnection
- **Layered config & trust boundary** — Global `<agent dir>/mcp.json`, project `.pi/mcp.json` (loaded only in trusted projects via `ctx.isProjectTrusted()`), and Pi 1.x extension-registered servers (`pi.registerMcpServer()`)
- **Rich tool results & annotations** — MCP `image` content passthrough (`ImageContent`), plus `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` surfaced in tool descriptions
- **On-demand agent tools & commands** — `mcp_status` and `mcp_connect` agent tools plus `/mcp`, `/mcp:start`, `/mcp:stop`, and `/mcp:auth` slash commands with server-name autocomplete
- **Structured error handling** — Distinct error codes for config, connection, protocol, and tool-level failures
- **OAuth 2.1** — Browser and headless/SSH authorization with PKCE, protected-resource discovery, Dynamic Client Registration, startup prompts for eager servers, cross-process lock recovery, token refresh, and secure local persistence (see [OAUTH.md](./OAUTH.md))

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

3. Create a config file at `~/.pi/agent/mcp.json` (global) or `.pi/mcp.json` (project-level):
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

4. Start Pi — your MCP tools are ready. Use `/mcp` to check server status.

## Configuration

Servers can be configured via JSON files or registered programmatically by other Pi 1.x extensions:

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
      "url": "https://mcp.deepsource.io/mcp", // "transport" defaults to "streamable-http" when "url" is set
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

For Pi 1.x compatibility, server entries also accept `type` as an alias for `transport`, `"http"` as an alias for `"streamable-http"`, `oauth` as an alias for `auth`, and `timeout` (in seconds) as an alias for `requestTimeoutMs`.

| Field | Type | Default | Description |
|---|---|---|---|
| `transport` (or `type`) | `"stdio" \| "streamable-http" \| "http" \| "sse"` | `"stdio"` (`"streamable-http"` when `url` is set without `command`) | Transport protocol (`"http"` is normalized to `"streamable-http"`) |
| `command` | `string` | — | Executable to spawn (**required** for `stdio`) |
| `args` | `string[]` | `[]` | Arguments for the command |
| `env` | `Record<string, string>` | — | Extra environment variables for the child process (literal values, no `${VAR}` interpolation) |
| `url` | `string` | — | Server URL (**required** for `streamable-http` and `sse`) |
| `headers` | `Record<string, string>` | — | Static headers sent with `streamable-http` and `sse` requests |
| `auth` (or `oauth`) | `object` | — | OAuth 2.1 configuration described below and in [OAUTH.md](./OAUTH.md) (`streamable-http` / `sse` only) |
| `lifecycle` | `"eager" \| "lazy"` | `"lazy"` (`"eager"` for `pi.registerMcpServer()` unless `enabled: false`) | `eager` = auto-start on `session_start`, `lazy` = connect on request via `mcp_connect`, `/mcp:start`, or `/mcp:auth` |
| `requestTimeoutMs` (or `timeout`) | `number` | global setting | Per-server timeout override in ms (`timeout` is specified in seconds and multiplied by `1000`) |
| `healthCheckIntervalMs` | `number` | disabled | Opt-in ping interval in ms for proactive connection health monitoring |

### OAuth Config

Configured under `auth` (or `oauth`). Token and client state are persisted per server in `<agent dir>/mcp-auth/<hash>.json` (`0700` directory, `0600` files on POSIX) with atomic writes and automatic backup of corrupt state files. See [OAUTH.md](./OAUTH.md) for architecture and troubleshooting details.

| Field | Type | Default | Description |
|---|---|---|---|
| `type` | `"oauth"` | `"oauth"` | Authentication type |
| `scope` | `string` | discovered | Requested scope when the server does not advertise one in `WWW-Authenticate` |
| `clientId` | `string` | dynamic registration | Pre-registered OAuth client ID (skips Dynamic Client Registration) |
| `clientSecret` | `string` | — | Secret for a pre-registered confidential client |
| `redirectUrl` (or `oauth.callbackUrl` / `oauth.callbackPort`) | `string` | `http://127.0.0.1:19876/callback` | Local HTTP loopback callback (`localhost`, `127.0.0.1`, or `::1` with path `/callback` and an explicit non-zero port; `callbackPort` maps to `http://127.0.0.1:<port>/callback`). Scans forward from `19876` when omitted; binds the exact host and port when configured. |

## Commands

Server-name arguments provide autocomplete suggestions from the configured MCP servers. `/mcp:auth` suggests only servers configured for OAuth.

| Command | Description |
|---|---|
| `/mcp` | Show status summary of all configured servers |
| `/mcp <name>` | Show detailed status and stderr log for a specific server |
| `/mcp:start <name>` | Connect a server and wait for tool discovery |
| `/mcp:stop <name>` | Cancel a pending connection, startup prompt, or authorization, or stop a running server and deactivate its tools |
| `/mcp:auth <name>` | Connect with stored OAuth credentials and client registration; request browser authorization only if needed |
| `/mcp:auth <name> --reset` | Discard stored tokens and client registration (re-running Dynamic Client Registration) and request fresh authorization |

Agent tools `mcp_status` and `mcp_connect` let Pi inspect configured servers and connect one named server without routine slash commands. `mcp_status` reports lifecycle, connection state, discovered and active tool counts, credential presence, and safe action hints without returning tokens, headers, or authorization URLs. `mcp_connect` activates discovered tools before returning success. Connection failures return fixed actionable categories instead of raw server response text.

### OAuth startup, headless/SSH, and concurrency behavior

- **Interactive sessions required for browser auth**: Print and RPC sessions fail promptly when interactive authorization is required.
- **Startup prompt for eager OAuth servers**: Silent startup and background reconnects never open a browser unprompted or trigger Dynamic Client Registration when no client credentials are stored. When an `eager` OAuth server needs interactive authorization at startup in an interactive Pi session, Pi presents a sequential `<name> needs authorization` prompt (`Authorize now` / `Not now`). Choosing `Authorize now` runs the interactive OAuth flow; choosing `Not now` leaves the server stopped, shows a `run /mcp:auth <name>` footer hint, and remembers the decline for the rest of the session.
- **Headless and SSH support**: While authorization is pending, Pi displays the authorization URL and offers `Retry: open browser again`, `Paste redirect URL`, and `Cancel authentication`. On remote/SSH or headless machines, open the URL locally and either forward the callback port (`ssh -L <port>:127.0.0.1:<port>`) or paste the browser's final `http://127.0.0.1:<port>/callback?code=...&state=...` redirect URL into `Paste redirect URL`. Only `https:` (or loopback `http:`) authorization URLs are passed to the system browser opener.
- **Coordinated connects and cross-process locks**: Concurrent connect requests join an in-flight attempt, while `--reset` supersedes a normal connect and shares one pending reset. Cross-process interactive flows are serialized per server via `<agent dir>/mcp-auth/<hash>.json.lock` with a 30s heartbeat and automatic reclamation of locks from dead local PIDs or stale heartbeats (>90s), while allowing silent token refreshes to persist rotated tokens.
- **Resetting stale client registrations (`--reset`)**: `/mcp:auth <name>` reuses the cached Dynamic Client Registration (`clientInfo.client_id`) stored in `<agent dir>/mcp-auth/<hash>.json`. If an OAuth provider expires or purges a previously registered client—for example, when the browser displays `{"message":"Unrecognized client_id"}` or `invalid_client` on the authorization page without redirecting back to the local callback—run `/mcp:auth <name> --reset` to discard the cached `client_id`, register a new client via Dynamic Client Registration, and start a fresh authorization flow.

### Connection readiness and active tools

`mcp_status` reports `tools.discovered` and `tools.active` for each server. Connection state `ready` means the MCP handshake and discovery completed. It does not mean that another Pi extension has kept every discovered tool active.

`mcp_connect` checks current tool activation before reporting success, including when the server is already connected. If discovered tools are inactive, it reports that condition instead of overriding another extension's tool restrictions. Check the active tool policy or conflicting extension. A reconnect is not a substitute for fixing an extension that removes tools at each user turn.

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  Pi Agent                                               │
│                                                         │
│  ┌──────────┐    ┌────────────────┐    ┌─────────────┐  │
│  │ index.ts │───▶│ server-manager │───▶│ tool-bridge  │  │
│  │ (entry)  │    │ (lifecycle)    │    │ (MCP → Pi)   │  │
│  └──────────┘    └───────┬────────┘    └──────┬──────┘  │
│       │                  │                     │         │
│       ▼                  ▼                     ▼         │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │ config   │    │ MCP SDK      │    │ TypeBox      │   │
│  │ (Zod)    │    │ (transport)  │    │ (schema)     │   │
│  └──────────┘    └──────────────┘    └──────────────┘   │
└─────────────────────────────────────────────────────────┘
         │                  │
         ▼                  ▼
   Global/Project    ┌──────────────┐
   mcp.json files    │ MCP Servers  │
   + Extensions      │ (stdio/http) │
                     └──────────────┘
```

1. **Config is loaded** from global `<agent dir>/mcp.json`, trusted project `.pi/mcp.json` (checked via `ctx.isProjectTrusted()` on `session_start`), and extension-registered servers (`pi.getMcpServers()` / `mcp_servers_change`), with `mcp.json` taking precedence over extension-registered servers and project entries overriding global ones
2. **Eager servers connect** at `session_start` (offering a sequential `Authorize now` / `Not now` prompt when an eager OAuth server needs authorization in an interactive session); lazy servers wait for `mcp_connect`, `/mcp:start`, or `/mcp:auth`
3. **Tools are discovered** via paginated `tools/list` calls (cursor-based, up to 100 pages) before a server enters `ready`
4. **JSON Schema → TypeBox** conversion registers tools with Pi-compatible parameter schemas
5. **Pi tools are registered** as `<prefix>_<server>_<tool>` (sanitized, max 64 chars with hash suffix) and pass through text and `image` content blocks (`ImageContent`)
6. **Tools activate/deactivate** automatically as servers connect/disconnect
7. **AbortSignal** is wired through to `notifications/cancelled` for clean cancellation
8. **Reconnection & recovery** uses a fixed delay schedule with configurable max retries on initial failure, health check failure, or unexpected transport close (`client.onclose`)
9. **`list_changed` notifications** trigger re-discovery, deactivating stale tools automatically
10. **Session shutdown** cancels pending auth/connection flows, stops the callback server, deactivates all tools, and cleanly stops all servers (with a `SIGKILL` safety net for `stdio` child processes)

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
# Install dependencies
npm install

# Lint (type-aware ESLint)
npm run lint

# Type check (strict mode)
npm run typecheck

# Run all tests
npm test

# Run integration tests only (real stdio server)
npm run test:integration
```

### Testing

The test suite includes:
- **Config & Pi 1.x compatibility** — Zod schema, `$PI_CODING_AGENT_DIR` resolution, global/project merge, project trust boundary (`ctx.isProjectTrusted()`), Pi 1.x schema aliases (`type: "http"`, URL-only HTTP, `oauth`, `timeout`), and dynamic `pi.getMcpServers()` / `mcp_servers_change`
- **Server lifecycle & coordination** — Connect, retry, unexpected close recovery, shutdown with PID `SIGKILL` safety net, health check, concurrent connect/reset coordination, and cancellation
- **OAuth 2.1 & auth locks** — Challenge discovery, PKCE, Dynamic Client Registration, startup authorization prompts, headless/SSH redirect URL paste-back, URL scheme validation, cross-process lock heartbeat and stale lock reclamation
- **Tool bridge & management tools** — JSON Schema → TypeBox conversion, name sanitization, image content passthrough, `isError` filtering, activate/deactivate, `mcp_status` / `mcp_connect`, and slash command completions
- **End-to-end integration** — Real mock MCP and OAuth servers over stdio and HTTP with tool discovery and execution

## Security

Please report vulnerabilities privately, not in public issues. See [SECURITY.md](https://github.com/irahardianto/pi-mcp-extension/blob/main/SECURITY.md) for scope, supported versions, and how to report.

## License

MIT
