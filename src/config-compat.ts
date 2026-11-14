/**
 * Pure Pi 1.x / Pi 1.3.0 raw configuration alias normalization and partial project override
 * merging. Runs on unvalidated JSON structures prior to Zod schema parsing, with zero dependency
 * on `zod`, `node:fs`, or `node:http`.
 */

import { McpError } from "./errors.js";
import { normalizeExposureAlias } from "./tool-exposure.js";

/**
 * Keys a Pi 1.3.0 project entry may override on the global entry of the same name (`/mcp` writes
 * such an entry as soon as a global server is disabled or its exposure is changed for one project).
 * `exposure` / `toolExposure` are Pi-native tool-exposure settings and are honored by the tool
 * bridge; `lifecycle` is this extension's equivalent of `enabled`.
 */
export const PROJECT_OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure", "lifecycle"] as const;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rewrite Pi 1.x OAuth config aliases (`callbackUrl`, `callbackPort`) onto `redirectUrl` before
 * schema validation.
 */
export function normalizeAuthConfigAliases(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const obj: Record<string, unknown> = { ...raw };
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
}

/** Map legacy `type`/`url`-only entries onto an explicit `transport`. */
function normalizeTransportAlias(obj: Record<string, unknown>): void {
  const rawTransport = obj.transport ?? obj.type;
  if (rawTransport === "http") {
    obj.transport = "streamable-http";
    return;
  }
  if (obj.transport !== undefined) {
    return;
  }
  if (rawTransport !== undefined) {
    obj.transport = rawTransport;
    return;
  }
  if (obj.url !== undefined && obj.command === undefined) {
    obj.transport = "streamable-http";
  }
}

/** Map the legacy `oauth` object onto `auth`. */
function normalizeAuthAlias(obj: Record<string, unknown>): void {
  if (obj.auth !== undefined) {
    return;
  }
  if (isPlainObject(obj.oauth)) {
    obj.auth = obj.oauth;
  }
}

/**
 * Map Pi 1.3.0 `enabled: false` onto `lifecycle: "lazy"`. Pi keeps a disabled entry configured but
 * out of the connect set; the closest behavior here is the lazy lifecycle (manual `/mcp:start`).
 * An explicit `lifecycle: "eager"` never wins over `enabled: false`, which is what Pi does too.
 */
function normalizeEnabledAlias(obj: Record<string, unknown>): void {
  if (obj.enabled === false) {
    obj.lifecycle = "lazy";
  }
}

/** Map legacy `timeout` (seconds) onto `requestTimeoutMs` (milliseconds). */
function normalizeTimeoutAlias(obj: Record<string, unknown>): void {
  if (obj.requestTimeoutMs !== undefined) {
    return;
  }
  if (typeof obj.timeout !== "number" || obj.timeout <= 0) {
    return;
  }
  obj.requestTimeoutMs = obj.timeout * 1000;
}

/**
 * Map Pi's retired `codemode-deferred` exposure alias onto `codemode`, on the server `exposure`
 * and on every `toolExposure` value. Pi accepts the alias in shared configs, so a config Pi
 * wrote must not fail validation here.
 */
function normalizeExposureAliases(obj: Record<string, unknown>): void {
  if (obj.exposure !== undefined) {
    obj.exposure = normalizeExposureAlias(obj.exposure);
  }
  if (!isPlainObject(obj.toolExposure)) return;
  obj.toolExposure = Object.fromEntries(
    Object.entries(obj.toolExposure).map(([tool, value]) => [tool, normalizeExposureAlias(value)]),
  );
}

/** Rewrite Pi 1.x config aliases (`type`, `oauth`, `timeout`, `enabled`) before schema validation. */
export function normalizeServerConfigAliases(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const obj: Record<string, unknown> = { ...raw };
  normalizeTransportAlias(obj);
  normalizeAuthAlias(obj);
  normalizeTimeoutAlias(obj);
  normalizeEnabledAlias(obj);
  normalizeExposureAliases(obj);
  return obj;
}

/**
 * Default extension-registered servers (`pi.registerMcpServer()`) to `lifecycle: "eager"` unless
 * `lifecycle` is explicitly specified or `enabled` is `false`.
 */
export function withRegisteredServerLifecycle(raw: unknown): unknown {
  if (!isPlainObject(raw) || raw.lifecycle !== undefined) {
    return raw;
  }
  return {
    ...raw,
    lifecycle: raw.enabled === false ? "lazy" : "eager",
  };
}

/** A project entry without a transport definition only overrides the global server of that name. */
export function isProjectOverrideEntry(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  return (
    value.command === undefined &&
    value.url === undefined &&
    value.type === undefined &&
    value.transport === undefined
  );
}

function invalidProjectConfig(projectPath: string, detail: string): McpError {
  return new McpError(`Invalid mcp.json at ${projectPath}:\n  ${detail}`, "<config>", "config");
}

/** Merge a partial project override onto the raw global entry, keeping the global credentials. */
function mergeProjectOverride(
  name: string,
  override: Record<string, unknown>,
  globalServers: Record<string, unknown>,
  projectPath: string,
): Record<string, unknown> {
  const base = globalServers[name];
  if (!isPlainObject(base)) {
    throw invalidProjectConfig(
      projectPath,
      `mcpServers.${name}: a project override needs "command" or "url" in this file, or a global server of that name`,
    );
  }
  const unsupported = Object.keys(override).filter(
    (key) => !(PROJECT_OVERRIDE_KEYS as readonly string[]).includes(key),
  );
  if (unsupported.length > 0) {
    throw invalidProjectConfig(
      projectPath,
      `mcpServers.${name}: a project override can only set ${PROJECT_OVERRIDE_KEYS.join(", ")} (found ${unsupported.join(", ")})`,
    );
  }
  const merged: Record<string, unknown> = { ...base };
  if (override.lifecycle !== undefined && override.enabled === undefined) {
    delete merged.enabled;
  }
  for (const key of PROJECT_OVERRIDE_KEYS) {
    if (override[key] !== undefined) {
      merged[key] = override[key];
    }
  }
  return merged;
}

/**
 * Resolve Pi 1.3.0 partial project entries (`{ "<server>": { "enabled": false } }`) against the raw
 * global file *before* validation, so `ProjectConfigSchema` sees a complete entry instead of
 * failing with `"command" is required for stdio transport` (which tore down every global server on
 * `session_start`).
 */
export function applyProjectOverrides(projectRaw: unknown, globalRaw: unknown, projectPath: string): unknown {
  if (!isPlainObject(projectRaw) || !isPlainObject(projectRaw.mcpServers)) return projectRaw;
  const globalServers = isPlainObject(globalRaw) && isPlainObject(globalRaw.mcpServers)
    ? globalRaw.mcpServers
    : {};
  const servers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(projectRaw.mcpServers)) {
    servers[name] = isProjectOverrideEntry(value)
      ? mergeProjectOverride(name, value, globalServers, projectPath)
      : value;
  }
  return { ...projectRaw, mcpServers: servers };
}
