/**
 * Pi 1.3.0 MCP tool exposure (`exposure` / `toolExposure`) resolution.
 *
 * A server entry may declare how each of its tools reaches the model: `direct` (declared
 * to the model and active), `deferred` (inactive until `tool_search` loads it), `codemode`
 * (callable from codemode scripts, also loadable by `tool_search`), or `hidden` (registered
 * but unreachable). Pi
 * resolves one tool's exposure from its `toolExposure` entry first — an exact name, then
 * the first matching `*` pattern in declaration order — and falls back to the server's
 * `exposure`.
 *
 * WHY: Pi's built-in MCP client defaults an omitted `exposure` to `codemode`, while this
 * extension keeps `direct` so an existing `mcp.json` that states no exposure keeps
 * registering and activating every discovered tool exactly as before (#257).
 */

/** Exposure levels Pi accepts for MCP tools; Pi's `codemode-deferred` alias is normalized away. */
export const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden"] as const;

/** Exposure of one MCP tool. */
export type McpExposure = (typeof MCP_EXPOSURES)[number];

/** Exposure used when the server entry states none (see the module comment). */
export const DEFAULT_EXPOSURE: McpExposure = "direct";

/** Retired Pi exposure names mapped to the current name they stand for. */
const EXPOSURE_ALIASES: Readonly<Record<string, McpExposure>> = {
  "codemode-deferred": "codemode",
};

/** Replace a retired exposure alias with its current name; other values pass through unchanged. */
export function normalizeExposureAlias(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const alias = Object.hasOwn(EXPOSURE_ALIASES, value) ? EXPOSURE_ALIASES[value] : undefined;
  return alias ?? value;
}

/** Server entry fields that decide tool exposure (a parsed `ServerConfig` satisfies this). */
export interface ToolExposureConfig {
  exposure?: McpExposure | undefined;
  toolExposure?: Readonly<Record<string, McpExposure>> | undefined;
}

/**
 * Match a tool name against a `toolExposure` pattern where `*` matches any characters.
 *
 * WHY: a greedy two-pointer matcher, not a RegExp — a pattern such as `a*a*a*a*a*a*b`
 * makes a backtracking regex engine exponential against a long non-matching tool name,
 * and the pattern can arrive from a project `mcp.json` shared with a repository. Nothing
 * here is escaped or interpreted as a quantifier, and resuming at the last `*` bounds the
 * work by `pattern.length * toolName.length`.
 */
function matchesExposurePattern(pattern: string, toolName: string): boolean {
  let patternIndex = 0;
  let nameIndex = 0;
  let starIndex = -1;
  let resumeAt = 0;
  while (nameIndex < toolName.length) {
    const expected = pattern[patternIndex];
    if (expected === "*") {
      starIndex = patternIndex;
      resumeAt = nameIndex;
      patternIndex += 1;
    } else if (expected === toolName[nameIndex]) {
      patternIndex += 1;
      nameIndex += 1;
    } else if (starIndex >= 0) {
      resumeAt += 1;
      patternIndex = starIndex + 1;
      nameIndex = resumeAt;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

/**
 * Resolve one raw MCP tool name's exposure: an exact `toolExposure` key wins, then the
 * first matching wildcard pattern in declaration order, then the server `exposure`
 * (default `direct`).
 */
export function resolveToolExposure(
  config: ToolExposureConfig | undefined,
  toolName: string,
): McpExposure {
  const overrides = config?.toolExposure;
  if (overrides) {
    // WHY: own-property lookup — a tool named `constructor` or `__proto__` must not read
    // Object.prototype and hand a function back as its exposure.
    const exact = Object.hasOwn(overrides, toolName) ? overrides[toolName] : undefined;
    if (exact !== undefined) return exact;
    for (const [pattern, exposure] of Object.entries(overrides)) {
      if (pattern.includes("*") && matchesExposurePattern(pattern, toolName)) return exposure;
    }
  }
  return config?.exposure ?? DEFAULT_EXPOSURE;
}
