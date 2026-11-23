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
  servers: readonly ServerCompletionEntry[],
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

const RESET_FLAG = "--reset";
const RESET_FLAG_DESCRIPTION = "Discard stored credentials and re-authorize";

function resetFlagCompletion(prefix: string, servers: readonly ServerCompletionEntry[]) {
  if (!prefix.startsWith("-") || !RESET_FLAG.startsWith(prefix)) return null;
  if (!servers.some((server) => Boolean(server.config.auth))) return null;
  return { value: `${RESET_FLAG} `, label: RESET_FLAG, description: RESET_FLAG_DESCRIPTION };
}

function leadingResetServerCompletions(
  resetSeparator: string,
  serverPrefix: string,
  servers: readonly ServerCompletionEntry[],
) {
  const resetMatches = serverNameCompletions(serverPrefix, servers, { authOnly: true });
  if (!resetMatches) return [];

  const serverNames = servers.map((server) => server.name);
  const completions = [];
  for (const item of resetMatches) {
    // WHY: Pi replaces the entire argument prefix, so the completion must reinsert the flag.
    const value = `${resetSeparator}${item.value}`;
    // Exact configured names and trailing flags can take precedence over a leading flag.
    const parsed = parseAuthArguments(value, serverNames);
    if (parsed.reset && parsed.name === item.value) completions.push({ ...item, value });
  }
  return completions;
}

export function authArgumentCompletions(argumentPrefix: string, servers: readonly ServerCompletionEntry[]) {
  const prefix = argumentPrefix.trimStart();
  const literalMatches = serverNameCompletions(prefix, servers, { authOnly: true }) ?? [];
  const resetPrefix = /^--reset\s+/.exec(prefix);
  if (!resetPrefix) {
    const flagCompletion = resetFlagCompletion(prefix, servers);
    const completions = flagCompletion ? [...literalMatches, flagCompletion] : literalMatches;
    return completions.length > 0 ? completions : null;
  }

  const serverPrefix = prefix.slice(resetPrefix[0].length);
  const completions = [
    ...literalMatches,
    ...leadingResetServerCompletions(resetPrefix[0], serverPrefix, servers),
  ];
  return completions.length > 0 ? completions : null;
}

export { collectRegisteredServers, mergeWithRegisteredServers } from "./session-lifecycle.js";
// WHY: Pi 1.3.0 only reports --no-mcp through its own parsed arguments; extensions cannot
// read that setting from ExtensionAPI. Mirror its value-taking flags to avoid treating
// an option's value as the --no-mcp switch.
const PI_VALUE_TAKING_FLAGS = new Set([
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--name",
  "-n",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "--models",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--thinking",
  "--export",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
]);

/** Return true only when Pi receives --no-mcp as a CLI flag, not as a value or positional argument. */
export function hasNoMcpFlag(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") break;
    if (arg === "--no-mcp") return true;
    if (PI_VALUE_TAKING_FLAGS.has(arg)) i++;
  }
  return false;
}
