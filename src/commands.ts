/**
 * Command argument parsing and tab completions for `/mcp*` commands.
 */

function stripResetFlag(name: string): { name: string; reset: boolean } {
  // WHY: Support standalone `--reset` as well as leading (`--reset <name>`) and trailing (`<name> --reset`)
  // flag positions so `/mcp:auth --reset` prints the usage message rather than looking up a server named "--reset".
  if (name === "--reset") return { name: "", reset: true };
  if (/\s+--reset$/.test(name)) {
    return { name: name.replace(/\s+--reset$/, "").trimEnd(), reset: true };
  }
  if (/^--reset\s+/.test(name)) {
    return { name: name.replace(/^--reset\s+/, "").trimStart(), reset: true };
  }
  return { name, reset: false };
}

/** Resolve exact server names before interpreting the optional reset flag. */
export function parseAuthArguments(args = "", serverNames: string[] = []): { name: string; reset: boolean } {
  const name = args.trim();
  if (!name) return { name: "", reset: false };
  if (serverNames.includes(name)) return { name, reset: false };
  return stripResetFlag(name);
}

/** Parsed `/mcp:resources [server] [uri]` arguments. */
export interface ResourceArguments {
  server: string;
  uri: string;
}

function findMatchingServerPrefix(trimmed: string, serverNames: readonly string[]): string | undefined {
  const sorted = [...serverNames].sort((a, b) => b.length - a.length);
  return sorted.find((name) => name.length > 0 && trimmed.startsWith(name) && /\s/.test(trimmed[name.length] ?? ""));
}

/**
 * Split `/mcp:resources` arguments into an optional server name and an optional URI.
 * Exact and prefix matches against configured `serverNames` are checked first so server names
 * containing spaces (`"team server"`) are preserved, and the URI keeps everything after the
 * server delimiter so a URI containing spaces (`file:///path/with space`) is not truncated.
 */
export function parseResourceArguments(args = "", serverNames: readonly string[] = []): ResourceArguments {
  const trimmed = args.trim();
  if (!trimmed) return { server: "", uri: "" };
  if (serverNames.includes(trimmed)) return { server: trimmed, uri: "" };
  const matchedServer = findMatchingServerPrefix(trimmed, serverNames);
  if (matchedServer) return { server: matchedServer, uri: trimmed.slice(matchedServer.length).trim() };
  const separator = trimmed.search(/\s/);
  return separator === -1
    ? { server: trimmed, uri: "" }
    : { server: trimmed.slice(0, separator), uri: trimmed.slice(separator).trim() };
}

export interface ServerCompletionEntry {
  name: string;
  state: string;
  config: {
    transport: string;
    lifecycle: string;
    auth?: unknown;
  };
}

export function serverNameCompletions(
  argumentPrefix: string,
  servers: ServerCompletionEntry[],
  options: { authOnly?: boolean } = {},
) {
  const prefix = argumentPrefix.trimStart();
  const completions = servers
    .filter((server) => !options.authOnly || server.config.auth)
    .filter((server) => server.name.startsWith(prefix))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((server) => ({
      value: server.name,
      label: server.name,
      description: [
        server.state,
        server.config.transport,
        server.config.lifecycle,
        server.config.auth ? "OAuth" : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    }));

  return completions.length > 0 ? completions : null;
}

export { collectRegisteredServers, mergeWithRegisteredServers } from "./session-lifecycle.js";
