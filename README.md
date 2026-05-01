# pi-mcp-extension

[![npm version](https://img.shields.io/npm/v/pi-mcp-extension.svg)](https://www.npmjs.com/package/pi-mcp-extension)
[![license](https://img.shields.io/npm/l/pi-mcp-extension.svg)](https://github.com/irahardianto/pi-mcp-extension/blob/main/LICENSE)

**Connect [Pi](https://pi.dev) to any MCP server.** Supabase, DeepSource, Playwright, Context7, filesystem, databases — if it speaks [MCP](https://modelcontextprotocol.io), Pi can use it.

`pi-mcp-extension` is a production-ready [Model Context Protocol](https://modelcontextprotocol.io/) client extension for the [Pi coding agent](https://pi.dev). It manages server connections, discovers tools, and bridges them into Pi so the LLM can call them directly.

## Features

- **Multi-transport** — `stdio` subprocesses, `streamable-http`, and legacy `sse` out of the box
- **Auto-discovery** — Paginated `tools/list` with cursor following (MCP 2025-03-26 spec)
- **Live tool refresh** — `notifications/tools/list_changed` triggers re-discovery without restart
- **Clean cancellation** — `AbortSignal` propagation via `notifications/cancelled`
- **Smart reconnection** — Fixed delay retry schedule (1s → 3s → 5s → 10s → 30s), configurable max retries
- **Health checks** — Opt-in periodic pings to detect stale connections
- **Safe process lifecycle** — PID tracking with safety-net `SIGKILL` for orphaned subprocesses
- **Stable tool names** — Sanitized, collision-avoiding names (max 64 chars) that stay constant across reconnects
- **No tool churn** — Activate/deactivate pattern ensures tools don't flicker during reconnection
- **Global + project config** — Layered config (project overrides global) with per-server tuning
- **Tool annotations** — `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` surfaced in tool descriptions
- **Structured error handling** — Distinct error codes for config, connection, protocol, and tool-level failures

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

2. Create a config file at `~/.pi/agent/mcp.json` (global) or `.pi/mcp.json` (project-level):
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

3. Start Pi — your MCP tools are ready. Use `/mcp` to check server status.

## Configuration

Config files are loaded from two locations. **Project config overrides global config** via shallow merge (server-level replacement).

| Location | Scope |
|---|---|
| `~/.pi/agent/mcp.json` | Global — applies to all projects |
| `.pi/mcp.json` | Project — overrides global per-server |

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
      "lifecycle": "eager"
    },
    "deepsource": {
      "transport": "streamable-http",
      "url": "https://mcp.deepsource.io/mcp",
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

| Field | Type | Default | Description |
|---|---|---|---|
| `toolPrefix` | `string` | `"mcp"` | Prefix for registered tools: `<prefix>_<server>_<tool>`. Must match `^[a-zA-Z][a-zA-Z0-9_]*$`. |
| `requestTimeoutMs` | `number` | `30000` | Default per-request timeout in milliseconds |
| `maxRetries` | `number` | `5` | Max reconnection attempts (0–10) before giving up |

### Per-Server Config

| Field | Type | Default | Description |
|---|---|---|---|
| `transport` | `"stdio" \| "streamable-http" \| "sse"` | `"stdio"` | Transport protocol |
| `command` | `string` | — | Executable to spawn (**required** for stdio) |
| `args` | `string[]` | `[]` | Arguments for the command |
| `env` | `Record<string, string>` | — | Extra environment variables for the child process |
| `url` | `string` | — | Server URL (**required** for streamable-http/sse) |
| `lifecycle` | `"eager" \| "lazy"` | `"lazy"` | `eager` = auto-start on session start, `lazy` = manual via `/mcp:start` |
| `requestTimeoutMs` | `number` | global setting | Per-server timeout override |
| `healthCheckIntervalMs` | `number` | disabled | Opt-in ping interval for connection health monitoring |

## Commands

| Command | Description |
|---|---|
| `/mcp` | Show status summary of all configured servers |
| `/mcp <name>` | Show detailed status and stderr log for a specific server |
| `/mcp:start <name>` | Start a server (resets retry count) |
| `/mcp:stop <name>` | Stop a running server and deactivate its tools |

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
                     │ (stdio/http) │
                     └──────────────┘
```

1. **Config is loaded** from global and project files (project overrides global by server name)
2. **Eager servers connect** at session start; lazy servers wait for `/mcp:start`
3. **Tools are discovered** via paginated `tools/list` calls (cursor-based, up to 100 pages)
4. **JSON Schema → TypeBox** conversion registers tools with Pi-compatible parameter schemas
5. **Pi tools are registered** as `<prefix>_<server>_<tool>` (sanitized, max 64 chars with hash suffix)
6. **Tools activate/deactivate** automatically as servers connect/disconnect
7. **AbortSignal** is wired through to `notifications/cancelled` for clean cancellation
8. **Reconnection** uses a fixed delay schedule with configurable max retries
9. **`list_changed` notifications** trigger re-discovery, deactivating stale tools automatically
10. **Session shutdown** cleanly stops all servers and deactivates all tools

## MCP Spec Compliance

Implements the **MCP 2025-03-26** specification for tool clients:

| Feature | Status |
|---|---|
| Protocol version `2025-03-26` (+ `2024-11-05` fallback) | ✅ |
| `stdio` transport | ✅ |
| `streamable-http` transport | ✅ |
| `sse` transport (legacy backwards compat) | ✅ |
| Cursor-based `tools/list` pagination | ✅ |
| `tools/call` with parameters | ✅ |
| `roots/list` capability (workspace root) | ✅ |
| `notifications/tools/list_changed` (live refresh) | ✅ |
| `notifications/cancelled` (AbortSignal) | ✅ |
| `notifications/message` (structured logging) | ✅ |
| `isError: true` distinction (protocol vs tool errors) | ✅ |
| Tool annotations (`readOnlyHint`, `destructiveHint`, etc.) | ✅ |
| Resources bridge | ⏳ v2 |
| Prompts bridge | ⏳ v2 |
| Sampling | ⏳ v2 |

## Development

```bash
# Install dependencies
npm install

# Type check (strict mode)
npm run typecheck

# Run all tests (47 tests)
npm test

# Run integration tests only (real stdio server)
npm run test:integration
```

### Testing

The test suite includes:
- **Config validation** — Zod schema, global/project merge, defaults, error cases
- **Server lifecycle** — Connect, retry, shutdown, health check, race conditions
- **Tool bridge** — JSON Schema → TypeBox conversion, name sanitization, activate/deactivate
- **End-to-end integration** — Real mock MCP server over stdio with tool discovery and execution

## License

MIT
