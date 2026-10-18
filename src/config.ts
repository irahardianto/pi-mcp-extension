/**
 * Configuration loading, validation, and merging for pi-mcp.
 *
 * Config file locations (Pi-native convention, highest priority first):
 *   1. <cwd>/.pi/mcp.json      — project-level config
 *   2. <agent dir>/mcp.json    — global config; the agent dir is what Pi itself uses:
 *      $PI_CODING_AGENT_DIR when set (Pi profiles / alternative agent dirs), else ~/.pi/agent
 *
 * Project servers/settings override global servers/settings per-key (shallow merge).
 * No deep merge, no env var interpolation — WYSIWYG config.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { callbackServerConfigFromRedirectUrl } from "./callback-server.js";
import { McpError } from "./errors.js";

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const AuthConfigSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const obj = { ...(raw as Record<string, unknown>) };
    if (obj.redirectUrl === undefined) {
      if (typeof obj.callbackUrl === "string") {
        obj.redirectUrl = obj.callbackUrl;
      } else if (typeof obj.callbackPort === "number") {
        obj.redirectUrl = `http://127.0.0.1:${obj.callbackPort}/callback`;
      } else if (obj.callbackUrl !== undefined) {
        obj.redirectUrl = obj.callbackUrl;
      }
    }
    delete obj.callbackUrl;
    delete obj.callbackPort;
    return obj;
  },
  z
    .object({
      /** Auth type. Currently only "oauth" is supported. Default: "oauth". */
      type: z.enum(["oauth"]).default("oauth"),
      /**
       * Callback URL for the OAuth redirect.
       * Default: auto-detected local callback server.
       */
      redirectUrl: z.string().optional(),
      /**
       * Optional scope to request during authorization.
       */
      scope: z.string().optional(),
      /**
       * Pre-registered client_id (skip dynamic client registration).
       */
      clientId: z.string().optional(),
      /**
       * Pre-registered client_secret.
       */
      clientSecret: z.string().optional(),
    })
    .superRefine((auth, ctx) => {
      if (auth.redirectUrl !== undefined) {
        try {
          callbackServerConfigFromRedirectUrl(auth.redirectUrl);
        } catch (err) {
          ctx.addIssue({
            code: "custom",
            path: ["redirectUrl"],
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }),
);

export const ServerConfigSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const obj = { ...(raw as Record<string, unknown>) };
    const rawTransport = obj.transport ?? obj.type;
    if (rawTransport === "http") {
      obj.transport = "streamable-http";
    } else if (obj.transport === undefined && rawTransport !== undefined) {
      obj.transport = rawTransport;
    } else if (obj.transport === undefined && obj.url !== undefined && obj.command === undefined) {
      obj.transport = "streamable-http";
    }
    if (obj.auth === undefined && obj.oauth && typeof obj.oauth === "object" && !Array.isArray(obj.oauth)) {
      obj.auth = obj.oauth;
    }
    if (obj.requestTimeoutMs === undefined && typeof obj.timeout === "number" && obj.timeout > 0) {
      obj.requestTimeoutMs = obj.timeout * 1000;
    }
    return obj;
  },
  z
    .object({
      /** Executable to spawn (e.g. "npx", "node", "uvx"). Required for stdio. */
      command: z.string().optional(),
      /** Arguments passed to command. */
      args: z.array(z.string()).default([]),
      /**
       * Extra environment variables passed to the child process as literals.
       * These merge with process.env; project env overrides parent env.
       * No ${VAR} interpolation — set vars in your shell environment instead.
       */
      env: z.record(z.string(), z.string()).optional(),
      /** Transport protocol. Default: "stdio" (or "streamable-http" when "url" is provided). */
      transport: z.enum(["stdio", "streamable-http", "sse"]).default("stdio"),
      /**
       * URL for streamable-http or sse transports.
       * Must be a valid URL (e.g. "https://my-mcp-server.example.com/mcp").
       */
      url: z.string().url().optional(),
      /**
       * Static HTTP headers to include with every request (streamable-http / sse only).
       * Useful for API-key-based auth (e.g. { "Authorization": "Bearer <key>" }).
       * For OAuth2, use the "auth" field instead.
       */
      headers: z.record(z.string(), z.string()).optional(),
      /**
       * OAuth2 configuration for servers that require authorization.
       * When set, the transport will use the SDK's OAuth flow (discovery,
       * dynamic client registration, PKCE, token refresh).
       * Only applies to streamable-http and sse transports.
       */
      auth: AuthConfigSchema.optional(),
      /**
       * "eager" — start at session_start.
       * "lazy"  — start manually via /mcp:start command.
       */
      lifecycle: z.enum(["eager", "lazy"]).default("lazy"),
      /** Per-request timeout in ms. Overrides global setting. Default: 30000. */
      requestTimeoutMs: z.number().positive().optional(),
      /**
       * Opt-in heartbeat interval (ping) in ms.
       * Only useful for long-lived connections where you want proactive liveness checks.
       * Default: disabled.
       */
      healthCheckIntervalMs: z.number().positive().optional(),
    })
    .superRefine((cfg, ctx) => {
      if (cfg.transport === "stdio") {
        if (cfg.command === undefined) {
          ctx.addIssue({
            code: "custom",
            message: '"command" is required for stdio transport',
          });
        }
        if (cfg.auth !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["auth"],
            message: "OAuth authentication is only supported for 'sse' and 'streamable-http' transports, not 'stdio'",
          });
        }
      } else if (cfg.url === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `"url" is required for ${cfg.transport} transport`,
        });
      }
    }),
);

const DEFAULT_SETTINGS = {
  toolPrefix: "mcp",
  requestTimeoutMs: 30000,
  maxRetries: 5,
} as const;

const SettingsSchema = z.object({
  /**
   * Prefix used in Pi tool names: <prefix>_<server>_<tool>.
   * Must match ^[a-zA-Z][a-zA-Z0-9_]*$. Default: "mcp".
   */
  toolPrefix: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "toolPrefix must start with a letter and contain only alphanumeric characters and underscores")
    .default(DEFAULT_SETTINGS.toolPrefix),
  /** Default per-request timeout in ms for all servers. Default: 30000. */
  requestTimeoutMs: z.number().positive().default(DEFAULT_SETTINGS.requestTimeoutMs),
  /** Maximum retry attempts when a server fails to connect. Default: 5. */
  maxRetries: z.number().int().min(0).max(10).default(DEFAULT_SETTINGS.maxRetries),
});

const McpConfigSchema = z.object({
  settings: SettingsSchema.default(() => ({ ...DEFAULT_SETTINGS })),
  mcpServers: z.record(z.string(), ServerConfigSchema).default({}),
});

/**
 * Project-level file: `settings` keys are optional and carry NO defaults, so a project file
 * only overrides what it actually states. (Parsing it with SettingsSchema filled in the
 * defaults — e.g. toolPrefix "mcp" — and the merge then overwrote the global settings.)
 */
const ProjectSettingsSchema = z.object({
  toolPrefix: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "toolPrefix must start with a letter and contain only alphanumeric characters and underscores")
    .optional(),
  requestTimeoutMs: z.number().positive().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
});
const ProjectConfigSchema = z.object({
  settings: ProjectSettingsSchema.default({}),
  mcpServers: z.record(z.string(), ServerConfigSchema).default({}),
});
type ProjectConfig = z.output<typeof ProjectConfigSchema>;

// ─── Public Types ─────────────────────────────────────────────────────────────

export type AuthConfig = z.output<typeof AuthConfigSchema>;
export type ServerConfig = z.output<typeof ServerConfigSchema>;
export type Settings = z.output<typeof SettingsSchema>;
export type McpConfig = z.output<typeof McpConfigSchema>;

export interface LoadConfigOptions {
  /**
   * Whether to read project-level `<cwd>/.pi/mcp.json`.
   * Set to `false` when the project is untrusted (`ctx.isProjectTrusted() === false`)
   * or during bootstrap before session trust is resolved.
   * Default: `true`.
   */
  includeProjectConfig?: boolean;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Strip `//` line comments and `/* ... *\/` block comments outside of double-quoted
 * JSON strings in a single character-by-character pass.
 *
 * Preserves `\n` and `\r` characters so line numbers in `JSON.parse` error messages
 * remain accurate. Unterminated `/*` block comments are left intact so `JSON.parse`
 * fails with a syntax error rather than silently truncating the document.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    if (inString) {
      if (ch === "\\") {
        out += ch;
        if (i + 1 < text.length) {
          out += text[i + 1]!;
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") {
        if (text[i] === "\r" && text[i + 1] === "\n") break;
        i += 1;
      }
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      const closeIdx = text.indexOf("*/", i + 2);
      if (closeIdx === -1) {
        // WHY: Leave unterminated block comments intact so JSON.parse fails with a
        // SyntaxError rather than silently truncating the rest of the file.
        out += text.slice(i);
        break;
      }
      for (let j = i; j < closeIdx + 2; j += 1) {
        const commentCh = text[j]!;
        out += commentCh === "\n" || commentCh === "\r" ? commentCh : " ";
      }
      i = closeIdx + 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const detail = err instanceof Error ? err.message : String(err);
    throw new McpError(
      `Failed to read mcp.json at ${path}: ${detail}`,
      "<config>",
      "config",
      err,
    );
  }

  try {
    return JSON.parse(stripJsonComments(text));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new McpError(
      `Invalid JSON in mcp.json at ${path}: ${detail}`,
      "<config>",
      "config",
      err,
    );
  }
}

function parseConfig(raw: unknown, sourcePath: string): McpConfig {
  return parseWith(McpConfigSchema, raw, sourcePath);
}

function parseWith<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
  sourcePath: string,
): z.output<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new McpError(
      `Invalid mcp.json at ${sourcePath}:\n${issues}`,
      "<config>",
      "config",
    );
  }
  return result.data;
}

/**
 * Parse and normalize a server configuration registered via `pi.registerMcpServer()`.
 * Extension-registered servers default to `lifecycle: "eager"` (unless `enabled: false`
 * or `lifecycle` is explicitly specified) so they connect on `session_start` / `mcp_servers_change`.
 */
export function parseRegisteredServerConfig(
  name: string,
  raw: unknown,
  sourcePath = "<extension>",
): ServerConfig {
  const rawObj = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
  const withLifecycle = rawObj && rawObj.lifecycle === undefined
    ? { ...rawObj, lifecycle: rawObj.enabled === false ? "lazy" : "eager" }
    : raw;
  const result = ServerConfigSchema.safeParse(withLifecycle);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  mcpServers.${name}${i.path.length ? `.${i.path.join(".")}` : ""}: ${i.message}`)
      .join("\n");
    throw new McpError(
      `Invalid MCP server "${name}" from ${sourcePath}:\n${issues}`,
      name,
      "config",
    );
  }
  return result.data;
}

function mergeConfigs(
  globalCfg: McpConfig,
  projectCfg: ProjectConfig,
): McpConfig {
  // Only the settings the project file states may override the global ones.
  const stated = Object.fromEntries(
    Object.entries(projectCfg.settings).filter(([, v]) => v !== undefined),
  ) as Partial<Settings>;
  return {
    // Shallow spread: project settings override global settings per key
    settings: { ...globalCfg.settings, ...stated },
    // Per-server override: project server entry completely replaces global entry with same name
    mcpServers: { ...globalCfg.mcpServers, ...projectCfg.mcpServers },
  };
}

/**
 * Pi's agent directory, resolved the way Pi resolves it (`getAgentDir()` in
 * @earendil-works/pi-coding-agent): $PI_CODING_AGENT_DIR when set (tilde expanded), else
 * ~/.pi/agent. Pi profiles and alternative agent dirs only work through that variable.
 */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PI_CODING_AGENT_DIR;
  if (fromEnv && fromEnv.length > 0) {
    if (fromEnv === "~") return homedir();
    if (fromEnv.startsWith("~/")) return join(homedir(), fromEnv.slice(2));
    return fromEnv;
  }
  return join(homedir(), ".pi", "agent");
}

/**
 * Load and merge global (<agent dir>/mcp.json) and project (<cwd>/.pi/mcp.json) configs.
 * Project config takes precedence over global config when `options.includeProjectConfig !== false`.
 * Returns a fully validated, merged config.
 */
export async function loadConfig(
  cwd: string,
  globalPath = join(agentDir(), "mcp.json"),
  options?: LoadConfigOptions,
): Promise<McpConfig> {
  const includeProjectConfig = options?.includeProjectConfig !== false;
  const projectPath = join(cwd, ".pi", "mcp.json");

  const [globalRaw, projectRaw] = await Promise.all([
    readJsonFile(globalPath),
    includeProjectConfig ? readJsonFile(projectPath) : Promise.resolve(undefined),
  ]);

  // If neither file exists, return an empty valid config
  if (globalRaw === undefined && projectRaw === undefined) {
    return McpConfigSchema.parse({});
  }

  const globalCfg = globalRaw !== undefined
    ? parseConfig(globalRaw, globalPath)
    : McpConfigSchema.parse({});

  if (projectRaw === undefined) return globalCfg;

  const projectCfg = parseWith(ProjectConfigSchema, projectRaw, projectPath);
  return mergeConfigs(globalCfg, projectCfg);
}
