/**
 * Pure JSON Pointer ($ref) resolution for pi-mcp's JSON Schema → TypeBox conversion.
 */

// ─── JSON Pointer Resolution ──────────────────────────────────────────────────

function decodeFragmentSegment(segment: string): string {
  // WHY: RFC 6901 §6 encodes a "#/..." reference as a URI fragment, so each token arrives
  // percent-encoded ("#/$defs/Response%5BItem%5D"). Decode before §4 unescaping: an encoded
  // "~" ("%7E1") denotes the escape sequence "~1" ("/"), not a literal "~1" key.
  try {
    return decodeURIComponent(segment);
  } catch {
    // WHY: a malformed escape ("%ZZ") must not throw, unlike decodeURIComponent. The raw token is
    // then resolved literally (a definition named "Bad%ZZName" still matches), and otherwise the
    // $ref degrades like any other unresolvable one instead of failing the whole tools/list
    // conversion on a server's arbitrary schema.
    return segment;
  }
}

function unescapeJsonPointer(segment: string): string {
  // WHY: RFC 6901 §4 requires unescaping "~1" to "/" before "~0" to "~" so "~01" becomes "~1".
  return decodeFragmentSegment(segment).replace(/~1/g, "/").replace(/~0/g, "~");
}

function stepArrayPointer(curr: unknown[], part: string): unknown {
  if (!/^(?:0|[1-9][0-9]*)$/.test(part)) {
    return undefined;
  }
  const idx = Number(part);
  return idx >= 0 && idx < curr.length ? curr[idx] : undefined;
}

function stepJsonPointer(curr: unknown, part: string): unknown {
  if (!curr || typeof curr !== "object") {
    return undefined;
  }
  if (Array.isArray(curr)) {
    return stepArrayPointer(curr, part);
  }
  if (!Object.prototype.hasOwnProperty.call(curr, part)) {
    return undefined;
  }
  return (curr as Record<string, unknown>)[part];
}

function isSchemaRecord(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === "object" && !Array.isArray(val);
}

function walkJsonPointer(
  root: unknown,
  segments: readonly string[],
): Record<string, unknown> | undefined {
  let curr: unknown = root;
  for (const part of segments) {
    curr = stepJsonPointer(curr, part);
    if (curr === undefined) {
      return undefined;
    }
  }
  return isSchemaRecord(curr) ? curr : undefined;
}

function isDefsPointer(parts: readonly string[]): boolean {
  return parts[0] === "$defs" || parts[0] === "definitions";
}

function resolveFromRootDefs(
  parts: readonly string[],
  rootDefs: Record<string, Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  const defName = parts[1];
  if (!rootDefs || defName === undefined) {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(rootDefs, defName)) {
    return undefined;
  }
  return walkJsonPointer(rootDefs[defName], parts.slice(2));
}

function unescapeLiteralPointer(segment: string): string {
  // WHY: §6 requires a literal "%" to be encoded as "%25", but a server that emits it raw
  // would stop resolving once segments are decoded. Unescaping only §4 escapes keeps the
  // undecoded token available as a fallback key.
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolvePointerParts(
  parts: readonly string[],
  rootDefs: Record<string, Record<string, unknown>> | undefined,
  rootSchema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (isDefsPointer(parts)) {
    const defTarget = resolveFromRootDefs(parts, rootDefs);
    if (defTarget) {
      return defTarget;
    }
  }
  return walkJsonPointer(rootSchema, parts);
}

/**
 * Token-wise reading: split the fragment, then decode each token (ajv's order).
 * WHY: splitting first keeps "%2F" inside one token, which is what a key containing "/"
 * means — §6 spells such a key "~1", so an encoded separator is the unusual reading.
 */
function resolveDecodedTokens(
  ref: string,
  rootDefs: Record<string, Record<string, unknown>> | undefined,
  rootSchema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const parts = ref
    .slice(2)
    .split("/")
    .map(unescapeJsonPointer);
  return resolvePointerParts(parts, rootDefs, rootSchema);
}

/**
 * Literal reading: same tokens without percent-decoding.
 * WHY: §6 requires a literal "%" to be encoded as "%25", but a server that emits it raw only
 * resolves this way, and decoding would have turned its token into a different key.
 */
function resolveLiteralTokens(
  ref: string,
  rootDefs: Record<string, Record<string, unknown>> | undefined,
  rootSchema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const parts = ref
    .slice(2)
    .split("/")
    .map(unescapeLiteralPointer);
  return resolvePointerParts(parts, rootDefs, rootSchema);
}

/**
 * Whole-fragment reading: decode the entire fragment, then split it, so "%2F" acts as a
 * separator. WHY: a resolver that decodes before parsing reaches subtrees the token-wise
 * reading cannot; trying it last only adds resolutions, never changes an earlier hit.
 */
function resolveWholeFragment(
  ref: string,
  rootDefs: Record<string, Record<string, unknown>> | undefined,
  rootSchema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  let fragment: string;
  try {
    fragment = decodeURIComponent(ref.slice(2));
  } catch {
    return undefined; // WHY: already tried literally; a malformed escape cannot decode either way.
  }
  return resolvePointerParts(fragment.split("/").map(unescapeLiteralPointer), rootDefs, rootSchema);
}

/**
 * Resolve a JSON Schema `$ref` against the root schema's `$defs`/`definitions`
 * and the root schema itself.
 *
 * Supports `#`, `#/$defs/<name>`, `#/definitions/<name>`, and arbitrary RFC 6901
 * JSON Pointers into either, in every fragment encoding a server may emit: decoded
 * tokens (RFC 6901 §6, ajv's order), raw tokens (an unencoded literal "%"), and a
 * whole-fragment decode ("%2F" as a separator). Returns undefined when the reference
 * cannot be resolved.
 */
export function resolveRefTarget(
  ref: string,
  rootDefs: Record<string, Record<string, unknown>> | undefined,
  rootSchema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (ref === "#") {
    return rootSchema;
  }
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  return (
    resolveDecodedTokens(ref, rootDefs, rootSchema) ??
    resolveLiteralTokens(ref, rootDefs, rootSchema) ??
    resolveWholeFragment(ref, rootDefs, rootSchema)
  );
}
