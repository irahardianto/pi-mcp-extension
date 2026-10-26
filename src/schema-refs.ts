/**
 * Pure JSON Pointer ($ref) resolution for pi-mcp's JSON Schema → TypeBox conversion.
 */

// ─── JSON Pointer Resolution ──────────────────────────────────────────────────

function unescapeJsonPointer(segment: string): string {
  // WHY: RFC 6901 §4 requires unescaping "~1" to "/" before "~0" to "~" so "~01" becomes "~1".
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
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

  if (isDefsPointer(parts)) {
    const defTarget = resolveFromRootDefs(parts, rootDefs);
    if (defTarget) {
      return defTarget;
    }
  }

  return walkJsonPointer(rootSchema, parts);
}
