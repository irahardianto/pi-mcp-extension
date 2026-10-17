# AGENTS.md — pi-mcp-extension

Instructions for AI coding agents (Pi, Claude Code, OpenCode, Codex, Cursor, Antigravity, Gemini CLI) and human contributors. Keep this file accurate: if you add or rename a `src/` module, change a verification command, or change the release flow, update this file in the same change.

**What this is:** a TypeScript extension for the Pi coding agent that bridges MCP servers (`stdio`, `sse`, `streamable-http`) into Pi tools and `/mcp*` commands, with OAuth 2.1 (PKCE + DCR) for remote servers. Pi loads `src/index.ts` directly as TypeScript. There is no build step, and the npm tarball ships `src/` as-is (relative imports use `.js` specifiers per `Node16` resolution).

## Commands

```bash
npm run typecheck                                    # tsc --noEmit (strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess)
npm test                                             # all suites: node --import tsx/esm --test ./tests/*.test.ts
node --import tsx/esm --test tests/config.test.ts    # one suite
node --import tsx/esm --test --test-name-pattern="collision" tests/tool-bridge.test.ts   # matching tests
npm pack --dry-run                                   # tarball must contain only src/, README.md, LICENSE, package.json
```

Node 22+ (CI runs 22 and 24). A change is done only when typecheck, test, and pack all pass.

## Hard rules

1. **Never write to `stdout`** (`console.log`, `process.stdout`). It belongs to Pi's TUI/RPC stream. User-facing output goes through `ctx.ui.notify(...)` / `ctx.ui.setStatus("pi-mcp", ...)`; use `console.error("[pi-mcp] ...")` only when no UI context exists.
2. **Pushing to `main` is a manual override only.** Always work on a branch and open a PR. Never push to `main`, publish, or tag unless the user explicitly instructs it for that change; every push to `main` can publish to npm (see [Commits & release](#commits--release)). Never run `npm publish` / `npm version`, edit `version` in `package.json`, or hand-write a versioned `CHANGELOG.md` heading.
3. **No silent error swallowing.** No empty `catch {}` or `.catch(() => {})`. Handle expected codes (`ENOENT`, `ESRCH`, `EEXIST`) explicitly; an intentional best-effort teardown ignore needs a `// WHY:` comment.
4. **Never log or surface secrets**: access/refresh tokens, `client_secret`, authorization codes, PKCE verifiers, `Authorization` headers.
5. **No new runtime dependencies without asking.** Runtime deps are only `@modelcontextprotocol/sdk` and `zod`. Pi packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`) and `typebox` are **peer** deps; never move them into `dependencies`, and never import the deprecated `@mariozechner/*` names.
6. **No `any`.** Use `unknown` + narrowing or Zod. Preserve existing `// WHY:` comments; add one whenever you work around an MCP SDK, TypeBox, or Pi quirk.

## Repository map

`src/` is intentionally flat. Don't create folder hierarchies or layer files (`*_impl.ts`, `business.ts`).

| File | Owns |
|---|---|
| `src/index.ts` | Extension entry (default export); `session_start` / `session_shutdown`; connection coordination (`connectRequested`, `connectAttempts`, `authQueue`, startup auth prompts); interactive `authorize()`; `/mcp`, `/mcp:start`, `/mcp:stop`, `/mcp:auth`; `mcp_status` / `mcp_connect` tools |
| `src/server-manager.ts` | Per-server lifecycle (`stopped → starting → ready → failed`), transport creation, retry/backoff, health checks, `onclose` recovery, `roots/list`, stdio child cleanup, `sanitizeStderrLine` |
| `src/tool-bridge.ts` | `tools/list` discovery, JSON Schema → TypeBox conversion, tool naming/hashing/collisions, Pi tool registration and `callTool` |
| `src/config.ts` | Zod schemas, JSONC parsing, global `<agentDir>/mcp.json` + project `.pi/mcp.json` merge (project overrides only what it states; **no `${VAR}` interpolation**), Pi 1.x config aliases |
| `src/oauth-provider.ts` | MCP SDK `OAuthClientProvider`: silent vs. interactive modes, token/DCR/discovery persistence, refresh rotation |
| `src/auth-lock.ts` | Cross-process `<hash>.json.lock` with heartbeat and stale-lock reclaim; injectable `AuthLockDeps` |
| `src/callback-server.ts`, `src/callback-url.ts` | Loopback OAuth callback listener; pure redirect/callback URL validation and headless paste-back parsing |
| `src/auth-challenge.ts` | `WWW-Authenticate` discovery (RFC 9728 `resource_metadata`, `scope`) |
| `src/errors.ts` | `McpError` kinds `config \| connection \| auth \| timeout \| protocol`; `AuthRequiredError`, `AuthLockError`, `AuthCancelledError` |

Tests live in `tests/*.test.ts` (`node:test` + `node:assert/strict`, run through `tsx`). Fixtures: `tests/mock-server.ts`, `tests/helpers/`. Keep tests out of `src/`.

User-facing docs to keep in sync with behavior changes: `README.md` (config, commands, tools), `OAUTH.md` (auth flows), `examples/mcp.json.example` (config schema), `CHANGELOG.md`.

> [!NOTE]
> `index.ts`, `server-manager.ts`, `tool-bridge.ts`, and `oauth-provider.ts` exceed the ~400-line target. Do **not** split them opportunistically inside a fix or feature change; extraction is a planned, separate `refactor:` change. Put substantial new pure logic in a focused module instead of growing these files.

## Architecture

- **Pure core, thin I/O.** Keep policy and transforms as pure functions: state transitions, retry/timeout math, lock staleness, schema conversion, tool naming, URL/argument parsing, config merging. Keep SDK transports, `node:fs`, `node:child_process`, `node:http`, browser launching, and timers in thin adapters.
- **Inject boundaries.** A module that touches the filesystem, clock, PIDs, network, or browser takes an optional deps object with production defaults (pattern: `AuthLockDeps` in `src/auth-lock.ts`), so tests use fakes instead of real sleeps, sockets, or processes.
- **Validate every external input with Zod**: `mcp.json`, stored OAuth state, lock records, DCR/discovery metadata. Never `JSON.parse(x) as T`. Config errors are `McpError(..., "config")` and include the file path.
- **Classify errors.** New user-facing failures use an `McpError` kind (`config | connection | auth | timeout | protocol`) or an auth subclass (`AuthRequiredError`, `AuthLockError`, `AuthCancelledError`), not a bare `Error`, so callers and `mcp_status` can tell them apart.
- **Timeouts and cancellation.** The effective timeout is `server.config.requestTimeoutMs ?? settings.requestTimeoutMs`. Pass `{ timeout, signal }` to SDK calls (`connect`, `ping`, `listTools`, `callTool`) and to OAuth discovery fetches, and check `signal.aborted` between async steps.

## Invariants: don't regress

Each of these was a real bug, and the listed suites guard it. If you touch the area, run those suites first.

**Lifecycle & processes** (`server-manager.test.ts`, `connection-coordination.test.ts`, `management-tools.test.ts`)
- `server.attempt` and `connectAttempts` entries are cleared in `finally` / `_shutdown()` on every path: success, failure, abort, reload.
- stdio: pass the session `cwd` to `StdioClientTransport`, track the child PID as soon as it spawns, and have `_shutdown()` do SIGTERM → bounded wait → SIGKILL, including before retrying a failed handshake.
- Health checks never overlap, each ping is time-bounded, and transport `onclose` triggers recovery for all three transports.
- Decode child `stderr` with `StringDecoder` and pass every line through `sanitizeStderrLine` before storing or displaying it.
- `session_start` / `session_shutdown`, `/mcp*` commands, and management tools are registered even if bootstrap config loading fails or finds no servers, because a later `session_start` in another directory may load a valid `.pi/mcp.json`. On reload, abort in-flight attempts, stop the callback server, call `ToolBridge.updateSettings`, and refresh the roots `cwd`. Root URIs use `pathToFileURL(cwd).href`.

**Security & OAuth** (`oauth-fixes.test.ts`, `auth-lock.test.ts`, `auth-commands.test.ts`, `pi-1x-compat.test.ts`)
- Project trust: never read `<cwd>/.pi/mcp.json` during bootstrap or when `ctx.isProjectTrusted()` is false (`loadConfig` with `includeProjectConfig: false`).
- OAuth state is origin-bound. The state file records `serverUrl` and is rejected on load if it doesn't match the configured URL (`urlsMatch`), so a project server that reuses a global server's name can't receive its tokens. Preserve DCR `token_endpoint_auth_method` and `redirect_uris`.
- Sensitive files (`<hash>.json`, `<hash>.json.lock`) are written `0o600` inside `0o700` directories via temp file + `rename`. Corrupt state for one server must not break `mcp_status` for the others.
- Refresh tokens are single-use. Before invalidating tokens, reload them from disk once in case a peer process already rotated them, and coordinate interactive writes through the auth lock.
- Trigger OAuth only on a genuine HTTP 401 (during `initialize` **and** `tools/list`) or a 403 with `insufficient_scope`. Never substring-match `"401"` in error messages.
- Redirect URLs are loopback `http:`/`https:` with an explicit port. Validate callback `state` on success **and** on `?error=` responses. Only `http:`/`https:` authorization URLs reach the OS browser opener, and unvalidated strings never reach a shell.

**Schema conversion** (`tool-bridge.test.ts`): Pi runs `Value.Convert(schema, args)` before validating.
- In unions, `Type.Null()` must come before `String` / `Number` / `Integer` / `Boolean`, or `null` gets coerced to `""` / `0` / `false`.
- Keep object `properties` when `anyOf` / `oneOf` / `allOf` are present, and emit `{ type: "object", properties: {} }` (not `patternProperties`) for empty objects, because Gemini and OpenAI reject the latter.
- Track `$ref`s on the active resolution path (`seenRefs`) to stop recursive blow-up. Preserve `integer`, `enum`, `const`, tuple `items`, and numeric/string constraints.

**Config validation** (`config.test.ts`): reject bad config at load time, not at connect time.
- `toolPrefix` must match `^[a-zA-Z][a-zA-Z0-9_]*$`.
- `auth` is rejected on `stdio` servers, and `auth.redirectUrl` (including the `callbackUrl` / `callbackPort` aliases) is validated when the config loads.

## Bug-fix workflow

1. **Reproduce:** write a deterministic failing test in `tests/` (fake clocks, transports, or deps; no wall-clock sleeps) before editing `src/`.
2. **Trace:** follow the whole state machine, including abort, reload, and multi-process interleavings, not just the symptom.
3. **Fix at the root**, keeping pure policy separate from I/O.
4. **Verify:** run the new test, the full suite, typecheck, and pack.

Self-review before finishing:
- Are promises, timers, child processes, and abort listeners cleaned up on error, abort, and reload?
- Does anything write to stdout or swallow errors?
- Is external input Zod-validated and are URLs scheme-checked?
- Are credentials origin-bound and written `0o600`?

## Commits & release

Work on a branch and open a PR. Use Conventional Commits; scopes are fine (e.g. `fix(oauth): ...`).

- **Regular PRs are squash-merged**, so **the PR title becomes the commit that decides the release**.
- **Stacked PRs are the exception**: their commits can land on `main` individually, so every commit subject in a stack must be a correct Conventional Commit.

`.github/workflows/publish.yml` runs on every push to `main`, scans **all commit subjects since the last tag**, and publishes automatically:

| Prefix | Release |
|---|---|
| `type!:`, or `BREAKING CHANGE:` in a body | major |
| `feat:` | minor |
| `fix:`, `perf:` | patch |
| anything else (`docs:`, `chore:`, `refactor:`, `test:`, `ci:`, …) | none |

- For `feat` / `fix` / `perf` / breaking changes, add a user-facing entry under `## [Unreleased]` in `CHANGELOG.md`. The workflow stamps the version and date.
- Because the scan covers everything since the last tag, a `docs:` push still publishes if unreleased `fix:` / `feat:` commits are already on `main`.
- The bot creates the `chore: release vX.Y.Z` commit and the tag. Don't create them by hand.
