import { describe, it } from "node:test";
import assert from "node:assert";
import { serverNameCompletions } from "../src/index.js";

describe("serverNameCompletions", () => {
  const servers = [
    {
      name: "infotag-mcp-staging",
      state: "ready",
      config: {
        transport: "streamable-http",
        lifecycle: "lazy",
        auth: { type: "oauth" },
      },
    },
    {
      name: "filesystem",
      state: "ready",
      config: {
        transport: "stdio",
        lifecycle: "eager",
      },
    },
    {
      name: "infotag-mcp-prod",
      state: "stopped",
      config: {
        transport: "streamable-http",
        lifecycle: "lazy",
        auth: { type: "oauth" },
      },
    },
    {
      name: "team server",
      state: "stopped",
      config: {
        transport: "sse",
        lifecycle: "lazy",
      },
    },
  ];

  it("completes configured server names by prefix in alphabetical order", () => {
    const completions = serverNameCompletions("info", servers);

    assert.deepStrictEqual(
      completions?.map((item) => item.value),
      ["infotag-mcp-prod", "infotag-mcp-staging"],
    );
  });

  it("includes status, transport, lifecycle, and auth in descriptions", () => {
    const completions = serverNameCompletions("infotag-mcp-prod", servers);

    assert.deepStrictEqual(completions?.[0], {
      value: "infotag-mcp-prod",
      label: "infotag-mcp-prod",
      description: "stopped · streamable-http · lazy · OAuth",
    });
  });

  it("omits the auth marker for servers without OAuth", () => {
    const completions = serverNameCompletions("filesystem", servers);

    assert.strictEqual(completions?.[0]?.description, "ready · stdio · eager");
  });

  it("restricts completions to OAuth servers when requested", () => {
    const completions = serverNameCompletions("", servers, { authOnly: true });

    assert.deepStrictEqual(
      completions?.map((item) => item.value),
      ["infotag-mcp-prod", "infotag-mcp-staging"],
    );
  });

  it("supports server names and prefixes containing spaces", () => {
    assert.strictEqual(serverNameCompletions("team s", servers)?.[0]?.value, "team server");
  });

  it("ignores leading argument whitespace", () => {
    assert.strictEqual(serverNameCompletions("  file", servers)?.[0]?.value, "filesystem");
  });

  it("returns null for an empty server list or no match", () => {
    assert.strictEqual(serverNameCompletions("", []), null);
    assert.strictEqual(serverNameCompletions("missing", servers), null);
  });
});
