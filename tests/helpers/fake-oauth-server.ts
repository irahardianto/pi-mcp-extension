/**
 * Real HTTP OAuth 2.1 + Streamable-HTTP MCP server fixture for integration tests.
 *
 * Implements:
 * - RFC 9728 protected-resource metadata (/.well-known/oauth-protected-resource, /.well-known/oauth-protected-resource/mcp)
 * - RFC 8414 authorization-server metadata (/.well-known/oauth-authorization-server)
 * - RFC 7591 Dynamic Client Registration (POST /register) with dcrCount tracking
 * - OAuth 2.1 Authorization Endpoint (GET /authorize) with S256 PKCE challenge validation and 302 redirect
 * - OAuth 2.1 Token Endpoint (POST /token) with S256 PKCE verifier verification and refresh-token rotation
 * - Streamable-HTTP MCP endpoint (POST/GET/DELETE /mcp) requiring a valid non-expired Bearer token
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface FakeOAuthServerOptions {
  serverName?: string;
  toolName?: string;
  failRefresh?: boolean;
  expiresInSeconds?: number;
}

interface PendingAuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope?: string | undefined;
}

export interface FakeOAuthServer {
  readonly baseUrl: string;
  readonly mcpUrl: string;
  dcrCount: number;
  authorizeCount: number;
  tokenCount: number;
  codeExchangeCount: number;
  refreshCount: number;
  mcpRequestCount: number;
  unauthorizedMcpCount: number;
  browserOpenCount: number;
  failRefresh: boolean;
  readonly issuedAccessTokens: string[];
  readonly issuedRefreshTokens: string[];
  /** Expire all currently valid access tokens so the next MCP request receives HTTP 401. */
  expireAccessTokens: () => void;
  /** Seed a refresh token as valid (or invalid if omitted) for testing refresh flows. */
  addValidRefreshToken: (refreshToken: string) => void;
  /** Headless browser opener that follows the /authorize 302 redirect to the local callback server over real HTTP. */
  browserOpen: (url: string) => Promise<void>;
  close: () => Promise<void>;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown, headers?: Record<string, string>): void {
  res.writeHead(statusCode, {
    "content-type": "application/json",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

export async function startFakeOAuthServer(options: FakeOAuthServerOptions = {}): Promise<FakeOAuthServer> {
  const serverName = options.serverName ?? "fake-oauth-mcp";
  const toolName = options.toolName ?? "oauth_echo";
  const expiresInSeconds = options.expiresInSeconds ?? 3600;

  let baseUrl = "";
  let dcrCount = 0;
  let authorizeCount = 0;
  let tokenCount = 0;
  let codeExchangeCount = 0;
  let refreshCount = 0;
  let mcpRequestCount = 0;
  let unauthorizedMcpCount = 0;
  let browserOpenCount = 0;
  let failRefresh = options.failRefresh ?? false;

  let authCodeCounter = 0;
  let accessTokenCounter = 0;
  let refreshTokenCounter = 0;

  const pendingAuthCodes = new Map<string, PendingAuthCode>();
  const validAccessTokens = new Set<string>();
  const validRefreshTokens = new Set<string>();
  const issuedAccessTokens: string[] = [];
  const issuedRefreshTokens: string[] = [];

  const wwwAuthenticateHeader = () =>
    `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp" scope="mcp:tools"`;

  const listener = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", baseUrl || "http://127.0.0.1");
      const { pathname, searchParams } = requestUrl;

      // 1. RFC 9728 Protected Resource Metadata
      if (
        req.method === "GET" &&
        (pathname === "/.well-known/oauth-protected-resource" ||
          pathname === "/.well-known/oauth-protected-resource/mcp")
      ) {
        sendJson(res, 200, {
          resource: `${baseUrl}/mcp`,
          authorization_servers: [baseUrl],
          scopes_supported: ["mcp:tools"],
        });
        return;
      }

      // 2. RFC 8414 Authorization Server Metadata
      if (
        req.method === "GET" &&
        (pathname === "/.well-known/oauth-authorization-server" ||
          pathname === "/.well-known/openid-configuration")
      ) {
        sendJson(res, 200, {
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          registration_endpoint: `${baseUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
          code_challenge_methods_supported: ["S256"],
        });
        return;
      }

      // 3. RFC 7591 Dynamic Client Registration
      if (req.method === "POST" && pathname === "/register") {
        dcrCount += 1;
        const rawBody = await readRequestBody(req);
        const metadata = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        const clientId = `dcr-client-${dcrCount}`;
        sendJson(res, 201, {
          ...metadata,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [],
        });
        return;
      }

      // 4. OAuth 2.1 Authorization Endpoint (GET /authorize)
      if (req.method === "GET" && pathname === "/authorize") {
        authorizeCount += 1;
        const clientId = searchParams.get("client_id") ?? "";
        const redirectUri = searchParams.get("redirect_uri") ?? "";
        const responseType = searchParams.get("response_type") ?? "";
        const codeChallenge = searchParams.get("code_challenge") ?? "";
        const codeChallengeMethod = searchParams.get("code_challenge_method") ?? "";
        const state = searchParams.get("state") ?? "";
        const scope = searchParams.get("scope") ?? undefined;

        if (!clientId || !redirectUri || responseType !== "code" || !codeChallenge || codeChallengeMethod !== "S256") {
          sendJson(res, 400, {
            error: "invalid_request",
            error_description: "Missing required OAuth 2.1 PKCE S256 parameters",
          });
          return;
        }

        const code = `auth-code-${++authCodeCounter}`;
        pendingAuthCodes.set(code, {
          clientId,
          redirectUri,
          codeChallenge,
          scope,
        });

        const target = new URL(redirectUri);
        target.searchParams.set("code", code);
        if (state) {
          target.searchParams.set("state", state);
        }

        res.writeHead(302, { Location: target.toString() });
        res.end();
        return;
      }

      // 5. OAuth 2.1 Token Endpoint (POST /token)
      if (req.method === "POST" && pathname === "/token") {
        tokenCount += 1;
        const rawBody = await readRequestBody(req);
        const params = new URLSearchParams(rawBody);
        const grantType = params.get("grant_type");

        if (grantType === "authorization_code") {
          codeExchangeCount += 1;
          const code = params.get("code") ?? "";
          const codeVerifier = params.get("code_verifier") ?? "";
          const pending = pendingAuthCodes.get(code);
          if (!pending || !codeVerifier) {
            sendJson(res, 400, {
              error: "invalid_grant",
              error_description: "Invalid authorization code or missing PKCE code_verifier",
            });
            return;
          }

          const computedChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
          if (computedChallenge !== pending.codeChallenge) {
            sendJson(res, 400, {
              error: "invalid_grant",
              error_description: "PKCE S256 code_verifier mismatch",
            });
            return;
          }

          pendingAuthCodes.delete(code);
          const accessToken = `access-token-${++accessTokenCounter}`;
          const refreshToken = `refresh-token-${++refreshTokenCounter}`;
          validAccessTokens.add(accessToken);
          validRefreshTokens.add(refreshToken);
          issuedAccessTokens.push(accessToken);
          issuedRefreshTokens.push(refreshToken);

          sendJson(res, 200, {
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: expiresInSeconds,
            refresh_token: refreshToken,
            ...(pending.scope ? { scope: pending.scope } : {}),
          });
          return;
        }

        if (grantType === "refresh_token") {
          refreshCount += 1;
          const refreshToken = params.get("refresh_token") ?? "";
          if (failRefresh || !validRefreshTokens.has(refreshToken)) {
            sendJson(res, 400, {
              error: "invalid_grant",
              error_description: "Refresh token is expired, revoked, or rejected",
            });
            return;
          }

          // Rotate refresh token
          validRefreshTokens.delete(refreshToken);
          const newAccessToken = `access-token-${++accessTokenCounter}`;
          const newRefreshToken = `refresh-token-${++refreshTokenCounter}`;
          validAccessTokens.add(newAccessToken);
          validRefreshTokens.add(newRefreshToken);
          issuedAccessTokens.push(newAccessToken);
          issuedRefreshTokens.push(newRefreshToken);

          sendJson(res, 200, {
            access_token: newAccessToken,
            token_type: "Bearer",
            expires_in: expiresInSeconds,
            refresh_token: newRefreshToken,
          });
          return;
        }

        sendJson(res, 400, { error: "unsupported_grant_type" });
        return;
      }

      // 6. Streamable-HTTP MCP Endpoint (/mcp)
      if (pathname === "/mcp") {
        const authHeader = req.headers.authorization;
        const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : undefined;
        const isAuthenticated = Boolean(bearerToken && validAccessTokens.has(bearerToken));

        if (!isAuthenticated) {
          if (req.method === "POST") {
            mcpRequestCount += 1;
            unauthorizedMcpCount += 1;
          }
          res.writeHead(401, {
            "WWW-Authenticate": wwwAuthenticateHeader(),
            "content-type": "application/json",
          });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }

        if (req.method === "GET") {
          res.writeHead(405, { Allow: "POST" });
          res.end();
          return;
        }

        if (req.method === "DELETE") {
          res.writeHead(200);
          res.end();
          return;
        }

        if (req.method === "POST") {
          mcpRequestCount += 1;
          const rawBody = await readRequestBody(req);
          const message = JSON.parse(rawBody) as {
            id?: unknown;
            method?: string;
            params?: { name?: string; arguments?: Record<string, unknown> };
          };

          if (message.method === "initialize") {
            sendJson(res, 200, {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: serverName, version: "1.0.0" },
              },
            });
            return;
          }

          if (message.method === "notifications/initialized") {
            res.writeHead(202);
            res.end();
            return;
          }

          if (message.method === "ping") {
            sendJson(res, 200, {
              jsonrpc: "2.0",
              id: message.id,
              result: {},
            });
            return;
          }

          if (message.method === "tools/list") {
            sendJson(res, 200, {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                tools: [
                  {
                    name: toolName,
                    description: `OAuth protected tool (${toolName})`,
                    inputSchema: {
                      type: "object",
                      properties: {
                        text: { type: "string" },
                      },
                    },
                  },
                ],
              },
            });
            return;
          }

          if (message.method === "tools/call") {
            const textArg = String(message.params?.arguments?.text ?? "");
            sendJson(res, 200, {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                content: [{ type: "text", text: `echo:${textArg}` }],
              },
            });
            return;
          }

          sendJson(res, 400, { error: "unsupported_mcp_method" });
          return;
        }
      }

      res.writeHead(404);
      res.end("Not Found");
    } catch (err) {
      res.writeHead(500);
      res.end(err instanceof Error ? err.message : String(err));
    }
  });

  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address !== "object") {
    throw new Error("Failed to bind fake OAuth server");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    get baseUrl() {
      return baseUrl;
    },
    get mcpUrl() {
      return `${baseUrl}/mcp`;
    },
    get dcrCount() {
      return dcrCount;
    },
    set dcrCount(value: number) {
      dcrCount = value;
    },
    get authorizeCount() {
      return authorizeCount;
    },
    get tokenCount() {
      return tokenCount;
    },
    get codeExchangeCount() {
      return codeExchangeCount;
    },
    get refreshCount() {
      return refreshCount;
    },
    get mcpRequestCount() {
      return mcpRequestCount;
    },
    get unauthorizedMcpCount() {
      return unauthorizedMcpCount;
    },
    get browserOpenCount() {
      return browserOpenCount;
    },
    get failRefresh() {
      return failRefresh;
    },
    set failRefresh(value: boolean) {
      failRefresh = value;
    },
    issuedAccessTokens,
    issuedRefreshTokens,
    expireAccessTokens() {
      validAccessTokens.clear();
    },
    addValidRefreshToken(refreshToken: string) {
      validRefreshTokens.add(refreshToken);
    },
    async browserOpen(url: string): Promise<void> {
      browserOpenCount += 1;
      await fetch(url, { redirect: "follow" });
    },
    async close(): Promise<void> {
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}
