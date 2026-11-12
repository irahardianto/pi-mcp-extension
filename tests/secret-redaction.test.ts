import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { redactSecrets as redactFromDebugLog } from "../src/debug-log.js";
import { redactSecrets as redactFromDebugLogFormat } from "../src/debug-log-format.js";
import { McpError } from "../src/errors.js";
import { redactSecrets } from "../src/secret-redaction.js";
import { formatErrorMessage } from "../src/startup-auth.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSourceFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("secret-redaction", () => {
  const sampleSecret = "s3cr3t-CREDENTIAL-99";

  it("stays a zero-dependency leaf module, decouples startup-auth and tool-bridge from debug-log, and is the sole canonical redactSecrets import in src/", () => {
    const redactionSource = readSourceFile("src/secret-redaction.ts");
    assert.doesNotMatch(
      redactionSource,
      /^\s*import\b/m,
      "src/secret-redaction.ts must have zero imports",
    );
    assert.doesNotMatch(
      redactionSource,
      /^\s*export\s+\{[^}]*\}\s+from\b/m,
      "src/secret-redaction.ts must have zero re-export dependencies",
    );
    assert.doesNotMatch(
      redactionSource,
      /\brequire\s*\(/,
      "src/secret-redaction.ts must not use require()",
    );

    for (const decoupledModule of ["src/startup-auth.ts", "src/tool-bridge.ts"]) {
      const source = readSourceFile(decoupledModule);
      assert.match(
        source,
        /from "\.\/secret-redaction\.js"/,
        `${decoupledModule} must import redactSecrets directly from ./secret-redaction.js`,
      );
      assert.doesNotMatch(
        source,
        /debug-log(?:-format)?\.js/,
        `${decoupledModule} must not depend on debug-log.ts or debug-log-format.ts`,
      );
    }

    const startupAuthSource = readSourceFile("src/startup-auth.ts");
    assert.doesNotMatch(
      startupAuthSource,
      /from "node:/,
      "src/startup-auth.ts must stay free of node:* runtime imports",
    );

    const srcFiles = readdirSync(path.join(repoRoot, "src")).filter((file) => file.endsWith(".ts"));
    for (const file of srcFiles) {
      const source = readSourceFile(`src/${file}`);
      assert.doesNotMatch(
        source,
        /import\s*\{[^}]*\bredactSecrets\b[^}]*\}\s*from\s*"\.\/debug-log(?:-format)?\.js"/,
        `src/${file} must import redactSecrets directly from ./secret-redaction.js rather than via barrel re-exports`,
      );
    }
  });

  it("preserves identical redactSecrets re-exports from debug-log-format and debug-log", () => {
    assert.equal(redactFromDebugLogFormat, redactSecrets);
    assert.equal(redactFromDebugLog, redactSecrets);
  });

  it("runs Authorization masking before key-value masking so ApiKey/Token = or : never double-redacts", () => {
    assert.equal(
      redactSecrets(`[Authorization: ApiKey =${sampleSecret}] 401`),
      "[Authorization: ApiKey [REDACTED]] 401",
    );
    assert.equal(
      redactSecrets(`(Authorization: Token :${sampleSecret}) 403`),
      "(Authorization: Token [REDACTED]) 403",
    );
    assert.equal(
      redactSecrets(`Authorization: Bearer client_secret=${sampleSecret}`),
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("masks URL userinfo, Authorization headers, key/value & compound secrets, query params, and bare Bearer/Basic tokens", () => {
    assert.equal(
      redactSecrets(`https://admin:${sampleSecret}@mcp.example.com/sse?api_key=${sampleSecret}&mode=fast`),
      "https://admin:[REDACTED]@mcp.example.com/sse?api_key=[REDACTED]&mode=fast",
    );
    assert.equal(
      redactSecrets(`db_password=${sampleSecret} aws_secret_access_key=${sampleSecret}`),
      "db_password=[REDACTED] aws_secret_access_key=[REDACTED]",
    );
    assert.equal(
      redactSecrets(`upstream rejected Bearer ${sampleSecret} and Basic dXNlcjpwYXNz`),
      "upstream rejected Bearer [REDACTED] and Basic [REDACTED]",
    );
    // Short words after "basic" in prose (< 8 token chars) stay intact.
    assert.equal(redactSecrets("basic auth failed"), "basic auth failed");
  });

  it("handles single, double, and JSON-escaped quotes, interior backslash escapes, and unterminated quotes", () => {
    assert.equal(
      redactSecrets(`{"password":"it\\"s ${sampleSecret}","ok":1}`),
      '{"password":"[REDACTED]","ok":1}',
    );
    assert.equal(
      redactSecrets(`'client_secret': 'it\\'s ${sampleSecret}', next=1`),
      "'client_secret': '[REDACTED]', next=1",
    );
    assert.equal(
      redactSecrets(`{\\"access_token\\":\\"${sampleSecret}\\",\\"ok\\":true}`),
      '{\\"access_token\\":\\"[REDACTED]\\",\\"ok\\":true}',
    );
    assert.equal(
      redactSecrets(`\\'refresh_token\\':\\'${sampleSecret}\\'`),
      "\\'refresh_token\\':\\'[REDACTED]\\'",
    );
    // Unterminated quoted credential masks all remaining characters through end-of-input.
    assert.equal(
      redactSecrets(`{"access_token":"unterminated-${sampleSecret}`),
      '{"access_token":"[REDACTED]"',
    );
  });

  it("masks nested {} and [] structures completely, skipping brackets inside quoted strings and handling unterminated structures", () => {
    assert.equal(
      redactSecrets(`{"token":{"hint":"close } bracket and ] bracket","value":"${sampleSecret}"},"ok":1}`),
      '{"token":[REDACTED],"ok":1}',
    );
    assert.equal(
      redactSecrets(`{"api_key":["first",{"nested":"${sampleSecret}"}],"ok":1}`),
      '{"api_key":[REDACTED],"ok":1}',
    );
    assert.equal(
      redactSecrets(`{"token":{"unterminated":"${sampleSecret}"`),
      '{"token":[REDACTED]',
    );
    assert.equal(
      redactSecrets(`{"api_key":["${sampleSecret}"`),
      '{"api_key":[REDACTED]',
    );
  });

  it("preserves apostrophes and bare ampersands in unquoted values while stopping at &name= query boundaries", () => {
    assert.equal(
      redactSecrets(`https://mcp.example.com/sse?token=ab'cd&rawflag&mode=fast`),
      "https://mcp.example.com/sse?token=[REDACTED]&mode=fast",
    );
    assert.equal(redactSecrets("token="), "token=");
    assert.equal(redactSecrets("?code="), "?code=");
    assert.equal(redactSecrets("Authorization: Bearer "), "Authorization: Bearer ");
  });

  it("keeps post-truncation masks and Authorization scheme prefixes idempotent without sparing non-Authorization prefixes", () => {
    const preserved = [
      "token=[REDACTED…",
      '{"token":"[RED…',
      "'token':'[RED…",
      '{\\"token\\":\\"[RED…',
      "\\'token\\':\\'[RED…",
      "Authorization: Bea…",
      "Authorization: dpop…",
      "token=…",
    ];
    for (const sample of preserved) {
      assert.equal(redactSecrets(sample), sample, `Expected ${sample} to stay unchanged`);
    }

    // `Bea…` after `token=` is NOT an Authorization scheme — it is a truncated secret and must be masked.
    assert.equal(redactSecrets("token=Bea…"), "token=[REDACTED]");
    assert.equal(redactSecrets(`token=[RED${sampleSecret}…`), "token=[REDACTED]");
  });

  it("redacts secrets and strips terminal escapes through startup-auth formatErrorMessage", () => {
    const mcpErr = new McpError(
      `\x1b[31mconnect failed\x1b[0m (https://mcp.example.com/mcp?api_key=${sampleSecret})`,
      "remote",
      "auth",
    );
    assert.equal(
      formatErrorMessage(mcpErr),
      "[remote] connect failed (https://mcp.example.com/mcp?api_key=[REDACTED])",
    );

    const authErr = new Error(
      `AuthRequiredError: \x1b[33mAuthorization: Bearer ${sampleSecret}\x1b[0m`,
    );
    assert.equal(formatErrorMessage(authErr), "Authorization: Bearer [REDACTED]");
  });
});
