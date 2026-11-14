/**
 * Configuration loading, validation, and merging for pi-mcp.
 *
 * Config file locations (Pi-native convention, highest priority first):
 *   1. <cwd>/.pi/mcp.json      — project-level config
 *   2. <agent dir>/mcp.json    — global config; the agent dir is what Pi itself uses:
 *      $PI_CODING_AGENT_DIR when set (Pi profiles / alternative agent dirs), else ~/.pi/agent
 *
 * Project servers/settings override global servers/settings per-key (shallow merge).
 * A Pi 1.3.0 partial project entry (`{ "enabled": false }` — no `command`/`url`) overrides only the
 * per-project keys of the global server of that name, keeping the global entry's credentials.
 * No deep merge of any other keys, no env var interpolation — WYSIWYG config.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { callbackServerConfigFromRedirectUrl } from "./callback-url.js";
import {
  applyProjectOverrides,
  normalizeAuthConfigAliases,
  normalizeServerConfigAliases,
  withRegisteredServerLifecycle,
} from "./config-compat.js";
import { McpError } from "./errors.js";
import { stripJsonComments } from "./jsonc.js";
import { MCP_EXPOSURES } from "./tool-exposure.js";

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const AuthConfigObjectSchema = z.object({
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
  /**
   * `client_name` sent with Dynamic Client Registration (Pi 1.3.0 `oauth.clientName`).
   * Default: `pi-mcp/<server name>`.
   */
  clientName: z.string().trim().min(1).optional(),
  /**
   * Pi's `/login` provider auth (`auth.provider`), accepted only so it can be rejected with a
   * clear error: this extension runs OAuth 2.1 and cannot forward a Pi provider token.
   */
  provider: z.unknown().optional(),
});

function validateAuthConfig(
  auth: z.output<typeof AuthConfigObjectSchema>,
  ctx: z.RefinementCtx,
): void {
  if (auth.provider !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["provider"],
      message:
        '"auth.provider" sends a Pi /login provider token, which pi-mcp-extension does not support; ' +
        'remove it to use OAuth 2.1, or send a static credential with "headers"',
    });
  }
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
}

const AuthConfigSchema = z.preprocess(
  normalizeAuthConfigAliases,
  AuthConfigObjectSchema.superRefine(validateAuthConfig),
);

const ServerConfigObjectSchema = z.object({
  /** Executable to spawn (e.g. "npx", "node", "uvx"). Required for stdio. */
  command: z.string().optional(),
  /** Arguments passed to command. */
  args: z.array(z.string()).default([]),
  /**
   * Working directory for a stdio server (Pi 1.3.0 `cwd`). A leading `~` expands to the home
   * directory and a relative path resolves against the session working directory.
   */
  cwd: z.string().min(1).optional(),
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
   * For OAuth2, use the "auth" field instead: when "auth" is set, OAuth owns the
   * Authorization header and any Authorization entry here is ignored (other headers
   * still apply).
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
  /**
   * Pi 1.3.0 switch: `false` keeps the entry configured but out of the eager set (normalized to
   * `lifecycle: "lazy"`). Default: `true`.
   */
  enabled: z.boolean().optional(),
  /**
   * Pi 1.3.0 tool exposure for every tool this server advertises.
   *
   * `direct` — registered and activated, so the model sees the declaration.
   * `deferred` — registered inactive; `tool_search` can load it on demand.
   * `codemode` — registered inactive; callable from codemode scripts, and loadable by
   *   `tool_search` (which then declares it).
   * `hidden` — registered but not exposed to the model at all.
   *
   * Default: `"direct"` (unlike Pi's own `codemode`, so an existing config keeps every
   * discovered tool active).
   */
  exposure: z.enum(MCP_EXPOSURES).optional(),
  /**
   * Pi 1.3.0 per-tool exposure overrides, keyed by the raw MCP tool name (`tools/list`
   * name, not the Pi tool identifier) or a `*` wildcard pattern. An exact key wins, then
   * the first matching pattern in declaration order, then `exposure`.
   *
   * The canonical way to expose only a few tools of a large server:
   * `{ "exposure": "hidden", "toolExposure": { "search_*": "direct" } }`.
   */
  toolExposure: z.record(z.string(), z.enum(MCP_EXPOSURES)).optional(),
  /**
   * Short summary of what the server offers (Pi 1.3.0 `description`). Forwarded on the tool
   * `namespace` for `tool_search` ranking and codemode's `describeNamespace()`.
   */
  description: z.string().optional(),
  /** Per-request timeout in ms. Overrides global setting. Default: 30000. */
  requestTimeoutMs: z.number().positive().optional(),
  /**
   * Opt-in heartbeat interval (ping) in ms.
   * Only useful for long-lived connections where you want proactive liveness checks.
   * Default: disabled.
   */
  healthCheckIntervalMs: z.number().positive().optional(),
});

function validateServerConfig(
  cfg: z.output<typeof ServerConfigObjectSchema>,
  ctx: z.RefinementCtx,
): void {
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
    return;
  }
  if (cfg.url === undefined) {
    ctx.addIssue({
      code: "custom",
      message: `"url" is required for ${cfg.transport} transport`,
    });
  }
  if (cfg.cwd !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["cwd"],
      message: `"cwd" is only supported for 'stdio' transport, not '${cfg.transport}'`,
    });
  }
}

export const ServerConfigSchema = z.preprocess(
  normalizeServerConfigAliases,
  ServerConfigObjectSchema.superRefine(validateServerConfig),
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
  /**
   * Pi 1.3.0 top-level switch (default `true` when omitted): activate the built-in `codemode`
   * tool automatically when a server with `"codemode"` exposure connects.
   */
  autoEnableCodemode: z.boolean().optional(),
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
  autoEnableCodemode: z.boolean().optional(),
});
type ProjectConfig = z.output<typeof ProjectConfigSchema>;

// ─── Public Types ─────────────────────────────────────────────────────────────

export type AuthConfig = z.output<typeof AuthConfigSchema>;
export type ServerConfig = z.output<typeof ServerConfigSchema>;
export type Settings = z.output<typeof SettingsSchema>;
export type McpConfig = z.output<typeof McpConfigSchema>;

/** Which config file supplied a server entry. */
export type FileConfigOrigin = "global" | "project";

/** A loaded config plus where each server entry came from. */
export interface LoadedConfig {
  config: McpConfig;
  /** Winning origin per configured server name (project entries override global ones). */
  origins: Record<string, FileConfigOrigin>;
  /** Path of the project config file for the loaded cwd, read or not. */
  projectConfigPath: string;
  /** Whether the project config was read (`includeProjectConfig !== false`). */
  projectConfigIncluded: boolean;
}

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
  const result = ServerConfigSchema.safeParse(withRegisteredServerLifecycle(raw));
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
  const autoEnableCodemode = projectCfg.autoEnableCodemode ?? globalCfg.autoEnableCodemode;
  return {
    // Shallow spread: project settings override global settings per key
    settings: { ...globalCfg.settings, ...stated },
    // Per-server override: project server entry completely replaces global entry with same name
    mcpServers: { ...globalCfg.mcpServers, ...projectCfg.mcpServers },
    ...(autoEnableCodemode === undefined ? {} : { autoEnableCodemode }),
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

/** Winning file origin per server name: a project entry replaces a global entry of the same name. */
function originsOf(
  globalCfg: McpConfig,
  projectCfg: ProjectConfig | undefined,
): Record<string, FileConfigOrigin> {
  const origins: Record<string, FileConfigOrigin> = {};
  for (const name of Object.keys(globalCfg.mcpServers)) {
    origins[name] = "global";
  }
  for (const name of Object.keys(projectCfg?.mcpServers ?? {})) {
    origins[name] = "project";
  }
  return origins;
}

/**
 * Load and merge global and project configs, reporting where every server entry came from.
 * Same validation, precedence, and error behavior as `loadConfig`.
 */
export async function loadConfigWithOrigins(
  cwd: string,
  globalPath = join(agentDir(), "mcp.json"),
  options?: LoadConfigOptions,
): Promise<LoadedConfig> {
  const projectConfigIncluded = options?.includeProjectConfig !== false;
  const projectConfigPath = join(cwd, ".pi", "mcp.json");

  const [globalRaw, projectRaw] = await Promise.all([
    readJsonFile(globalPath),
    projectConfigIncluded ? readJsonFile(projectConfigPath) : Promise.resolve(undefined),
  ]);

  const globalCfg = globalRaw !== undefined
    ? parseConfig(globalRaw, globalPath)
    : McpConfigSchema.parse({});

  const projectCfg = projectRaw === undefined
    ? undefined
    : parseWith(
        ProjectConfigSchema,
        applyProjectOverrides(projectRaw, globalRaw, projectConfigPath),
        projectConfigPath,
      );

  return {
    config: projectCfg === undefined ? globalCfg : mergeConfigs(globalCfg, projectCfg),
    origins: originsOf(globalCfg, projectCfg),
    projectConfigPath,
    projectConfigIncluded,
  };
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
  const loaded = await loadConfigWithOrigins(cwd, globalPath, options);
  return loaded.config;
}
