/**
 * Pi 1.3.0 MCP tool exposure (`exposure` / `toolExposure`) resolution, Pi tool-exposure
 * mapping, server `ToolNamespace` construction, and discovery-tool (`codemode` /
 * `tool_search`) activation planning.
 *
 * A server entry may declare how each of its tools reaches the model: `direct` (declared
 * to the model and active), `deferred` (inactive until `tool_search` loads it), `codemode`
 * (callable from codemode scripts via `searchTools()`, also loadable by `tool_search`), or
 * `hidden` (registered but unreachable). Pi resolves one tool's exposure from its
 * `toolExposure` entry first — an exact name, then the first matching `*` pattern in
 * declaration order — and falls back to the server's `exposure`.
 *
 * WHY: Pi's built-in MCP client defaults an omitted `exposure` to `codemode`, while this
 * extension keeps `direct` so an existing `mcp.json` that states no exposure keeps
 * registering and activating every discovered tool exactly as before (#257).
 */

import type { ToolNamespace } from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "./secret-redaction.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import { resolveServerNamespaceIds } from "./tool-names.js";

/** Exposure levels Pi accepts for MCP tools; Pi's `codemode-deferred` alias is normalized away. */
export const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden"] as const;

/** Exposure of one MCP tool in `mcp.json` / `pi.registerMcpServer()`. */
export type McpExposure = (typeof MCP_EXPOSURES)[number];

/**
 * Subset of Pi's `ToolDefinition["exposure"]` values that MCP tools register with.
 *
 * WHY: MCP config `"codemode"` maps onto Pi tool exposure `"deferred"`, matching Pi's own
 * `toToolExposure()`. In Pi 1.3.0, `ToolDefinition.exposure = "codemode"` instructs
 * `createCodemodeDescription()` to inline the tool's schema into the `codemode` tool
 * description (up to `inlineBudget` tokens, mutating `codemode`'s declaration whenever a
 * server connects), whereas MCP `"codemode"` means callable from codemode scripts via
 * `searchTools()` *without* listing tool schemas in `codemode`'s description. Both MCP
 * `"codemode"` and `"deferred"` therefore register as `"deferred"` and differ in which
 * discovery tool (`codemode` vs `tool_search`) is activated to reach them (#257).
 */
export type PiToolExposure = "direct" | "deferred" | "hidden";

/** Exposure used when the server entry states none (see the module comment). */
export const DEFAULT_EXPOSURE: McpExposure = "direct";

/** Built-in Pi discovery tool names that reach non-`direct` MCP tools. */
export const CODEMODE_TOOL_NAME = "codemode";
export const TOOL_SEARCH_TOOL_NAME = "tool_search";

/** Character budgets matching Pi's namespace summary and server instruction caps. */
const MAX_NAMESPACE_DESCRIPTION_LENGTH = 250;
const MAX_NAMESPACE_INSTRUCTIONS_LENGTH = 500;

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

/** Map a resolved MCP exposure onto the `ToolDefinition["exposure"]` passed to `pi.registerTool()`. */
export function toPiToolExposure(exposure: McpExposure): PiToolExposure {
  return exposure === "codemode" ? "deferred" : exposure;
}

/** Server entry fields that decide tool exposure (a parsed `ServerConfig` satisfies this). */
export interface ToolExposureConfig {
  enabled?: boolean | undefined;
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

/**
 * Decide whether one advertised tool belongs in Pi's active set on a live `refreshTools`
 * of an already-connected server.
 *
 * - `"hidden"` is never active.
 * - A newly advertised tool (`prevActive === undefined`) activates iff `nextExposure === "direct"`.
 * - When `nextExposure` crosses between `"direct"` and non-`"direct"` relative to `prevExposure`
 *   (live exposure narrowing or widening), the new exposure decides.
 * - Otherwise Pi's current active/inactive state wins: a `direct` tool another extension
 *   deactivated stays inactive (#214), and a `deferred`/`codemode` tool `tool_search`
 *   loaded stays active until disconnect (#257).
 */
export function shouldActivateLiveTool(
  prevActive: boolean | undefined,
  prevExposure: McpExposure | undefined,
  nextExposure: McpExposure,
): boolean {
  if (nextExposure === "hidden") return false;
  if (prevActive === undefined) return nextExposure === "direct";
  if (prevExposure !== undefined && (prevExposure === "direct") !== (nextExposure === "direct")) {
    return nextExposure === "direct";
  }
  return prevActive;
}

export interface LiveRefreshStateInput {
  currentRawNames: ReadonlyMap<string, string>;
  currentExposures: ReadonlyMap<string, McpExposure>;
  previousStateByRawName: ReadonlyMap<string, boolean>;
  previousExposures: ReadonlyMap<string, McpExposure> | undefined;
  previousDropped: ReadonlyMap<string, boolean> | undefined;
}

export interface LiveRefreshStateResult {
  desiredActive: Set<string>;
  dropped: Map<string, boolean> | undefined;
}

function nextDroppedToolState(
  previousStateByRawName: ReadonlyMap<string, boolean>,
  seenRawNames: ReadonlySet<string>,
  previousDropped: ReadonlyMap<string, boolean> | undefined,
): Map<string, boolean> | undefined {
  const dropped = new Map<string, boolean>(previousDropped);
  for (const [rawName, wasActive] of previousStateByRawName) {
    if (!seenRawNames.has(rawName)) {
      dropped.set(rawName, wasActive);
    }
  }
  for (const rawName of seenRawNames) {
    dropped.delete(rawName);
  }
  return dropped.size > 0 ? dropped : undefined;
}

/**
 * Pure live-refresh reconciliation: compute which Pi tool names stay/become active and update
 * the connection's dropped-tool memory.
 */
export function reconcileLiveRefreshState(input: LiveRefreshStateInput): LiveRefreshStateResult {
  const desiredActive = new Set<string>();
  const seenRawNames = new Set<string>();
  for (const [piName, rawName] of input.currentRawNames) {
    seenRawNames.add(rawName);
    const prevActive =
      input.previousStateByRawName.get(rawName) ?? input.previousDropped?.get(rawName);
    const nextExposure = input.currentExposures.get(rawName) ?? DEFAULT_EXPOSURE;
    if (shouldActivateLiveTool(prevActive, input.previousExposures?.get(rawName), nextExposure)) {
      desiredActive.add(piName);
    }
  }
  return {
    desiredActive,
    dropped: nextDroppedToolState(
      input.previousStateByRawName,
      seenRawNames,
      input.previousDropped,
    ),
  };
}

/** Retain resolved exposures for currently advertised and dropped tools on an active connection. */
export function mergeRawToolExposures(
  previousExposures: ReadonlyMap<string, McpExposure> | undefined,
  currentExposures: ReadonlyMap<string, McpExposure>,
  dropped: ReadonlyMap<string, boolean> | undefined,
): Map<string, McpExposure> {
  const merged = new Map<string, McpExposure>(previousExposures);
  for (const [rawName, exposure] of currentExposures) {
    merged.set(rawName, exposure);
  }
  for (const rawName of merged.keys()) {
    if (!currentExposures.has(rawName) && !dropped?.has(rawName)) {
      merged.delete(rawName);
    }
  }
  return merged;
}

export interface ServerToolNamespaceOptions {
  prefix: string;
  serverName: string;
  description?: string | undefined;
  instructions?: string | undefined;
  /** Optional peer server names so colliding sanitized names (`my-srv` vs `my_srv`) disambiguate deterministically. */
  peerServerNames?: Iterable<string> | undefined;
}

export function sanitizeNamespaceText(raw: unknown, maxLength: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  // WHY: strip terminal escapes before redacting so escape sequences inside a credential
  // cannot hide a `key=value` token shape, then bound after `[REDACTED]` expansion.
  const cleaned = sanitizeTerminalText(raw, { maxLength: raw.length }).trim();
  return sanitizeTerminalText(redactSecrets(cleaned), { maxLength }).trim() || undefined;
}

/** Build the canonical uncollided `<prefix>_<sanitizedServer>` namespace name for one MCP server. */
export function buildServerNamespaceName(prefix: string, serverName: string): string {
  return `${prefix}_${serverName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

/**
 * Build Pi's `ToolNamespace` metadata for one MCP server so `tool_search` ranks tools with
 * server context and codemode's `searchTools({ namespace })` / `describeNamespace()` resolve
 * the server by `<prefix>_<server>`, raw `<server>`, or Pi's `mcp__<server>` convention without
 * cross-matching colliding peer server names (`my-srv` vs `my_srv`).
 */
export function buildServerToolNamespace(options: ServerToolNamespaceOptions): ToolNamespace {
  const { name, aliases } = resolveServerNamespaceIds(
    options.prefix,
    options.serverName,
    options.peerServerNames,
  );
  const description = sanitizeNamespaceText(options.description, MAX_NAMESPACE_DESCRIPTION_LENGTH);
  const instructions = sanitizeNamespaceText(
    options.instructions,
    MAX_NAMESPACE_INSTRUCTIONS_LENGTH,
  );
  return {
    name,
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(description ? { description } : {}),
    ...(instructions ? { instructions } : {}),
  };
}

/** Collect every exposure level an enabled set of server configs may assign before connecting. */
export function collectConfiguredExposures(
  configs: Iterable<ToolExposureConfig>,
): Set<McpExposure> {
  const exposures = new Set<McpExposure>();
  for (const cfg of configs) {
    if (cfg.enabled === false) continue;
    exposures.add(cfg.exposure ?? DEFAULT_EXPOSURE);
    for (const override of Object.values(cfg.toolExposure ?? {})) {
      exposures.add(override);
    }
  }
  return exposures;
}

/** Collect resolved MCP exposures across all currently connected servers. */
export function collectConnectedExposures(
  serverExposures: Iterable<Iterable<McpExposure>>,
): Set<McpExposure> {
  const exposures = new Set<McpExposure>();
  for (const perServer of serverExposures) {
    for (const exposure of perServer) {
      exposures.add(exposure);
    }
  }
  return exposures;
}

/**
 * Union enabled configured exposures with currently connected server exposures so manually
 * started `enabled: false` servers keep their reaching discovery tools (`codemode` /
 * `tool_search`) active across `session_start`, `mcp_servers_change`, and `session_tree` (#257).
 */
export function collectRequiredDiscoveryExposures(
  configs: Iterable<ToolExposureConfig>,
  connectedExposures: Iterable<McpExposure>,
): Set<McpExposure> {
  const required = collectConfiguredExposures(configs);
  for (const exposure of connectedExposures) {
    required.add(exposure);
  }
  return required;
}

/** Minimal view of a `pi.getAllTools()` entry needed to detect reaching discovery tools. */
export interface RegisteredToolSummary {
  name: string;
  reachesTools?: unknown;
}

export interface ServerExposureAssessmentInput {
  serverName: string;
  toolPrefix: string;
  piExposures: ReadonlyMap<string, McpExposure>;
  allTools?: readonly RegisteredToolSummary[] | undefined;
}

export interface ServerExposureAssessment {
  /** Distinct exposures of tools actually registered in Pi (or all exposures when `allTools` is absent). */
  exposures: Set<McpExposure>;
  /** True when the server configured indirect tools and Pi's `--tools` / `--exclude-tools` dropped all of them. */
  allIndirectFiltered: boolean;
  /** Actionable warning when Pi's tool allowlist/denylist filtered out every indirect tool of this server. */
  filteredWarning?: string | undefined;
}

function isIndirectExposure(exposure: McpExposure): boolean {
  return exposure === "codemode" || exposure === "deferred";
}

function collectSurvivingExposures(
  piExposures: ReadonlyMap<string, McpExposure>,
  registeredNames: ReadonlySet<string>,
): { exposures: Set<McpExposure>; allIndirectFiltered: boolean } {
  const exposures = new Set<McpExposure>();
  let hadIndirect = false;
  let survivingIndirect = false;
  for (const [piName, exposure] of piExposures) {
    const indirect = isIndirectExposure(exposure);
    if (indirect) hadIndirect = true;
    if (exposure === "hidden" || registeredNames.has(piName)) {
      exposures.add(exposure);
      if (indirect) survivingIndirect = true;
    }
  }
  return { exposures, allIndirectFiltered: hadIndirect && !survivingIndirect };
}

/**
 * Reconcile a server's resolved tool exposures against Pi's post-registration `getAllTools()`
 * registry so `--tools` / `--exclude-tools` filtering of single-underscore `<prefix>_*` tools is
 * detected instead of leaving `<mcp_servers>` or `mcp_connect` claiming unreachable tools work (#257).
 */
export function assessRegisteredServerExposures(
  input: ServerExposureAssessmentInput,
): ServerExposureAssessment {
  if (input.allTools === undefined) {
    return { exposures: new Set(input.piExposures.values()), allIndirectFiltered: false };
  }
  const registeredNames = new Set(input.allTools.map((tool) => tool.name));
  const { exposures, allIndirectFiltered } = collectSurvivingExposures(
    input.piExposures,
    registeredNames,
  );
  if (!allIndirectFiltered) {
    return { exposures, allIndirectFiltered: false };
  }
  const safeServer = sanitizeNamespaceText(input.serverName, 120) ?? input.serverName;
  return {
    exposures,
    allIndirectFiltered: true,
    filteredWarning:
      `Indirect MCP tools from "${safeServer}" were filtered out by Pi tool restrictions ` +
      `(--tools / --exclude-tools); include ${input.toolPrefix}_* in --tools so codemode and tool_search can reach them.`,
  };
}

export interface DiscoveryActivationInput {
  exposures: Iterable<McpExposure>;
  allTools: readonly RegisteredToolSummary[];
  activeTools: readonly string[];
  autoEnableCodemode?: boolean | undefined;
}

export interface DiscoveryActivationPlan {
  /** Discovery tools to add to Pi's active set, in deterministic order. */
  activate: string[];
  /** Warning when indirect MCP tools have neither `codemode` nor `tool_search` active. */
  unreachableWarning?: string | undefined;
}

function hasReachingTool(allTools: readonly RegisteredToolSummary[], name: string): boolean {
  // WHY: only Pi's reaching discovery tools declare `reachesTools`; an unrelated tool of the
  // same name from another extension must never be auto-activated (#257).
  return allTools.some((tool) => tool.name === name && Boolean(tool.reachesTools));
}

function selectDiscoveryTools(
  exposureSet: ReadonlySet<McpExposure>,
  hasCodemode: boolean,
  hasToolSearch: boolean,
  activeSet: ReadonlySet<string>,
  autoEnableCodemode: boolean,
): string[] {
  const activate: string[] = [];
  const canAutoEnableCodemode = hasCodemode && autoEnableCodemode;
  if (exposureSet.has("codemode") && canAutoEnableCodemode && !activeSet.has(CODEMODE_TOOL_NAME)) {
    activate.push(CODEMODE_TOOL_NAME);
  }
  if (exposureSet.has("deferred") && hasToolSearch && !activeSet.has(TOOL_SEARCH_TOOL_NAME)) {
    activate.push(TOOL_SEARCH_TOOL_NAME);
  }
  return activate;
}

/**
 * Plan which Pi discovery tools (`codemode` for `"codemode"` unless `autoEnableCodemode` is
 * `false`, `tool_search` for `"deferred"`) must be activated so non-`direct` MCP tools are
 * reachable when `builtin:mcp` is replaced by this extension.
 */
export function resolveDiscoveryActivation(
  input: DiscoveryActivationInput,
): DiscoveryActivationPlan {
  const exposureSet = new Set(input.exposures);
  const needsCodemode = exposureSet.has("codemode");
  const needsToolSearch = exposureSet.has("deferred");
  if (!needsCodemode && !needsToolSearch) return { activate: [] };

  const autoEnable = input.autoEnableCodemode !== false;
  const hasCodemode = hasReachingTool(input.allTools, CODEMODE_TOOL_NAME);
  const hasToolSearch = hasReachingTool(input.allTools, TOOL_SEARCH_TOOL_NAME);
  const activeSet = new Set(input.activeTools);
  const activate = selectDiscoveryTools(
    exposureSet,
    hasCodemode,
    hasToolSearch,
    activeSet,
    autoEnable,
  );
  const reachable = new Set([...activeSet, ...activate]);
  if ((hasCodemode && reachable.has(CODEMODE_TOOL_NAME)) || (hasToolSearch && reachable.has(TOOL_SEARCH_TOOL_NAME))) {
    return { activate };
  }
  const blockedBySetting = needsCodemode && hasCodemode && !autoEnable;
  const reason = blockedBySetting ? " (autoEnableCodemode is false)" : "";
  return {
    activate,
    unreachableWarning:
      `MCP tools are only reachable from the codemode or tool_search tool, ` +
      `but neither is active${reason}; they cannot be called.`,
  };
}
