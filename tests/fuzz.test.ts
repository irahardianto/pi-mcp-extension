/**
 * Property-based fuzz tests using fast-check.
 *
 * OpenSSF Scorecard detection:
 * Detected by ossf/scorecard `checks/raw/fuzzing.go` (PropertyBasedTypeScript)
 * via file pattern `*.ts` and regex `from "fast-check"`.
 * Citation: https://github.com/ossf/scorecard/blob/main/checks/raw/fuzzing.go
 *
 * How to reproduce / replay a failure:
 * When fast-check detects a counterexample, it outputs the random seed and
 * shrinking path, for example:
 *   Property failed after 12 tests
 *   { seed: -19324523, path: "0:2:1:1", ... }
 *   Counterexample: [...]
 *
 * To replay the exact failing execution:
 *   FAST_CHECK_SEED=-19324523 node --import tsx/esm --test tests/fuzz.test.ts
 *
 * To scale the iteration count locally for deeper fuzzing:
 *   FAST_CHECK_NUM_RUNS=1000 npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import * as Type from "typebox";
import type { TSchema } from "typebox";
import { sanitizeStderrLine, isOAuthUnauthorizedError } from "../src/server-manager.js";
import {
  isSafeAuthorizationUrl,
  parseCallbackUrl,
  CallbackUrlValidationError,
} from "../src/callback-url.js";
import {
  orderUnionMembers,
  convertJsonSchemaToTypebox,
} from "../src/schema-convert.js";
import { buildToolName } from "../src/tool-bridge.js";
import { parseRegisteredServerConfig } from "../src/config.js";
import { stripJsonComments } from "../src/jsonc.js";
import {
  createHeadersFetch,
  discoverManualAuthChallenge,
} from "../src/auth-challenge.js";
import { McpError } from "../src/errors.js";

function parsePositiveInteger(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  const num = Number(val);
  return Number.isInteger(num) && num > 0 ? num : undefined;
}

function parseInteger(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  const num = Number(val);
  return Number.isInteger(num) ? num : undefined;
}

const DEFAULT_NUM_RUNS = 200;
const NUM_RUNS = parsePositiveInteger(process.env.FAST_CHECK_NUM_RUNS) ?? DEFAULT_NUM_RUNS;
const SEED = parseInteger(process.env.FAST_CHECK_SEED);

function testOptions<Ts extends [unknown, ...unknown[]]>(overrideRuns?: number): fc.Parameters<Ts> {
  const options: fc.Parameters<Ts> = { numRuns: overrideRuns ?? NUM_RUNS };
  if (SEED !== undefined) {
    options.seed = SEED;
  }
  return options;
}

// ─── Helpers & Arbitraries ─────────────────────────────────────────────────────

const KIND_SYMBOL = Symbol.for("TypeBox.Kind");

function isNullSchema(m: TSchema): boolean {
  const rec = m as Record<string | symbol, unknown>;
  return (
    Type.Type.IsNull(m) ||
    rec["~kind"] === "Null" ||
    rec[KIND_SYMBOL] === "Null" ||
    rec["type"] === "null"
  );
}

/** Arbitrary covering basic Unicode, ASCII control codes, and raw binary units */
const arbitraryString = fc.oneof(
  fc.string(),
  fc.string({ unit: "binary-ascii" }),
  fc.string({ unit: "grapheme" }),
  fc.string({ unit: "binary" }),
);

/** RFC 7230 header field name: printable ASCII tokens excluding separators */
const arbitraryHeaderKey = fc
  .stringMatching(/^[a-zA-Z0-9!#$%&'*+\-.^_`|~]+$/)
  .filter((k) => k.length > 0 && k.length <= 64 && k !== "__proto__" && k !== "constructor");

/** RFC 7230 header field value: printable ASCII characters */
const arbitraryHeaderValue = fc
  .stringMatching(/^[\t\x20-\x7e]*$/)
  .filter((v) => !v.startsWith(" ") && !v.endsWith(" ") && !v.startsWith("\t") && !v.endsWith("\t"));

// ─── Suite 1: sanitizeStderrLine / sanitizeTerminalText ───────────────────────

describe("fuzz: sanitizeStderrLine", () => {
  it("output never contains C0/C1 control chars or ESC, never splits surrogate pairs, and respects maxLength", () => {
    fc.assert(
      fc.property(arbitraryString, (line) => {
        const sanitized = sanitizeStderrLine(line);
        assert.equal(typeof sanitized, "string");
        assert.ok(
          !/[\x00-\x1f\x7f-\x9f]/.test(sanitized),
          `Sanitized output must not contain C0/C1/ESC control characters: ${JSON.stringify(sanitized)}`,
        );
        assert.ok(sanitized.length <= 500, `Expected length <= 500, got ${sanitized.length}`);
        if (!/[\uD800-\uDFFF]/u.test(line)) {
          assert.ok(
            !/[\uD800-\uDFFF]/u.test(sanitized),
            `Sanitized output must not introduce lone surrogates: ${JSON.stringify(sanitized)}`,
          );
        }
      }),
      testOptions(),
    );
  });

  it("is strictly idempotent on all inputs", () => {
    fc.assert(
      fc.property(arbitraryString, (line) => {
        const first = sanitizeStderrLine(line);
        const second = sanitizeStderrLine(first);
        assert.equal(second, first, "Sanitizing twice must yield the exact same string");
      }),
      testOptions(),
    );
  });

  it("preserves clean single-line text without escapes or control characters within maxLength", () => {
    // Generate single-line printable ASCII strings within the 500-char default limit
    const cleanString = fc.stringMatching(/^[\x20-\x7e]{0,500}$/);

    fc.assert(
      fc.property(cleanString, (clean) => {
        assert.equal(sanitizeStderrLine(clean), clean, "Clean string must not be modified");
      }),
      testOptions(),
    );
  });

  it("strips ANSI escape sequences (CSI, OSC, DCS, ST) and trailing carriage returns", () => {
    const ansiSequence = fc.oneof(
      fc.constant("\x1b[31;1m"),
      fc.constant("\x1b[0m"),
      fc.constant("\x1b[2K"),
      fc.constant("\x1b]0;terminal title\x07"),
      fc.constant("\x1b]8;;https://example.com\x1b\\"),
      fc.constant("\x1bPq\"1;1;100;100\x1b\\"),
      fc.constant("\x1b@"),
      fc.constant("\x1b_"),
      fc.constant("\r"),
    );

    const noisyString = fc
      .array(fc.oneof(fc.string({ unit: "grapheme-ascii" }), ansiSequence), { maxLength: 20 })
      .map((chunks) => chunks.join(""));

    fc.assert(
      fc.property(noisyString, (noisy) => {
        const sanitized = sanitizeStderrLine(noisy);
        assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(sanitized));
        assert.ok(!sanitized.endsWith("\r"));
        assert.equal(sanitizeStderrLine(sanitized), sanitized);
      }),
      testOptions(),
    );
  });
});

// ─── Suite 2: isOAuthUnauthorizedError ────────────────────────────────────────

describe("fuzz: isOAuthUnauthorizedError", () => {
  it("never throws on arbitrary JS values and always returns a boolean", () => {
    fc.assert(
      fc.property(fc.anything(), (val) => {
        const result = isOAuthUnauthorizedError(val);
        assert.equal(typeof result, "boolean");
      }),
      testOptions(),
    );
  });

  it("terminates safely and returns a boolean on cyclic cause graphs", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.option(fc.integer({ min: 100, max: 599 })),
        (message, status) => {
          const obj: Record<string, unknown> = { message };
          if (status !== null) {
            obj["status"] = status;
          }
          // Create cyclic self-reference and 2-node cycle
          obj["cause"] = obj;
          const cycleNode: Record<string, unknown> = { message: "nested", cause: obj };
          obj["nested"] = cycleNode;

          const result = isOAuthUnauthorizedError(obj);
          assert.equal(typeof result, "boolean");
        },
      ),
      testOptions(),
    );
  });

  it("never classifies HTTP status codes 100..599 other than 401 and 403 as unauthorized", () => {
    const non401Status = fc
      .integer({ min: 100, max: 599 })
      .filter((s) => s !== 401 && s !== 403);

    fc.assert(
      fc.property(non401Status, fc.string(), (status, extra) => {
        // Even if message mentions 401 or Unauthorized, an explicit non-401/403 status is rejected
        const errObj = {
          status,
          message: `HTTP 401 Unauthorized ${extra}`,
        };
        assert.equal(
          isOAuthUnauthorizedError(errObj),
          false,
          `HTTP status ${status} must not be classified as OAuth unauthorized`,
        );
      }),
      testOptions(),
    );
  });

  it("classifies HTTP status 401 as unauthorized", () => {
    fc.assert(
      fc.property(fc.string(), (message) => {
        assert.equal(isOAuthUnauthorizedError({ status: 401, message }), true);
        assert.equal(isOAuthUnauthorizedError({ statusCode: 401, message }), true);
        assert.equal(isOAuthUnauthorizedError({ code: 401, message }), true);
      }),
      testOptions(),
    );
  });

  it("classifies HTTP status 403 as unauthorized only with insufficient_scope or trying upscoping", () => {
    fc.assert(
      fc.property(fc.string(), (extra) => {
        const withScope = Object.assign(new Error(`Access denied: insufficient_scope for action ${extra}`), { status: 403 });
        assert.equal(isOAuthUnauthorizedError(withScope), true);

        const withUpscoping = Object.assign(new Error(`forbidden: trying upscoping ${extra}`), { status: 403 });
        assert.equal(isOAuthUnauthorizedError(withUpscoping), true);

        const withoutScope = Object.assign(new Error(`Forbidden: generic access denied ${extra}`), { status: 403 });
        // Unless extra coincidentally contains the keywords, status 403 without scope is false
        const hasKeyword = /\b(insufficient_scope|trying upscoping)\b/i.test(withoutScope.message);
        assert.equal(isOAuthUnauthorizedError(withoutScope), hasKeyword);
      }),
      testOptions(),
    );
  });

  it("never classifies error messages reporting non-401/403 HTTP status as unauthorized", () => {
    const non401Status = fc
      .integer({ min: 100, max: 599 })
      .filter((s) => s !== 401 && s !== 403);

    fc.assert(
      fc.property(non401Status, (status) => {
        // Construct messages that report non-401/403 HTTP status before any 401 substring
        const msg1 = new Error(`HTTP ${status}: server returned error (was trying 401 retry)`);
        assert.equal(isOAuthUnauthorizedError(msg1), false);

        const msg2 = new Error(`status code: ${status} (401 Unauthorized in body)`);
        assert.equal(isOAuthUnauthorizedError(msg2), false);

        const msg3 = new Error(`POSTing to https://api.example.com: ${status} Unauthorized`);
        assert.equal(isOAuthUnauthorizedError(msg3), false);
      }),
      testOptions(),
    );
  });

  it("never classifies McpError with code 'tool' as unauthorized", () => {
    fc.assert(
      fc.property(fc.string(), (msg) => {
        const toolErr = new McpError(`HTTP 401 Unauthorized invalid_token ${msg}`, "srv", "tool");
        assert.equal(
          isOAuthUnauthorizedError(toolErr),
          false,
          "Tool execution errors must never trigger OAuth re-authentication",
        );
      }),
      testOptions(),
    );
  });
});

// ─── Suite 3: isSafeAuthorizationUrl ──────────────────────────────────────────

describe("fuzz: isSafeAuthorizationUrl", () => {
  it("never throws on arbitrary strings and returns a boolean", () => {
    fc.assert(
      fc.property(arbitraryString, (s) => {
        const result = isSafeAuthorizationUrl(s);
        assert.equal(typeof result, "boolean");
      }),
      testOptions(),
    );
  });

  it("returns true only for https: or http: with loopback host", () => {
    fc.assert(
      fc.property(arbitraryString, (s) => {
        const isSafe = isSafeAuthorizationUrl(s);
        if (isSafe) {
          const parsed = new URL(s);
          const isHttps = parsed.protocol === "https:";
          const isLoopbackHttp =
            parsed.protocol === "http:" &&
            (parsed.hostname === "localhost" ||
              parsed.hostname === "127.0.0.1" ||
              parsed.hostname === "::1" ||
              parsed.hostname === "[::1]");
          assert.ok(
            isHttps || isLoopbackHttp,
            `Safe URL must be https or loopback http: ${s}`,
          );
        }
      }),
      testOptions(),
    );
  });

  it("strictly rejects dangerous URI schemes", () => {
    const dangerousScheme = fc.constantFrom(
      "javascript:",
      "file:",
      "data:",
      "blob:",
      "vbscript:",
      "ftp:",
      "ssh:",
      "mailto:",
    );

    fc.assert(
      fc.property(dangerousScheme, fc.string(), (scheme, rest) => {
        const url = `${scheme}//${rest}`;
        assert.equal(isSafeAuthorizationUrl(url), false, `Scheme ${scheme} must be rejected`);
      }),
      testOptions(),
    );
  });

  it("strictly rejects remote http: URLs", () => {
    const remoteDomain = fc.domain();
    fc.assert(
      fc.property(remoteDomain, fc.integer({ min: 1, max: 65535 }), (domain, port) => {
        // Exclude loopback names
        if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(domain)) return;
        const remoteUrl = `http://${domain}:${port}/auth`;
        assert.equal(isSafeAuthorizationUrl(remoteUrl), false, `Remote http URL must be rejected: ${remoteUrl}`);
      }),
      testOptions(),
    );
  });
});

// ─── Suite 4: parseCallbackUrl ────────────────────────────────────────────────

describe("fuzz: parseCallbackUrl", () => {
  it("only throws CallbackUrlValidationError on arbitrary input strings", () => {
    fc.assert(
      fc.property(arbitraryString, (input) => {
        try {
          const res = parseCallbackUrl(input);
          assert.ok(typeof res.state === "string");
        } catch (err) {
          assert.ok(
            err instanceof CallbackUrlValidationError,
            `Expected CallbackUrlValidationError but received: ${String(err)}`,
          );
          assert.ok(
            [
              "invalid_url",
              "wrong_origin",
              "wrong_path",
              "missing_state",
              "invalid_state",
              "missing_code",
            ].includes(err.reason),
            `Unexpected validation reason: ${err.reason}`,
          );
        }
      }),
      testOptions(),
    );
  });

  it("roundtrips valid callback URLs with state and code", () => {
    const validToken = fc.stringMatching(/^[a-zA-Z0-9_\-.]{1,64}$/);

    fc.assert(
      fc.property(
        fc.integer({ min: 1024, max: 65535 }),
        validToken,
        validToken,
        (port, state, code) => {
          const url = `http://127.0.0.1:${port}/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`;
          const parsed = parseCallbackUrl(url);
          assert.equal(parsed.state, state);
          assert.ok("code" in parsed && parsed.code === code);
        },
      ),
      testOptions(),
    );
  });

  it("returns error payload when OAuth error parameter is present", () => {
    const validToken = fc.stringMatching(/^[a-zA-Z0-9_\-.]{1,64}$/);

    fc.assert(
      fc.property(
        fc.integer({ min: 1024, max: 65535 }),
        validToken,
        validToken,
        fc.option(fc.stringMatching(/^[a-zA-Z0-9_\-. ]{1,64}$/)),
        (port, state, error, description) => {
          const params = new URLSearchParams();
          params.set("state", state);
          params.set("error", error);
          if (description !== null) {
            params.set("error_description", description);
          }
          const url = `http://localhost:${port}/callback?${params.toString()}`;
          const parsed = parseCallbackUrl(url);
          assert.equal(parsed.state, state);
          assert.ok("error" in parsed);
          assert.equal(parsed.error, description || error);
        },
      ),
      testOptions(),
    );
  });

  it("rejects callback URLs missing the state parameter", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9]{1,32}$/), (code) => {
        const url = `http://localhost:8080/callback?code=${code}`;
        assert.throws(
          () => parseCallbackUrl(url),
          (err: unknown) => err instanceof CallbackUrlValidationError && err.reason === "missing_state",
        );
      }),
      testOptions(),
    );
  });

  it("enforces expectedState string and predicate matching", () => {
    const validToken = fc.stringMatching(/^[a-zA-Z0-9]{1,32}$/);

    fc.assert(
      fc.property(validToken, validToken, validToken, (state, expectedState, code) => {
        const url = `http://127.0.0.1:4000/callback?state=${state}&code=${code}`;
        if (state === expectedState) {
          const parsed = parseCallbackUrl(url, { expectedState });
          assert.equal(parsed.state, expectedState);
        } else {
          assert.throws(
            () => parseCallbackUrl(url, { expectedState }),
            (err: unknown) => err instanceof CallbackUrlValidationError && err.reason === "invalid_state",
          );
        }
      }),
      testOptions(),
    );
  });

  it("enforces redirectUrl matching: rejects mismatched port/origin with wrong_origin, mismatched path with wrong_path, and accepts matching URLs", () => {
    const validToken = fc.stringMatching(/^[a-zA-Z0-9_\-.]{1,32}$/);
    const validPath = fc.stringMatching(/^\/[a-z0-9_\-/]{1,32}$/);

    fc.assert(
      fc.property(
        fc.integer({ min: 1024, max: 65535 }),
        fc.integer({ min: 1024, max: 65535 }),
        validPath,
        validPath,
        validToken,
        validToken,
        (portExpected, portActual, pathExpected, pathActual, state, code) => {
          const redirectUrl = `http://127.0.0.1:${portExpected}${pathExpected}`;
          const candidateUrl = `http://127.0.0.1:${portActual}${pathActual}?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`;

          if (portExpected !== portActual) {
            assert.throws(
              () => parseCallbackUrl(candidateUrl, { redirectUrl }),
              (err: unknown) =>
                err instanceof CallbackUrlValidationError && err.reason === "wrong_origin",
            );
          } else if (pathExpected !== pathActual) {
            assert.throws(
              () => parseCallbackUrl(candidateUrl, { redirectUrl }),
              (err: unknown) =>
                err instanceof CallbackUrlValidationError && err.reason === "wrong_path",
            );
          } else {
            const parsed = parseCallbackUrl(candidateUrl, { redirectUrl });
            assert.equal(parsed.state, state);
            assert.ok("code" in parsed && parsed.code === code);
          }
        },
      ),
      testOptions(),
    );
  });
});

// ─── Suite 5: orderUnionMembers & convertJsonSchemaToTypebox ──────────────────

describe("fuzz: orderUnionMembers & convertJsonSchemaToTypebox", () => {
  it("orderUnionMembers partitions null schemas strictly before non-null schemas", () => {
    const memberArb = fc.oneof(
      fc.constant(Type.Type.Null()),
      fc.constant(Type.Type.String()),
      fc.constant(Type.Type.Number()),
      fc.constant(Type.Type.Integer()),
      fc.constant(Type.Type.Boolean()),
      fc.constant(Type.Type.Object({})),
      fc.constant(Type.Type.Array(Type.Type.String())),
      fc.constant({ type: "null" }),
    );

    fc.assert(
      fc.property(fc.array(memberArb, { maxLength: 25 }), (members) => {
        const ordered = orderUnionMembers(members);
        assert.equal(ordered.length, members.length, "Length must be preserved");

        let seenNonNull = false;
        for (const m of ordered) {
          if (isNullSchema(m)) {
            assert.ok(!seenNonNull, "Null members must precede all non-null members");
          } else {
            seenNonNull = true;
          }
        }

        // Idempotence
        assert.deepEqual(orderUnionMembers(ordered), ordered, "Must be idempotent");
      }),
      testOptions(),
    );
  });

  it("convertJsonSchemaToTypebox never throws or hangs on arbitrary schema objects", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (schema) => {
        const result = convertJsonSchemaToTypebox(schema);
        assert.equal(typeof result, "object");
        assert.ok(result !== null);
      }),
      testOptions(),
    );
  });

  it("convertJsonSchemaToTypebox breaks recursive and circular $ref cycles safely", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{1,10}$/), (defName) => {
        const schema = {
          $defs: {
            [defName]: {
              type: "object",
              properties: {
                cycle: { $ref: `#/$defs/${defName}` },
                self: { $ref: "#" },
              },
            },
          },
          $ref: `#/$defs/${defName}`,
        };
        const result = convertJsonSchemaToTypebox(schema);
        assert.equal(typeof result, "object");
        assert.ok(result !== null);
      }),
      testOptions(),
    );
  });

  it("convertJsonSchemaToTypebox orders Type.Null() first in nullable multi-type arrays", () => {
    const typesWithNull = fc.constantFrom(
      ["string", "null"],
      ["null", "string"],
      ["number", "null"],
      ["integer", "boolean", "null"],
      ["null", "number", "string"],
    );

    fc.assert(
      fc.property(typesWithNull, (types) => {
        const result = convertJsonSchemaToTypebox({ type: types });
        assert.equal(typeof result, "object");
        const anyResult = result as { anyOf?: TSchema[] };
        assert.ok(Array.isArray(anyResult.anyOf), "Must produce anyOf union");
        assert.ok(anyResult.anyOf.length >= 2);
        assert.ok(
          isNullSchema(anyResult.anyOf[0]!),
          "First union member must be null to prevent Pi Value.Convert coercion",
        );
      }),
      testOptions(),
    );
  });

  it("convertJsonSchemaToTypebox generates clean object without patternProperties for empty objects", () => {
    fc.assert(
      fc.property(fc.constant({ type: "object", properties: {} }), (schema) => {
        const result = convertJsonSchemaToTypebox(schema) as Record<string, unknown>;
        assert.equal(result["type"], "object");
        assert.ok(!("patternProperties" in result), "Empty object must not have patternProperties");
      }),
      testOptions(50),
    );
  });

  it("convertJsonSchemaToTypebox orders Type.Null() first for nullable unions nested in object properties and array items", () => {
    const nullableTypeCombos = fc.constantFrom(
      ["string", "null"],
      ["null", "number"],
      ["integer", "boolean", "null"],
    );
    const propName = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,10}$/);

    fc.assert(
      fc.property(
        propName,
        nullableTypeCombos,
        nullableTypeCombos,
        fc.boolean(),
        (name, objNullableTypes, arrNullableTypes, isRequired) => {
          const schema = {
            type: "object",
            properties: {
              [name]: { type: objNullableTypes },
              itemsList: {
                type: "array",
                items: { type: arrNullableTypes },
              },
            },
            ...(isRequired ? { required: [name] } : {}),
          };

          const result = convertJsonSchemaToTypebox(schema) as {
            properties?: Record<string, { anyOf?: TSchema[] }>;
          };
          assert.ok(result.properties);

          // Check object property
          const propSchema = result.properties[name];
          assert.ok(propSchema);
          assert.ok(Array.isArray(propSchema.anyOf));
          assert.ok(
            isNullSchema(propSchema.anyOf[0]!),
            "Nested object property union must place null first",
          );

          // Check array items
          const arrSchema = result.properties["itemsList"] as unknown as {
            items?: { anyOf?: TSchema[] };
          };
          assert.ok(arrSchema.items);
          assert.ok(Array.isArray(arrSchema.items.anyOf));
          assert.ok(
            isNullSchema(arrSchema.items.anyOf[0]!),
            "Nested array items union must place null first",
          );
        },
      ),
      testOptions(),
    );
  });
});

// ─── Suite 6: buildToolName ───────────────────────────────────────────────────

describe("fuzz: buildToolName", () => {
  it("always returns identifier matching /^[a-zA-Z0-9_]+$/ with length <= 64", () => {
    fc.assert(
      fc.property(
        arbitraryString,
        arbitraryString,
        arbitraryString,
        fc.boolean(),
        (prefix, server, tool, forceHash) => {
          const name = buildToolName(prefix, server, tool, forceHash);
          assert.ok(name.length > 0 && name.length <= 64, `Length ${name.length} must be in [1, 64]`);
          assert.ok(
            /^[a-zA-Z0-9_]+$/.test(name),
            `Tool name "${name}" must match Pi identifier regex`,
          );
          assert.equal(
            buildToolName(prefix, server, tool, forceHash),
            name,
            "Must be deterministic",
          );
        },
      ),
      testOptions(),
    );
  });

  it("forceHash disambiguates names that would otherwise sanitize to identical strings", () => {
    const component = fc.stringMatching(/^[a-zA-Z0-9]{1,20}$/);

    fc.assert(
      fc.property(component, component, (server, tool) => {
        // e.g. "a-b" vs "a_b" sanitize identically to "a_b"
        const nameHyphen = buildToolName("mcp", `${server}-sub`, tool, true);
        const nameUnderscore = buildToolName("mcp", `${server}_sub`, tool, true);
        assert.notEqual(
          nameHyphen,
          nameUnderscore,
          "Distinct raw inputs must produce distinct hashed tool names under forceHash",
        );
      }),
      testOptions(),
    );
  });
});

// ─── Suite 7: stripJsonComments & parseRegisteredServerConfig ─────────────────

describe("fuzz: stripJsonComments & parseRegisteredServerConfig", () => {
  it("stripJsonComments preserves standard JSON unchanged and roundtrips with JSON.parse", () => {
    fc.assert(
      fc.property(fc.json(), (json) => {
        const stripped = stripJsonComments(json);
        assert.deepEqual(JSON.parse(stripped), JSON.parse(json));
      }),
      testOptions(),
    );
  });

  it("stripJsonComments strictly preserves newline counts across arbitrary strings", () => {
    fc.assert(
      fc.property(arbitraryString, (text) => {
        const stripped = stripJsonComments(text);
        const originalLines = text.split("\n").length;
        const strippedLines = stripped.split("\n").length;
        assert.equal(
          strippedLines,
          originalLines,
          "Newline count must be preserved so JSON.parse error line numbers stay accurate",
        );
      }),
      testOptions(),
    );
  });

  it("stripJsonComments preserves string literals containing comment delimiters verbatim", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme-ascii" }), (val) => {
        const withFakeComments = `prefix // not a comment /* still not */ suffix: ${val}`;
        const jsonDoc = JSON.stringify({ key: withFakeComments });
        const stripped = stripJsonComments(jsonDoc);
        const parsed = JSON.parse(stripped) as { key: string };
        assert.equal(parsed.key, withFakeComments);
      }),
      testOptions(),
    );
  });

  it("stripJsonComments leaves unterminated block comments intact", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme-ascii" }), (body) => {
        // Ensure body does not contain block comment terminator
        const safeBody = body.replace(/\*\//g, "");
        const unterminated = `{"a": 1} /* unterminated: ${safeBody}`;
        const stripped = stripJsonComments(unterminated);
        assert.ok(
          stripped.includes("/*"),
          "Unterminated block comment must not be stripped so JSON.parse fails with SyntaxError",
        );
      }),
      testOptions(),
    );
  });

  it("parseRegisteredServerConfig accepts valid server configs and enforces invariants", () => {
    const validStdio = fc.record({
      command: fc.stringMatching(/^[a-zA-Z0-9_\-./]+$/).filter((s) => s.length > 0),
      args: fc.array(fc.stringMatching(/^[a-zA-Z0-9_\-./]+$/)),
      transport: fc.constant("stdio" as const),
    });

    fc.assert(
      fc.property(validStdio, (raw) => {
        const parsed = parseRegisteredServerConfig("test-server", raw);
        assert.equal(parsed.transport, "stdio");
        assert.equal(parsed.command, raw.command);
        assert.equal(parsed.auth, undefined);
        assert.equal(parsed.lifecycle, "eager"); // extension servers default to eager
      }),
      testOptions(),
    );
  });

  it("parseRegisteredServerConfig rejects invalid configs with McpError(code: 'config')", () => {
    // Generate configs violating invariant: stdio with auth, or sse without url
    const invalidConfig = fc.oneof(
      fc.constant({ transport: "stdio", command: "node", auth: { type: "oauth" } }),
      fc.constant({ transport: "sse", command: "node" }), // missing url
      fc.constant({ transport: "streamable-http", command: "node" }), // missing url
      fc.constant({ transport: "stdio", requestTimeoutMs: -1 }), // negative timeout
    );

    fc.assert(
      fc.property(invalidConfig, (raw) => {
        assert.throws(
          () => parseRegisteredServerConfig("bad-server", raw),
          (err: unknown) => {
            assert.ok(err instanceof McpError, "Must throw McpError");
            assert.equal(err.code, "config", "Must have code 'config'");
            return true;
          },
        );
      }),
      testOptions(50),
    );
  });
});

// ─── Suite 8: createHeadersFetch & discoverManualAuthChallenge ────────────────

/**
 * Header field values ignore leading/trailing optional whitespace (RFC 9110 §5.5).
 * `Headers` combines case-insensitive duplicate keys with ", " and trims that
 * trailing space when the combined value is written back, so expectations must
 * be compared after the same normalization instead of as raw strings.
 */
function normalizedHeaderValue(value: string | null): string | null {
  return value === null ? null : value.trim();
}

describe("fuzz: createHeadersFetch & discoverManualAuthChallenge", () => {
  it("createHeadersFetch merges headers with per-request overrides and preserves base headers", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(arbitraryHeaderKey, arbitraryHeaderValue, { maxKeys: 10 }),
        fc.dictionary(arbitraryHeaderKey, arbitraryHeaderValue, { maxKeys: 10 }),
        async (base, req) => {
          let receivedHeaders: Headers | undefined;
          const fakeFetch: typeof fetch = async (_input, init) => {
            receivedHeaders = init?.headers ? new Headers(init.headers) : undefined;
            return new Response("ok", { status: 200 });
          };

          const wrapped = createHeadersFetch(base, fakeFetch);
          await wrapped("https://example.com/mcp", { headers: req });

          if (Object.keys(base).length === 0 && Object.keys(req).length === 0) {
            return;
          }

          assert.ok(receivedHeaders instanceof Headers);
          const headers = receivedHeaders;
          const expectedReq = new Headers(req);
          const expectedBase = new Headers(base);
          // Request headers override collisions
          expectedReq.forEach((v, k) => {
            assert.equal(normalizedHeaderValue(headers.get(k)), normalizedHeaderValue(v));
          });
          // Non-colliding base headers are preserved
          expectedBase.forEach((v, k) => {
            if (!expectedReq.has(k)) {
              assert.equal(normalizedHeaderValue(headers.get(k)), normalizedHeaderValue(v));
            }
          });
        },
      ),
      {
        ...testOptions(),
        examples: [
          [{}, { k: "", K: "" }],
          [{ a: "1", A: "2" }, { b: "3", B: "4" }],
          // Regression: case-colliding request keys combine to ", " and the
          // trailing optional whitespace is trimmed when written back.
          [{ $: "" }, { n: "", N: "" }],
        ],
      },
    );
  });

  it("discoverManualAuthChallenge resolves to empty object for non-401/403 HTTP status", async () => {
    const non401Or403Status = fc
      .integer({ min: 200, max: 599 })
      .filter((s) => s !== 401 && s !== 403 && s !== 405);

    await fc.assert(
      fc.asyncProperty(non401Or403Status, arbitraryHeaderValue, async (status, wwwAuth) => {
        const fakeFetch: typeof fetch = async () => {
          return new Response(null, {
            status,
            headers: { "WWW-Authenticate": wwwAuth },
          });
        };

        const result = await discoverManualAuthChallenge("https://example.com/mcp", {
          fetchFn: fakeFetch,
        });
        assert.deepEqual(result, {});
      }),
      testOptions(),
    );
  });

  it("discoverManualAuthChallenge validates and returns structured challenge fields from WWW-Authenticate", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryHeaderValue,
        fc.constantFrom(401, 403),
        async (wwwAuth, status) => {
          const fakeFetch: typeof fetch = async () => {
            return new Response(null, {
              status,
              headers: { "WWW-Authenticate": wwwAuth },
            });
          };

          const result = await discoverManualAuthChallenge("https://example.com/mcp", {
            fetchFn: fakeFetch,
          });

          // Invariant 1: Result is always an object
          assert.equal(typeof result, "object");
          assert.ok(result !== null);

          // Invariant 2: If resourceMetadataUrl is present, it must be an instance of URL
          if (result.resourceMetadataUrl !== undefined) {
            assert.ok(
              result.resourceMetadataUrl instanceof URL,
              "resourceMetadataUrl must be an instance of URL",
            );
            assert.ok(
              typeof result.resourceMetadataUrl.href === "string" &&
                result.resourceMetadataUrl.href.length > 0,
              "resourceMetadataUrl must have non-empty href",
            );
          }

          // Invariant 3: If scope is present, it must be a non-empty string
          if (result.scope !== undefined) {
            assert.equal(typeof result.scope, "string");
            assert.ok(result.scope.length > 0, "scope must be a non-empty string when present");
          }

          // Invariant 4: On 403, challenge fields are returned only when error is insufficient_scope
          if (status === 403) {
            const hasInsufficientScope = /error=(?:"insufficient_scope"|insufficient_scope)/i.test(wwwAuth);
            if (!hasInsufficientScope) {
              assert.deepEqual(result, {}, "403 without insufficient_scope must resolve to empty object");
            }
          }
        },
      ),
      testOptions(),
    );
  });

  it("discoverManualAuthChallenge correctly parses well-formed RFC 9728 challenges", async () => {
    const validUrlPath = fc.stringMatching(/^\/[a-z0-9_\-/]{1,32}$/);
    const validScope = fc.stringMatching(/^[a-zA-Z0-9_\-. ]{1,32}$/);

    await fc.assert(
      fc.asyncProperty(validUrlPath, validScope, async (path, scope) => {
        const expectedUrl = `https://auth.example.com${path}`;
        const header = `Bearer resource_metadata="${expectedUrl}", scope="${scope}"`;

        const fakeFetch: typeof fetch = async () => {
          return new Response(null, {
            status: 401,
            headers: { "WWW-Authenticate": header },
          });
        };

        const result = await discoverManualAuthChallenge("https://example.com/mcp", {
          fetchFn: fakeFetch,
        });

        assert.ok(result.resourceMetadataUrl instanceof URL);
        assert.equal(result.resourceMetadataUrl.href, expectedUrl);
        assert.equal(result.scope, scope);
      }),
      testOptions(),
    );
  });
});
