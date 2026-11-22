import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { authArgumentCompletions, parseAuthArguments, serverNameCompletions } from "../src/commands.js";
import extension from "../src/index.js";
import { createMockExtension } from "./helpers/mock-extension.js";

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

describe("authArgumentCompletions", () => {
  const oauthServer = {
    state: "stopped",
    config: { transport: "streamable-http", lifecycle: "lazy", auth: { type: "oauth" } },
  };
  const plainServer = { state: "stopped", config: { transport: "stdio", lifecycle: "lazy" } };

  it("keeps ordinary OAuth completions and supports appending a trailing reset", () => {
    const servers = [{ ...oauthServer, name: "oauth server" }, { ...plainServer, name: "oauth-local" }];
    const [item] = authArgumentCompletions("oa", servers) ?? [];
    assert.deepStrictEqual(item, {
      value: "oauth server",
      label: "oauth server",
      description: "stopped · streamable-http · lazy · OAuth",
    });
    assert.deepStrictEqual(parseAuthArguments(`${item.value} --reset`, servers.map(({ name }) => name)), {
      name: "oauth server",
      reset: true,
    });
    assert.strictEqual(authArgumentCompletions("--res", servers), null);
    assert.strictEqual(authArgumentCompletions("--reset oauth-local", servers), null);
    assert.strictEqual(authArgumentCompletions("--reset ", [servers[1]!]), null);
  });

  it("keeps completions for literal server names that look like reset flags", () => {
    const servers = ["--reset", "--resetfoo", "--reset oauth server", "oauth server"].map((name) => ({ ...oauthServer, name }));
    assert.deepStrictEqual(authArgumentCompletions("--res", servers)?.map(({ value }) => value), [
      "--reset", "--reset oauth server", "--resetfoo",
    ]);
    assert.deepStrictEqual(authArgumentCompletions("--reset oa", servers)?.map(({ value, label }) => ({ value, label })), [
      { value: "--reset oauth server", label: "--reset oauth server" },
    ]);
    assert.deepStrictEqual(authArgumentCompletions("--reset\t oa", servers)?.map(({ value, label }) => ({ value, label })), [
      { value: "--reset\t oauth server", label: "oauth server" },
    ]);
  });

  it("omits reset suggestions when the parser would select a different server or drop the reset", () => {
    const servers = [
      { ...oauthServer, name: "oauth server" },
      { ...plainServer, name: "--reset oauth server" },
      { ...oauthServer, name: "release --reset" },
    ];
    assert.strictEqual(authArgumentCompletions("--reset oa", servers), null);
    assert.strictEqual(authArgumentCompletions("--reset rel", servers), null);
  });
});

it("completes a leading --reset through the registered command and Pi autocomplete", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-auth-completions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "mcp.json");
  const mcpServers = {
    "oauth server": { type: "streamable-http", url: "http://127.0.0.1:1/mcp", auth: { type: "oauth" } },
    "oauth-lookalike": { type: "stdio", command: "unused-test-command" },
  };
  await writeFile(configPath, JSON.stringify({ mcpServers }));
  const mock = createMockExtension();
  await extension(mock.api, { bootstrapCwd: dir, globalConfigPath: configPath, authStorageDir: join(dir, "auth") });
  const { getArgumentCompletions } = mock.commands.get("mcp:auth");
  assert.ok(getArgumentCompletions);
  const provider = new CombinedAutocompleteProvider([{ name: "mcp:auth", getArgumentCompletions }], dir);

  for (const input of ["/mcp:auth --reset ", "/mcp:auth --reset oa", "/mcp:auth   --reset oa"]) {
    const suggestions = await provider.getSuggestions([input], 0, input.length, { signal: t.signal });
    assert.ok(suggestions, `Expected OAuth server completions for ${JSON.stringify(input)}`);
    assert.deepStrictEqual(suggestions.items.map(({ value, label }) => ({ value, label })), [
      { value: "--reset oauth server", label: "oauth server" },
    ]);
    const [item] = suggestions.items;
    assert.ok(item);
    const { lines } = provider.applyCompletion([input], 0, input.length, item, suggestions.prefix);
    assert.deepStrictEqual(lines, ["/mcp:auth --reset oauth server"]);
    assert.deepStrictEqual(parseAuthArguments(lines[0]?.slice("/mcp:auth ".length), Object.keys(mcpServers)), {
      name: "oauth server",
      reset: true,
    });
  }
});
