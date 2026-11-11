/**
 * Pure deterministic tool-ordering policy and provider-payload transforms (#278).
 *
 * Keeps MCP tool positions in Pi's active list and in outgoing provider requests a pure
 * function of the tool set — independent of eager-connect timing, `tools/list` order,
 * `/tree` transcript restoration, mid-turn `setActiveTools` calls, and first-appearance
 * transcript replay — while leaving non-owned tools and provider-specific markers in place.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when two tool-name lists have the same length and the same entries in order. */
export function sameToolList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((name, index) => name === right[index]);
}

/** Compare strings by Unicode code point, not by UTF-16 code unit. */
export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, (ch) => ch.codePointAt(0) ?? 0);
  const right = Array.from(b, (ch) => ch.codePointAt(0) ?? 0);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/**
 * Sort the entries `isOwned` selects into name order inside the slots they already occupy, and
 * return `undefined` when the result is identical to `entries`.
 *
 * WHY: this bridge cannot move what it does not own — another extension's tools keep the position
 * they were given, and so does Pi's trailing Anthropic `__pi_deferred_placeholder__`, which Pi
 * requires last — while the bridge's own tools, whose insertion order depends on which server
 * connected first and on `tools/list` order, end up in one deterministic order (#278).
 */
export function orderOwnedEntries<T>(
  entries: readonly T[],
  nameOf: (entry: T) => string | undefined,
  isOwned: (name: string) => boolean,
): T[] | undefined {
  const owned: Array<{ slot: number; name: string; entry: T }> = [];
  entries.forEach((entry, slot) => {
    const name = nameOf(entry);
    if (name !== undefined && isOwned(name)) owned.push({ slot, name, entry });
  });
  if (owned.length < 2) return undefined;

  const slots = owned.map((candidate) => candidate.slot);
  owned.sort((left, right) => compareCodePoints(left.name, right.name));
  const ordered = [...entries];
  owned.forEach((candidate, index) => {
    const slot = slots[index];
    if (slot === undefined) return;
    ordered[slot] = candidate.entry;
  });
  const unchanged = ordered.every((entry, index) => entry === entries[index]);
  return unchanged ? undefined : ordered;
}

function nestedStringField(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string | undefined {
  const nested = record[key];
  if (!isRecord(nested)) return undefined;
  const value = nested[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * Name of a provider tool definition: `{ name }` (Anthropic, OpenAI/Azure/Codex Responses,
 * Gemini `functionDeclarations`, `pi-messages` `toolsAdded`), `{ function: { name } }`
 * (OpenAI Chat Completions, Mistral), or `{ toolSpec: { name } }` (AWS Bedrock Converse).
 */
function payloadToolName(definition: unknown): string | undefined {
  if (!isRecord(definition)) return undefined;
  const name = definition["name"];
  if (typeof name === "string") return name;
  return (
    nestedStringField(definition, "function", "name") ??
    nestedStringField(definition, "toolSpec", "name")
  );
}

/**
 * Keep a slot's `cache_control` breakpoint on that slot when another tool definition moves into
 * it: Pi's Anthropic and OpenAI-completions adapters attach `cache_control` to the last tool
 * slot before `before_provider_request` runs, so moving that object earlier would strand later
 * tools outside the cached prefix and diverge from a session that started in sorted order.
 */
function withSlotCacheControl(entry: unknown, slotEntry: unknown): unknown {
  const entryRecord = entry as Record<string, unknown>;
  const slotCache = (slotEntry as { cache_control?: unknown }).cache_control;
  if (entryRecord["cache_control"] === slotCache) return entry;
  if (slotCache === undefined) {
    const { cache_control: _dropped, ...rest } = entryRecord;
    return rest;
  }
  return { ...entryRecord, cache_control: slotCache };
}

/** Order one tool-definition array in place of its owned slots, keeping slot `cache_control`. */
function orderDefinitionList(
  definitions: unknown,
  isOwned: (name: string) => boolean,
): unknown[] | undefined {
  if (!Array.isArray(definitions) || definitions.length === 0) return undefined;
  const ordered = orderOwnedEntries(definitions, payloadToolName, isOwned);
  if (ordered === undefined) return undefined;
  return ordered.map((entry, index) =>
    entry === definitions[index] ? entry : withSlotCacheControl(entry, definitions[index]),
  );
}

/** Order one Gemini `Tool` entry's `functionDeclarations` array when present. */
function orderGoogleToolGroup(
  group: unknown,
  isOwned: (name: string) => boolean,
): unknown {
  if (!isRecord(group)) return group;
  const ordered = orderDefinitionList(group["functionDeclarations"], isOwned);
  return ordered === undefined ? group : { ...group, functionDeclarations: ordered };
}

/** Order Gemini / Vertex `config.tools[].functionDeclarations` without mutating untouched groups. */
function orderGoogleConfigTools(
  config: unknown,
  isOwned: (name: string) => boolean,
): Record<string, unknown> | undefined {
  if (!isRecord(config) || !Array.isArray(config["tools"])) return undefined;
  const tools = config["tools"];
  const nextTools = tools.map((group) => orderGoogleToolGroup(group, isOwned));
  const changed = nextTools.some((group, index) => group !== tools[index]);
  return changed ? { ...config, tools: nextTools } : undefined;
}

/** Order Bedrock Converse `toolConfig.tools` (`{ toolSpec: { name } }`) when present. */
function orderBedrockToolConfig(
  toolConfig: unknown,
  isOwned: (name: string) => boolean,
): Record<string, unknown> | undefined {
  if (!isRecord(toolConfig)) return undefined;
  const ordered = orderDefinitionList(toolConfig["tools"], isOwned);
  return ordered === undefined ? undefined : { ...toolConfig, tools: ordered };
}

/** Order `toolsAdded` on one `pi-messages` `system` message while leaving other messages as is. */
function orderSystemMessageTools(
  message: unknown,
  isOwned: (name: string) => boolean,
): unknown {
  if (!isRecord(message) || message["role"] !== "system") return message;
  const ordered = orderDefinitionList(message["toolsAdded"], isOwned);
  return ordered === undefined ? message : { ...message, toolsAdded: ordered };
}

/**
 * Order `pi-messages` `context.messages[].toolsAdded` within each `system` message without
 * moving declarations across turns or mutating untouched messages.
 */
function orderPiMessagesContext(
  context: unknown,
  isOwned: (name: string) => boolean,
): Record<string, unknown> | undefined {
  if (!isRecord(context) || !Array.isArray(context["messages"])) return undefined;
  const messages = context["messages"];
  const nextMessages = messages.map((message) => orderSystemMessageTools(message, isOwned));
  const changed = nextMessages.some((message, index) => message !== messages[index]);
  return changed ? { ...context, messages: nextMessages } : undefined;
}

/**
 * Order nested provider tool containers: Bedrock `toolConfig.tools`, Google `config.tools`,
 * or `pi-messages` `context.messages[].toolsAdded`.
 */
function orderNestedPayloadTools(
  payload: Record<string, unknown>,
  isOwned: (name: string) => boolean,
): Record<string, unknown> | undefined {
  const orderedToolConfig = orderBedrockToolConfig(payload["toolConfig"], isOwned);
  if (orderedToolConfig !== undefined) return { ...payload, toolConfig: orderedToolConfig };

  const orderedGoogleConfig = orderGoogleConfigTools(payload["config"], isOwned);
  if (orderedGoogleConfig !== undefined) return { ...payload, config: orderedGoogleConfig };

  const orderedContext = orderPiMessagesContext(payload["context"], isOwned);
  return orderedContext === undefined ? undefined : { ...payload, context: orderedContext };
}

/**
 * Order owned tool definitions in an outgoing provider payload across all 10 built-in Pi API
 * payload shapes, returning `payload` untouched when no owned slots move.
 */
export function orderPayloadToolEntries(
  payload: unknown,
  isOwned: (name: string) => boolean,
): unknown {
  if (!isRecord(payload)) return payload;
  const orderedTopLevel = orderDefinitionList(payload["tools"], isOwned);
  if (orderedTopLevel !== undefined) return { ...payload, tools: orderedTopLevel };
  return orderNestedPayloadTools(payload, isOwned) ?? payload;
}
