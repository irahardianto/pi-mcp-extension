/**
 * `<mcp_servers>` disconnected-server `mcp_connect` hint tests (#342).
 *
 * The prompt hands the model a server name to pass to `mcp_connect`, which requires an exact
 * configured-name match. `sanitizeNamespaceText` rewrites ordinary configured names (trimming,
 * secret redaction, 120-character truncation, control stripping), so a sanitized name emitted as
 * a literal argument can never match — the model fails on its first turn.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_SERVERS_SECTION_CHARS,
  renderMcpServersSection,
} from "../src/mcp-servers-prompt.js";
import { resolveServerNamespaceIds } from "../src/tool-namespace.js";

const INTRO = "MCP servers whose tools are not declared to you. Call the tools of `codemode` servers from codemode scripts. Connect `not connected` servers with `mcp_connect` first.";
const EXACT_NAME_HINT = "not connected — check mcp_status for the exact name and call mcp_connect";
const GENERIC_HINT = "not connected — connect with mcp_connect";

const WITH_STATUS = ["read", "codemode", "mcp_connect", "mcp_status"];
const WITHOUT_STATUS = ["read", "codemode", "mcp_connect"];

/** Render one disconnected `codemode` server under the given active tool set. */
function renderDisconnected(name: string, activeTools: readonly string[] | undefined): string {
  const rendered = renderMcpServersSection({
    servers: [{ name, connected: false, exposures: ["codemode"] }],
    activeTools,
  });
  assert.ok(rendered, "a disconnected codemode server must render");
  return rendered;
}

/** The namespace the renderer bullet lists for a single-server prompt. */
function namespaceFor(name: string): string {
  return resolveServerNamespaceIds("mcp", name, [name]).name;
}

/** Full expected section for one disconnected server with the given hint. */
function expectedSection(name: string, hint: string): string {
  return [INTRO, `- ${namespaceFor(name)} (codemode, ${hint})`].join("\n");
}

describe("mcp_servers mcp_connect hints (#342)", () => {
  it("keeps the literal hint for a name sanitization leaves intact", () => {
    assert.equal(
      renderDisconnected("filesystem", WITH_STATUS),
      expectedSection("filesystem", 'not connected — mcp_connect "filesystem"'),
    );
    assert.equal(
      renderDisconnected("filesystem", WITHOUT_STATUS),
      expectedSection("filesystem", 'not connected — mcp_connect "filesystem"'),
    );
  });

  it("never emits a redacted secret-shaped name and points at mcp_status instead", () => {
    const withStatus = renderDisconnected("basic calculator", WITH_STATUS);
    assert.equal(withStatus, expectedSection("basic calculator", EXACT_NAME_HINT));
    assert.ok(!withStatus.includes("[REDACTED]"));
    assert.ok(!withStatus.includes("basic calculator"));

    const withoutStatus = renderDisconnected("basic calculator", WITHOUT_STATUS);
    assert.equal(withoutStatus, expectedSection("basic calculator", GENERIC_HINT));
    assert.ok(!withoutStatus.includes("[REDACTED]"));
    assert.ok(!withoutStatus.includes("basic calculator"));
  });

  it("never emits a redacted key:value name and points at mcp_status instead", () => {
    const withStatus = renderDisconnected("secret:manager", WITH_STATUS);
    assert.equal(withStatus, expectedSection("secret:manager", EXACT_NAME_HINT));
    assert.ok(!withStatus.includes("[REDACTED]"));
    assert.ok(!withStatus.includes("secret:manager"));

    const withoutStatus = renderDisconnected("secret:manager", WITHOUT_STATUS);
    assert.equal(withoutStatus, expectedSection("secret:manager", GENERIC_HINT));
    assert.ok(!withoutStatus.includes("[REDACTED]"));
    assert.ok(!withoutStatus.includes("secret:manager"));
  });

  it("never emits a whitespace-trimmed name and points at mcp_status instead", () => {
    const withStatus = renderDisconnected(" trimmed-server ", WITH_STATUS);
    assert.equal(withStatus, expectedSection(" trimmed-server ", EXACT_NAME_HINT));
    assert.ok(!withStatus.includes('mcp_connect "trimmed-server"'));

    const withoutStatus = renderDisconnected(" trimmed-server ", WITHOUT_STATUS);
    assert.equal(withoutStatus, expectedSection(" trimmed-server ", GENERIC_HINT));
    assert.ok(!withoutStatus.includes('mcp_connect "trimmed-server"'));
  });

  it("never emits a truncated over-length name and points at mcp_status instead", () => {
    const longName = `long-server-${"x".repeat(120)}`;
    const withStatus = renderDisconnected(longName, WITH_STATUS);
    assert.equal(withStatus, expectedSection(longName, EXACT_NAME_HINT));
    assert.ok(withStatus.length <= MAX_SERVERS_SECTION_CHARS);
    assert.ok(!withStatus.includes("\u2026"));

    const withoutStatus = renderDisconnected(longName, WITHOUT_STATUS);
    assert.equal(withoutStatus, expectedSection(longName, GENERIC_HINT));
    assert.ok(!withoutStatus.includes("\u2026"));
  });

  it("never emits a control-only name or its namespace fallback and points at mcp_status instead", () => {
    const withStatus = renderDisconnected("\u0000\u0007", WITH_STATUS);
    assert.equal(withStatus, expectedSection("\u0000\u0007", EXACT_NAME_HINT));
    assert.ok(!withStatus.includes('mcp_connect "mcp___"'));

    const withoutStatus = renderDisconnected("\u0000\u0007", WITHOUT_STATUS);
    assert.equal(withoutStatus, expectedSection("\u0000\u0007", GENERIC_HINT));
    assert.ok(!withoutStatus.includes('mcp_connect "mcp___"'));
  });

  it("keeps the altered-name hint out of the section intro and connected bullets", () => {
    const rendered = renderMcpServersSection({
      servers: [
        { name: "basic calculator", connected: false, exposures: ["codemode"] },
        { name: "filesystem", connected: true, exposures: ["codemode"] },
      ],
      activeTools: WITH_STATUS,
    });
    assert.ok(rendered);
    const bullets = rendered.split("\n").slice(1);
    assert.deepEqual(bullets, [
      `- ${namespaceFor("basic calculator")} (codemode, ${EXACT_NAME_HINT})`,
      `- ${namespaceFor("filesystem")} (codemode)`,
    ]);
  });
});
