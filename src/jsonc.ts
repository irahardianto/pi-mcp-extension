/**
 * Pure JSON-with-comments (JSONC) text utilities. This module has no `src/`
 * dependencies of its own and is safe for the test tree to import: it does not
 * load `zod`, the MCP error types, or the OAuth/callback modules, so a `tests/`
 * consumer stays free of runtime MCP imports.
 *
 * The only behaviour this module performs is `stripJsonComments` — a single-pass
 * character scan that removes `//` line comments and `/* ... *\/` block comments
 * while leaving the rest of the document byte-equivalent. Comments inside
 * double-quoted strings are preserved verbatim, so a JSON value such as
 * `"https://example.com/foo"` is never accidentally truncated. Trailing commas
 * (the other common JSONC extension) are **not** handled here — neither of the
 * files this helper feeds today uses them, and an explicit `JSON.parse` failure
 * on a misplaced comma is a more honest signal than silent acceptance.
 */

/**
 * Strip `//` line comments and `/* ... *\/` block comments outside of double-quoted
 * JSON strings in a single character-by-character pass.
 *
 * Preserves `\n` and `\r` characters so line numbers in `JSON.parse` error messages
 * remain accurate. Unterminated `/*` block comments are left intact so `JSON.parse`
 * fails with a syntax error rather than silently truncating the document.
 *
 * WHY: this module exists so `tests/repo-policy.test.ts` can read
 * `.github/rulesets/default-branch.json` with the same JSONC tolerance the runtime
 * uses for `mcp.json`. A future maintainer can add `// WHY: …` style comments to the
 * ruleset (mirroring the convention used throughout `src/`) without breaking the
 * ruleset-policy tests.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    if (inString) {
      if (ch === "\\") {
        out += ch;
        if (i + 1 < text.length) {
          out += text[i + 1]!;
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") {
        if (text[i] === "\r" && text[i + 1] === "\n") break;
        i += 1;
      }
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      const closeIdx = text.indexOf("*/", i + 2);
      if (closeIdx === -1) {
        // WHY: Leave unterminated block comments intact so JSON.parse fails with a
        // SyntaxError rather than silently truncating the rest of the file.
        out += text.slice(i);
        break;
      }
      for (let j = i; j < closeIdx + 2; j += 1) {
        const commentCh = text[j]!;
        out += commentCh === "\n" || commentCh === "\r" ? commentCh : " ";
      }
      i = closeIdx + 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}
