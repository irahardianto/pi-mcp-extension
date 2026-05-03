# OAuth 2.1 Authentication

pi-mcp-extension supports OAuth 2.1 with PKCE for MCP servers that require browser-based authentication (e.g., DeepSource, Supabase).

## How It Works

The extension implements a complete OAuth flow with:

1. **Local Callback Server** - Runs on `localhost:19876` to receive OAuth callbacks
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

Run the `/mcp:auth` command:

```
/mcp:auth deepsource
```

This will:
1. Start the callback server (if not already running)
2. Generate a secure state parameter
3. Open your browser for authorization
4. Wait for the OAuth callback
5. Complete the authentication flow
6. Store tokens securely
7. Start the server

### Token Storage

Tokens are stored per-server in `~/.pi/agent/mcp-auth/<hash>.json`:

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

To force re-authentication:

```
/mcp:auth deepsource
```

This resets credentials and starts a fresh OAuth flow.

## Implementation Details

### Callback Server

- **File**: `src/callback-server.ts`
- **Port**: 19876 (auto-increments if busy)
- **Path**: `/callback`
- **Timeout**: 5 minutes
- **Features**:
  - Simple HTML success/error pages
  - State parameter validation (CSRF protection)
  - Promise-based API (`waitForCallback`)
  - Automatic port selection

### OAuth Provider

- **File**: `src/oauth-provider.ts`
- **Implements**: `OAuthClientProvider` from MCP SDK
- **Key Methods**:
  - `redirectUrl` - Returns the callback server URL
  - `clientMetadata` - Includes `redirect_uris` for DCR
  - `redirectToAuthorization` - Opens browser via callback
  - Token persistence to disk

### Auth Flow

- **File**: `src/index.ts` (`/mcp:auth` command)
- **Steps**:
  1. Stop server if running
  2. Reset credentials
  3. Start callback server
  4. Generate OAuth state
  5. Register callback promise
  6. Create auth provider and transport
  7. Call SDK `auth()` → opens browser
  8. Wait for callback (`await waitForCallback`)
  9. Call `transport.finishAuth(code)`
  10. Start server with fresh tokens

## Security Considerations

1. **PKCE S256** - All OAuth flows use PKCE
2. **State Parameter** - Cryptographically secure, validated on callback
3. **Localhost Only** - Callback server only listens on localhost
4. **File Permissions** - Token files saved with appropriate permissions
5. **URL Validation** - Credentials tied to specific server URL

## Troubleshooting

### "redirect_uris is required and must not be empty"

This error is now fixed. The callback server automatically provides the redirect URL.

### Browser doesn't open

If the browser fails to open (e.g., in SSH sessions), the authorization URL will be logged. Copy it manually to your browser.

### Callback server port in use

The callback server automatically scans forward for an available port. If you need a specific port, set `MCP_OAUTH_CALLBACK_PORT` environment variable.

### Token refresh failed

Tokens are automatically refreshed by the MCP SDK. If refresh fails, run `/mcp:auth` again to re-authenticate.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Pi Agent                                               │
│                                                         │
│  ┌────────────┐      ┌──────────────────┐             │
│  │ /mcp:auth  │─────▶│  Callback Server │◀────────┐   │
│  └────────────┘      │  (localhost:19876) │         │   │
│         │            └──────────────────┘         │   │
│         │                                          │   │
│         ▼                                          │   │
│  ┌──────────────────────────────────────┐            │   │
│  │  OAuth Flow                          │            │   │
│  │  1. Start callback server          │            │   │
│  │  2. Generate state                  │            │   │
│  │  3. Register callback promise       │            │   │
│  │  4. Create auth provider & transport│            │   │
│  │  5. Call SDK auth()                 │            │   │
│  │  6. Wait for callback (blocks)      │            │   │
│  │  7. Call finishAuth(code)           │            │   │
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
