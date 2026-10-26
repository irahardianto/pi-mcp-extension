/**
 * Pure JSON-with-comments (JSONC) text utilities. This module has no `src/`
 * dependencies of its own and is safe for `scripts/` and `tests/` to import: it
 * does not load `zod`, the MCP error types, or the OAuth/callback modules, so
 * non-runtime consumers stay free of runtime MCP imports.
 *
 * The only behaviour this module performs is `stripJsonComments` — a single-pass
 * character scan that removes `//` line comments and `/* ... *\/` block comments
 * while leaving the rest of the document byte-equivalent. Comments inside
 * double-quoted strings are preserved verbatim, so a JSON value such as
 * `"https://example.com/foo"` is never accidentally truncated. Trailing commas
 * (the other common JSONC extension) are **not** handled here — none of the
 * files this helper feeds today uses them, and an explicit `JSON.parse` failure
 * on a misplaced comma is a more honest signal than silent acceptance.
 */

interface ConsumedChunk {
  /** Text to append to the output for the span that was consumed. */
  chunk: string;
  /** Index of the first character after the consumed span. */
  nextIndex: number;
}

/**
 * Copy a double-quoted string literal verbatim, starting at its opening quote.
 * Backslash escapes are skipped in pairs so an escaped `"` never closes the string.
 */
function consumeDoubleQuotedString(text: string, start: number): ConsumedChunk {
  let index = start + 1;
  while (index < text.length) {
    const ch = text[index]!;
    if (ch === '"') {
      return { chunk: text.slice(start, index + 1), nextIndex: index + 1 };
    }
    index += ch === "\\" ? 2 : 1;
  }
  // WHY: An unterminated string literal is copied verbatim; JSON.parse then reports
  // the syntax error instead of this helper silently dropping the rest of the file.
  return { chunk: text.slice(start), nextIndex: text.length };
}

/**
 * Advance past a `//` line comment, stopping before `\n` (or before `\r` in `\r\n`)
 * so the line break itself is copied through to the output.
 */
function skipLineComment(text: string, start: number): number {
  let index = start + 2;
  while (index < text.length) {
    if (text[index] === "\n") break;
    if (text[index] === "\r" && text[index + 1] === "\n") break;
    index += 1;
  }
  return index;
}

/**
 * Replace every code unit of a block comment with a space, keeping `\n` and `\r`
 * so line numbers in subsequent `JSON.parse` errors stay accurate.
 */
function maskBlockComment(comment: string): string {
  return comment.replace(/[^\r\n]/g, " ");
}

/**
 * Consume a `/* ... *\/` block comment, starting at its opening `/*`.
 * Unterminated comments are returned intact.
 */
function consumeBlockComment(text: string, start: number): ConsumedChunk {
  const closeIdx = text.indexOf("*/", start + 2);
  if (closeIdx === -1) {
    // WHY: Leave unterminated block comments intact so JSON.parse fails with a
    // SyntaxError rather than silently truncating the rest of the file.
    return { chunk: text.slice(start), nextIndex: text.length };
  }
  return {
    chunk: maskBlockComment(text.slice(start, closeIdx + 2)),
    nextIndex: closeIdx + 2,
  };
}

/**
 * Strip `//` line comments and `/* ... *\/` block comments outside of double-quoted
 * JSON strings in a single character-by-character pass.
 *
 * Preserves `\n` and `\r` characters so line numbers in `JSON.parse` error messages
 * remain accurate. Unterminated `/*` block comments are left intact so `JSON.parse`
 * fails with a syntax error rather than silently truncating the document.
 *
 * WHY: this module exists so `scripts/ruleset-audit.ts` and `tests/repo-policy.test.ts`
 * can read `.github/rulesets/*.json` with the same JSONC tolerance the runtime uses
 * for `mcp.json`. A future maintainer can add `// WHY: …` style comments to the
 * ruleset files (mirroring the convention used throughout `src/`) without breaking the
 * ruleset audit or policy tests.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const ch = text[index]!;

    if (ch === '"') {
      const string = consumeDoubleQuotedString(text, index);
      out += string.chunk;
      index = string.nextIndex;
      continue;
    }

    if (ch === "/" && text[index + 1] === "/") {
      index = skipLineComment(text, index);
      continue;
    }

    if (ch === "/" && text[index + 1] === "*") {
      const comment = consumeBlockComment(text, index);
      out += comment.chunk;
      index = comment.nextIndex;
      continue;
    }

    out += ch;
    index += 1;
  }

  return out;
}
