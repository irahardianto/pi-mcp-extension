/**
 * Pure JSON Pointer ($ref) resolution for pi-mcp's JSON Schema → TypeBox conversion.
 */

// ─── JSON Pointer Resolution ──────────────────────────────────────────────────

function unescapeJsonPointer(segment: string): string {
  // WHY: RFC 6901 §4 requires unescaping "~1" to "/" before "~0" to "~" so "~01" becomes "~1".
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function stepJsonPointer(curr: unknown, part: string): unknown {
  if (!curr || typeof curr !== "object") {
    return undefined;
  }
  if (Array.isArray(curr)) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(part)) {
      return undefined;
    }
    const idx = Number(part);
    return idx >= 0 && idx < curr.length ? curr[idx] : undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(curr, part)) {
    return undefined;
  }
  return (curr as Record<string, unknown>)[part];
}

/**
 * Resolve a JSON Schema `$ref` against the root schema's `$defs`/`definitions`
 * and the root schema itself.
 *
 * Supports `#`, `#/$defs/<name>`, `#/definitions/<name>`, and arbitrary RFC 6901
 * JSON Pointers into either. Returns undefined when the reference cannot be resolved.
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

  const parts = ref.slice(2).split("/").map(unescapeJsonPointer);

  if (
    (parts[0] === "$defs" || parts[0] === "definitions") &&
    parts.length >= 2 &&
    rootDefs &&
    Object.prototype.hasOwnProperty.call(rootDefs, parts[1]!)
  ) {
    const defEntry = rootDefs[parts[1]!];
    if (defEntry && typeof defEntry === "object" && !Array.isArray(defEntry)) {
      if (parts.length === 2) {
        return defEntry;
      }
      let curr: unknown = defEntry;
      for (let i = 2; i < parts.length; i++) {
        curr = stepJsonPointer(curr, parts[i]!);
        if (curr === undefined) break;
      }
      if (curr && typeof curr === "object" && !Array.isArray(curr)) {
        return curr as Record<string, unknown>;
      }
    }
  }

  let curr: unknown = rootSchema;
  for (const part of parts) {
    curr = stepJsonPointer(curr, part);
    if (curr === undefined) {
      return undefined;
    }
  }
  if (curr && typeof curr === "object" && !Array.isArray(curr)) {
    return curr as Record<string, unknown>;
  }
  return undefined;
}
