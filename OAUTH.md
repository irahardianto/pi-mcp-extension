# OAuth 2.1 Authentication

pi-mcp-extension supports OAuth 2.1 with PKCE for MCP servers that require browser-based authentication (e.g., DeepSource, Supabase).

## How It Works

The extension implements a complete OAuth flow with:

1. **Local Callback Server** - Uses `http://127.0.0.1:19876/callback` by default
2. **Automatic Endpoint Discovery** - Uses RFC 9728 to discover OAuth endpoints
3. **Dynamic Client Registration** - RFC 7591 support for servers that allow it
4. **PKCE (S256)** - Mandatory for security
5. **CSRF Protection** - State parameter validation
6. **Automatic Token Refresh** - Handled by the MCP SDK

## Usage

### Configure OAuth in mcp.json

```json
{
  "mcpServers": {
    "deepsource": {
      "transport": "streamable-http",
      "url": "https://mcp.deepsource.com/mcp",
      "auth": {
        "type": "oauth"
      }
    },
    "supabase": {
      "transport": "streamable-http",
      "url": "https://mcp.supabase.com/mcp",
      "auth": {
        "type": "oauth",
        "scope": "read write"
      }
    }
  }
}
```

### Optional Configuration

You can provide pre-registered client credentials:

```json
{
  "auth": {
    "type": "oauth",
    "clientId": "your-client-id",
    "clientSecret": "your-client-secret",
    "scope": "read write",
    "redirectUrl": "http://localhost:19876/callback"
  }
}
```

### Authenticate a Server

Use `mcp_connect` with the server name, `/mcp:start deepsource`, or `/mcp:auth deepsource` in an interactive Pi session. Stored credentials are reused. If the server requires browser authorization, the flow will:
1. Start the callback server (if not already running)
2. Generate a secure state parameter
3. Read the resource server's OAuth challenge with a bounded request
4. Open your browser for authorization
5. Wait for the OAuth callback
6. Exchange the authorization code through the MCP SDK
7. Store tokens securely
8. Connect the server and activate discovered tools

Interactive sessions show Retry and Cancel while authorization is pending. The browser opens once unless you choose Retry. Print and RPC sessions fail promptly if browser authorization is required. Eager startup and background reconnection never open the browser. A stop, cancellation, or shutdown cancels pending callbacks and retries.

### Token Storage

Tokens are stored per-server in `~/.pi/agent/mcp-auth/<hash>.json`. On systems with POSIX permissions, the directory uses mode `0700` and state files use mode `0600`.

```json
{
  "clientInfo": {
    "client_id": "...",
    "client_secret": "..."
  },
  "tokens": {
    "access_token": "...",
    "refresh_token": "...",
    "expires_in": 3600,
    "scope": "read write",
    "saved_at": "2025-01-01T00:00:00.000Z"
  }
}
```

### Reset Authentication

To discard stored tokens and client registration, run `/mcp:auth deepsource --reset` in an interactive Pi session. The old `/mcp:auth deepsource` reset behavior has changed: it now reuses credentials and requests browser authorization only if needed. Interactive flows for different servers run one at a time in each Pi process. A per-server lock prevents simultaneous interactive flows in different Pi processes. Independent processes can still attempt token refresh at the same time; no cross-process connection or refresh coordinator exists. If Pi exits during browser authorization, verify that no authorization is active before removing the stale `~/.pi/agent/mcp-auth/<hash>.json.lock` file for that server.

Server names can contain spaces. For example, `/mcp:auth team server --reset` resets `team server`. An exact configured name takes precedence over the reset suffix. To reset a server named `release --reset`, use `/mcp:auth release --reset --reset`.

## Implementation Details

### Callback Server

- **File**: `src/callback-server.ts`
- **Address**: `127.0.0.1:19876` by default
- **Path**: `/callback`
- **Timeout**: 5 minutes
- **Features**:
  - Simple HTML success/error pages
  - State parameter validation (CSRF protection)
  - Promise-based API (`waitForCallback`)
  - Automatic port selection when `redirectUrl` is omitted
  - Exact host and port binding for configured local redirect URLs

The manual `/mcp:auth` flow accepts only HTTP redirect URLs using `localhost`, `127.0.0.1`, or `::1`, with the exact path `/callback`. A configured local port must be available because OAuth providers require an exact redirect URI match.

### OAuth Provider

- **File**: `src/oauth-provider.ts`
- **Implements**: `OAuthClientProvider` from MCP SDK
- **Key Methods**:
  - `redirectUrl` - Returns the callback server URL
  - `clientMetadata` - Includes `redirect_uris` for DCR
  - `redirectToAuthorization` - Opens browser via callback
  - Token persistence to disk

### Auth Flow

- **File**: `src/index.ts` (`mcp_connect`, `/mcp:start`, `/mcp:auth`)
- **Steps**:
  1. Try the stored credentials and silent refresh during the connection
  2. If browser authorization is needed in an interactive session, acquire the auth lock and start the callback server
  3. Generate OAuth state
  4. Discover protected-resource challenge data
  5. Register callback promise
  6. Call SDK `auth()` to open the browser
  7. Wait for the callback
  8. Call SDK `auth()` with the authorization code
  9. Connect the server and activate discovered tools

## Security Considerations

1. **PKCE S256** - All OAuth flows use PKCE
2. **State Parameter** - Cryptographically secure, validated on callback
3. **Loopback Only** - The callback server listens only on a local loopback address
4. **File Permissions** - The auth directory uses `0700` and state files use `0600` where POSIX permissions apply
5. **Secret Handling** - Authorization codes and tokens are not written to logs

## Troubleshooting

### "redirect_uris is required and must not be empty"

This error is now fixed. The callback server automatically provides the redirect URL.

### Browser doesn't open

The command reports the browser process error. Run Pi in an environment where `open`, `xdg-open`, or `rundll32` can launch a browser.

### Callback server port in use

When `redirectUrl` is omitted, the callback server scans forward from port `19876`. A configured local redirect URL uses its exact port and fails if that port is occupied.

### Token refresh failed

Tokens are automatically refreshed by the MCP SDK. If refresh fails, use `mcp_connect` or `/mcp:auth <name>` in an interactive Pi session. Use `--reset` only if stored credentials must be discarded.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Pi Agent                                               │
│                                                         │
│  ┌────────────┐      ┌──────────────────┐             │
│  │ /mcp:auth  │─────▶│  Callback Server │◀────────┐   │
│  └────────────┘      │ (127.0.0.1:19876)│         │   │
│         │            └──────────────────┘         │   │
│         │                                          │   │
│         ▼                                          │   │
│  ┌──────────────────────────────────────┐            │   │
│  │  OAuth Flow                          │            │   │
│  │  1. Start callback server          │            │   │
│  │  2. Generate state                  │            │   │
│  │  3. Discover auth challenge         │            │   │
│  │  4. Register callback promise       │            │   │
│  │  5. Call SDK auth()                 │            │   │
│  │  6. Wait for callback               │            │   │
│  │  7. Exchange code through SDK auth()│            │   │
│  │  8. Start server with tokens        │            │   │
│  └──────────────────────────────────────┘            │   │
│                      │                                 │   │
└──────────────────────┼─────────────────────────────────┘
                       │
                       ▼
              ┌────────────────┐
              │ OAuth Server   │
              │ (Authorization)│
              └────────────────┘
                       │
         ┌─────────────┴─────────────┐
         │                           │
         ▼                           ▼
   ┌─────────┐                  ┌─────────┐
   │ Browser │                  │  Callback│
   │ (User)  │─── code ────────▶│  Server │
   └─────────┘                  └─────────┘
```

## References

- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Authorization Spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [OAuth 2.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-11)
- [PKCE (RFC 7636)](https://datatracker.ietf.org/doc/html/rfc7636)
- [Dynamic Client Registration (RFC 7591)](https://datatracker.ietf.org/doc/html/rfc7591)
- [OAuth Protected Resource Metadata (RFC 9728)](https://datatracker.ietf.org/doc/html/rfc9728)
