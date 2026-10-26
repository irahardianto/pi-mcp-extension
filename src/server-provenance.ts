/**
 * Per-server configuration provenance for `/mcp <name>` and `mcp_status`.
 *
 * A server entry can come from the global `<agentDir>/mcp.json`, the project's
 * `<cwd>/.pi/mcp.json`, or `pi.registerMcpServer()`. The merged config that the
 * runtime holds loses that information, so `loadConfigWithOrigins` reports the
 * file-level origin and the runtime merges in the extension-registered names here.
 */

import type { FileConfigOrigin } from "./config.js";
import { sanitizeTerminalText } from "./terminal-text.js";

/** Where a configured server's winning entry came from. */
export type ServerConfigSource = FileConfigOrigin | "extension";

export interface ConfigProvenanceInput {
  /** Winning origin per server name, as reported by `loadConfigWithOrigins`. */
  origins: Record<string, FileConfigOrigin>;
  /** Project config path for the cwd the current config was loaded from. */
  projectConfigPath: string;
  /** False when `<cwd>/.pi/mcp.json` was skipped (untrusted project, or bootstrap). */
  projectConfigIncluded: boolean;
}

export interface ConfigProvenance {
  /** Winning source per configured server name. */
  sources: Record<string, ServerConfigSource>;
  projectConfigPath: string;
  projectConfigIncluded: boolean;
}

/**
 * Combine file-level origins with the names registered by extensions.
 * File entries win: `collectRegisteredServers` drops a registered server that a
 * config file already defines, so an extension can never shadow a file entry.
 */
export function withExtensionServers(
  input: ConfigProvenanceInput,
  extensionServerNames: readonly string[],
): ConfigProvenance {
  const sources: Record<string, ServerConfigSource> = {};
  for (const [name, origin] of Object.entries(input.origins)) {
    sources[name] = origin;
  }
  for (const name of extensionServerNames) {
    if (!Object.hasOwn(sources, name)) {
      sources[name] = "extension";
    }
  }
  return {
    sources,
    projectConfigPath: input.projectConfigPath,
    projectConfigIncluded: input.projectConfigIncluded,
  };
}

/** Recorded source for `serverName`, or `undefined` when it is not in `provenance.sources`. */
export function lookupServerSource(
  provenance: ConfigProvenance,
  serverName: string,
): ServerConfigSource | undefined {
  return Object.hasOwn(provenance.sources, serverName)
    ? provenance.sources[serverName]
    : undefined;
}

/** Source shown for a server, or `"unknown"` when it is not in the loaded config. */
export function formatServerSource(source: ServerConfigSource | undefined): ServerConfigSource | "unknown" {
  return source ?? "unknown";
}

/** Note explaining a skipped project config, or undefined when it was applied. */
export function formatProjectConfigNote(provenance: ConfigProvenance): string | undefined {
  if (provenance.projectConfigIncluded) {
    return undefined;
  }
  return `Project config: not loaded (${sanitizeTerminalText(provenance.projectConfigPath)}) — this project is not trusted, so its mcp.json is never read`;
}
