# AGENTS.md — pi-mcp-extension

Instructions for AI coding agents (Pi, Claude Code, OpenCode, Codex, Cursor, Antigravity, Gemini CLI) and human contributors. Keep this file accurate: if you add or rename a `src/` module, change a verification command, or change the release flow, update this file in the same change.

**What this is:** a TypeScript extension for the Pi coding agent that bridges MCP servers (`stdio`, `sse`, `streamable-http`) into Pi tools and `/mcp*` commands, with OAuth 2.1 (PKCE + DCR) for remote servers. Pi loads `src/index.ts` directly as TypeScript. There is no build step, and the npm tarball ships `src/` as-is (relative imports use `.js` specifiers per `Node16` resolution).

For a behavioral overview of how the runtime fits together (lifecycle, coordination, config trust, and credential storage), see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The *Repository map* below names every module.

## Commands

```bash
npm run lint                                         # eslint . (type-aware flat config)
npm run typecheck                                    # tsc --noEmit (strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess, unused/return/override/fallthrough)
npm test                                             # all suites: node --import tsx/esm --test ./tests/*.test.ts
npm run test:coverage                                # all suites with coverage floor (95% lines / 85% branches / 83% functions)
node --import tsx/esm --test tests/config.test.ts    # one suite
node --import tsx/esm --test tests/release.test.ts  # release-flow harness (scripts/release.ts)
node --import tsx/esm --test tests/fuzz.test.ts      # property-based fuzz tests (fast-check)
FAST_CHECK_SEED=123456789 node --import tsx/esm --test tests/fuzz.test.ts # replay exact fuzz seed
node --import tsx/esm --test --test-name-pattern="collision" tests/tool-bridge.test.ts   # matching tests
npm pack --dry-run                                   # tarball must contain only src/, README.md, LICENSE, package.json
semgrep --test --metrics=off .semgrep/               # custom Semgrep rules against their fixtures
semgrep scan --metrics=off --config p/typescript --config p/javascript --config p/github-actions --config .semgrep/ --error   # the CI scan
gitleaks git --redact -v                             # secret scan of the full git history (uses .gitleaks.toml)
GITHUB_REPOSITORY=<owner>/<repo> GITHUB_TOKEN=$(gh auth token) RULESET_AUDIT_TOKEN=$(gh auth token) \
  node --import tsx/esm scripts/ruleset-audit.ts      # the ruleset drift audit (.github/workflows/ruleset-audit.yml)
```

Node 22+ (CI runs 22 and 24 on Linux, and 22 on macOS and Windows). A change is done only when lint, typecheck, test, and pack all pass.

Tests must pass on macOS and Windows too. Skip a test only when the behavior is POSIX-only by design (e.g. file modes), and only on that platform: `{ skip: process.platform === "win32" && "WHY: <reason>" }`.

## Hard rules

1. **Never write to `stdout`** (`console.log`, `process.stdout`). It belongs to Pi's TUI/RPC stream. User-facing output goes through `ctx.ui.notify(...)` / `ctx.ui.setStatus("pi-mcp", ...)`; use `console.error("[pi-mcp] ...")` only when no UI context exists. Never write diagnostics to `stderr` while a UI is active either — report them through `reportDiagnostic(...)` in `src/debug-log.ts` (log file, or a Pi notification for user-actionable events), which falls back to `console.error` only when no UI context exists.
2. **Pushing to `main` is a manual override only.** Always work on a branch and open a PR. Never push to `main`, publish, or tag unless the user explicitly instructs it for that change; every push to `main` can publish to npm (see [Commits & release](#commits--release)). Never run `npm publish` / `npm version`, edit `version` in `package.json`, or hand-write a versioned `CHANGELOG.md` heading.
3. **No silent error swallowing.** No empty `catch {}` or `.catch(() => {})`. Handle expected codes (`ENOENT`, `ESRCH`, `EEXIST`) explicitly; an intentional best-effort teardown ignore needs a `// WHY:` comment.
4. **Never log or surface secrets**: access/refresh tokens, `client_secret`, authorization codes, PKCE verifiers, `Authorization` headers. Never commit real credentials, even in fixtures. If `gitleaks` flags a real secret, revoke and rotate it first, then report it privately as described in [`SECURITY.md`](SECURITY.md), never in a public issue or PR.
5. **No new runtime dependencies without asking.** Runtime deps are only `@modelcontextprotocol/sdk` and `zod`. Pi packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`) and `typebox` are **peer** deps; never move them into `dependencies`, and never import the deprecated `@mariozechner/*` names.
6. **No `any`.** Use `unknown` + narrowing or Zod. Preserve existing `// WHY:` comments; add one whenever you work around an MCP SDK, TypeBox, or Pi quirk.

Semgrep and ESLint enforce several of these rules. Suppress a finding only with a justified inline comment (`// nosemgrep: <rule-id> -- WHY: ...`); never dismiss Semgrep alerts in the GitHub UI. CI drops suppressed findings before SARIF upload so in-source comments remain the single source of truth.

## Repository map

`src/` is intentionally flat. Don't create folder hierarchies or layer files (`*_impl.ts`, `business.ts`).

| File | Owns |
|---|---|
| `src/index.ts` | Extension entry (default export); `session_start` / `session_shutdown`; file-level config provenance tracking; `mcp_status` / `mcp_connect` tools |
| `src/register-commands.ts` | Pi `/mcp`, `/mcp:start`, `/mcp:stop`, and `/mcp:auth` slash-command registration (`registerCommands`), including the enriched `/mcp <name>` detail view |
| `src/connection-coordinator.ts` | Connection and auth coordination (`ConnectionCoordinator`: in-flight `connectAttempts`, `authQueue`, eager server starts, session teardown) |
| `src/startup-auth.ts` | Abort-aware auth-queue turn waiter (`waitForQueueTurn`), startup authorization prompt (`promptStartupAuth`, `startupAuthNowOption`, `startupAuthLaterOption`), and error message formatting (`formatErrorMessage`) |
| `src/commands.ts` | Pure `/mcp*` command argument parsing (`parseAuthArguments`), server-name tab completions (`serverNameCompletions`), and extension-registered server config merging (`collectRegisteredServers`, `mergeWithRegisteredServers`) |
| `src/authorize-flow.ts` | Interactive OAuth authorization flow (`authorize`) and browser launcher (`openBrowser`, `browserOpenCommand`) |
| `src/authorize-dialog.ts` | Interactive OAuth callback dialog waiter (`waitForOAuthCallback`, `OAuthPasteOptions`) and dialog option constants (`authRetryOption`, `authPasteOption`, `authCancelOption`) |
| `src/server-manager.ts` | Per-server lifecycle (`stopped → starting → ready → failed`), retry/backoff, health checks, `onclose` recovery, `roots/list`, `sanitizeStderrLine` |
| `src/server-status.ts` | Per-server status snapshot shared by `/mcp <name>` and `mcp_status` (`collectServerStatus`), OAuth credential summary and failure-hint formatting (`formatStatusAuth`, `classifyFailure`, `formatFailureHint`), detail renderer (`formatServerDetail`), and tool row (`toStatusRow`) |
| `src/connect-policy.ts` | Pure connect-failure classification (`classifyConnectFailure`), OAuth 401/403 detection (`isOAuthUnauthorizedError`), and retry backoff schedule (`RETRY_DELAYS_MS`) |
| `src/transport-factory.ts` | SDK transport construction (`stdio`, `streamable-http`, `sse`), environment resolution (`resolveEnv`), silent OAuth provider wiring, and transport-level SDK workarounds (`createTransport`) |
| `src/stdio-process.ts` | Stdio child-process supervision (`isPidAlive`, `ensurePidTerminated`, `instrumentStdioTransport`, injectable `StdioProcessDeps`) and `StringDecoder` stderr line splitting (`createLineSplitter`) |
| `src/tool-bridge.ts` | Tool naming/hashing/collisions (`buildToolName`), MCP content conversion (`convertMcpContent`), Pi tool registration and `callTool` (`ToolBridge`) |
| `src/tool-discovery.ts` | Paginated `tools/list` discovery (`listAllTools`, `McpToolDefinition`) |
| `src/schema-convert.ts` | Pure MCP JSON Schema → TypeBox conversion (`convertJsonSchemaToTypebox`, `orderUnionMembers`) |
| `src/schema-refs.ts` | Pure JSON Pointer (`$ref`) resolution for schema conversion (`resolveRefTarget`, `unescapeJsonPointer`, `stepJsonPointer`) |
| `src/jsonc.ts` | Pure JSONC text utility (`stripJsonComments`): single-pass `//` line and `/* */` block comment removal outside of double-quoted strings, preserving `\n`/`\r` so `JSON.parse` error line numbers stay accurate. Used by `src/config.ts` (runtime `mcp.json`), `scripts/ruleset-audit.ts` (`.github/rulesets/*.json`), and, as the single canonical import path, the test suites (`tests/config.test.ts`, `tests/fuzz.test.ts`, `tests/repo-policy.test.ts` for `.github/rulesets/default-branch.json`) |
| `src/config.ts` | Zod schemas, global `<agentDir>/mcp.json` + project `.pi/mcp.json` merge (project overrides only what it states; **no `${VAR}` interpolation**), Pi 1.x config aliases (including Pi 1.3.0 `enabled: false`, partial project override entries, and stdio `cwd`), and per-server file origins (`loadConfigWithOrigins`, `FileConfigOrigin`) |
| `src/server-provenance.ts` | Pure per-server config provenance (`withExtensionServers`, `lookupServerSource`, `ServerConfigSource`): which file or extension supplied each server, plus the skipped-project-config note |
| `src/oauth-provider.ts` | MCP SDK `OAuthClientProvider`: silent vs. interactive modes, refresh rotation, credential invalidation |
| `src/oauth-status.ts` | Stored OAuth state inspection (`getAuthStatus`), credential reset (`resetAuth`), and best-effort token invalidation (`invalidateStoredTokens`) |
| `src/oauth-state-store.ts` | Persisted OAuth state: Zod schemas (`StoredStateSchema`), URL canonicalization and origin-binding checks (`canonicalServerUrl`, `urlsMatch`, `isResourceCompatibleWithServerUrl`), atomic `0o600` load/save (`loadState`, `saveState`, `loadStoredRedirectUrisSync`) |
| `src/auth-lock.ts` | Cross-process `<hash>.json.lock` with heartbeat and stale-lock reclaim; injectable `AuthLockDeps` |
| `src/auth-lock-policy.ts` | Pure lock-record schema and staleness policy (`LockRecordSchema`, `parseLockRecord`, `isLockStale`, `formatHolderDetails`, `HEARTBEAT_MS`, `STALE_MS`) |
| `src/callback-server.ts`, `src/callback-url.ts` | Instance-scoped `CallbackServer` loopback OAuth callback listener; pure redirect/callback URL validation (`callbackServerConfigFromRedirectUrl`) and headless paste-back parsing |
| `src/auth-challenge.ts` | `WWW-Authenticate` discovery (RFC 9728 `resource_metadata`, `scope`) |
| `src/terminal-text.ts` | Pure terminal/notification text sanitization (`sanitizeTerminalText`): strips ANSI/OSC/DCS/C1 escape sequences and C0/C1 control characters, collapses line breaks, and bounds string length on code-point boundaries |
| `src/debug-log.ts` | Opt-in debug log file writer (`PI_MCP_DEBUG=1` → `<agentDir>/logs/pi-mcp.log`, `0o600`, ~2 MB rotation, `DebugLog`, injectable `DebugLogDeps`) and process-wide diagnostic sink (`reportDiagnostic`, UI routing, headless stderr fallback) |
| `src/debug-log-format.ts` | Pure diagnostic log field allow-listing (`SAFE_FIELD_NAMES`, `sanitizeLogFields`), secret masking (`redactSecrets`, `sanitizeLogText`), error classification (`describeError`), and JSON Lines entry formatting (`buildLogEntry`, `formatLogLine`) |
| `src/errors.ts` | `McpError` kinds `config \| connection \| auth \| timeout \| protocol`; `AuthRequiredError`, `AuthLockError`, `AuthCancelledError` |

Tests live in `tests/*.test.ts` (`node:test` + `node:assert/strict`, run through `tsx`). Fixtures: `tests/mock-server.ts`, `tests/helpers/`. Property-based fuzz tests live in `tests/fuzz.test.ts` (using `fast-check`, detected by OpenSSF Scorecard). Keep tests out of `src/`.

Release tooling lives outside `src/` (it is not shipped to npm and must not depend on the extension's runtime):

| File | Owns |
|---|---|
| `scripts/release.ts` | Release orchestration for `.github/workflows/publish.yml`: bump detection, release commit + tag creation, release-PR orchestration (branch push, PR open/retitle, approval of the PR's pending `pull_request` check runs, squash merge, rejected-merge retry), npm/git divergence repair, `GitPort` / `PullRequestPort` / `NpmPort` adapters |
| `scripts/ruleset-audit.ts` | Ruleset drift audit for `.github/workflows/ruleset-audit.yml`: normalizes a file and the live ruleset to the same comparable form (`normalizeRuleset`, `diffRulesets`), verifies required check contexts against recent check runs (`requiredStatusContexts`, `checkRunNames`, `missingContexts`), and a thin `GitHubApi` fetch client |

`scripts/release.ts` stays fully standalone because the release job runs it on bare Node with no dependency install. `scripts/ruleset-audit.ts` may import the two **pure** `src/` utilities it needs (`jsonc.ts` for the canonical JSONC parser, `terminal-text.ts` for sanitizing API error text) because it runs through `tsx` after `npm ci`; it must not import runtime modules that touch Pi, transports, or stored state. That keeps one JSONC parser and one sanitizer in the repository instead of a drifting copy.

User-facing docs and repository policies to keep in sync with behavior changes: `README.md` (config, commands, tools), `OAUTH.md` (auth flows), `examples/mcp.json.example` (config schema), `CHANGELOG.md`, `SECURITY.md` (security scope and reporting), and `.github/rulesets/*.json` (branch and tag protection rulesets). `.github/CODEOWNERS` lists the security-sensitive paths.

> [!NOTE]
> Several modules currently exceed the ~400-line guideline (`server-manager.ts` is the largest at ~970 lines). Do **not** split an oversized module opportunistically inside a fix or feature change; extraction is a planned, separate `refactor:` change that moves code without changing it. Put substantial new pure logic in a focused module instead of growing an oversized one.

## Architecture

- **Pure core, thin I/O.** Keep policy and transforms as pure functions: state transitions, retry/timeout math, lock staleness, schema conversion, tool naming, URL/argument parsing, config merging. Keep SDK transports, `node:fs`, `node:child_process`, `node:http`, browser launching, and timers in thin adapters.
- **Inject boundaries.** A module that touches the filesystem, clock, PIDs, network, or browser takes an optional deps object with production defaults (pattern: `AuthLockDeps` in `src/auth-lock.ts`), so tests use fakes instead of real sleeps, sockets, or processes.
- **Validate every external input with Zod**: `mcp.json`, stored OAuth state, lock records, DCR/discovery metadata. Never `JSON.parse(x) as T`. Config errors are `McpError(..., "config")` and include the file path.
- **Classify errors.** New user-facing failures use an `McpError` kind (`config | connection | auth | timeout | protocol`) or an auth subclass (`AuthRequiredError`, `AuthLockError`, `AuthCancelledError`), not a bare `Error`, so callers and `mcp_status` can tell them apart.
- **Timeouts and cancellation.** The effective timeout is `server.config.requestTimeoutMs ?? settings.requestTimeoutMs`. Pass `{ timeout, signal }` to SDK calls (`connect`, `ping`, `listTools`, `callTool`) and to OAuth discovery fetches, and check `signal.aborted` between async steps.
- **Function-level structural simplicity.** Keep functions and methods focused (`<= 4` `return` statements per top-level function or method, enforced by `npm run lint` and Qlty's `return_statements` check). Keep control-flow nesting within `<= 4` levels (enforced by `max-depth` and AST checks in `npm run lint`, and Qlty's `nested_control_flow` smell); prefer guard clauses, early returns, and small pure helpers over deep nesting or chained ternaries. When a function grows beyond 4 returns or 4 nesting levels—or defines multiple inline callbacks with early returns—decompose it into named pure helpers or handler functions, or deduplicate repeated loops/checks. Never work around limits by replacing idiomatic guard clauses with a mutable `let result` variable or deep `if / else` nesting.
- **Boolean expression simplicity.** Keep every `&&` / `||` expression in `src/` and `scripts/` at `<= 3` logical operators (`<= 4` operands), matching Qlty's `boolean_logic` smell (threshold 4 → `>= 4` operators reports `Complex binary expression`) and enforced by `pi-mcp/max-boolean-operators` in `npm run lint`. The count covers the whole expression, not one operator kind, so splitting a long chain across nested groups buys no budget. Prefer named module-private predicates, a `readonly RegExp[]` / key list plus `.some(...)`, or a constant lookup table over an inline chain—and keep the `// nosemgrep:` comment attached to any extracted `401` regex literal, because `pi-mcp.no-401-substring` matches the literal itself. `??` chains are deliberate nullish fallbacks and stay governed by the cognitive-complexity limit.
- **Function complexity & decomposition.** Keep every function and method at cognitive and cyclomatic complexity `<= 15`, matching Qlty's `function_complexity` smell (threshold 15) and enforced by the built-in `complexity` rule plus `pi-mcp/max-cognitive-complexity` in `npm run lint`. Cognitive complexity charges `1 + nesting depth` per branch, loop, `catch`, and ternary, adds 1 per contiguous run of identical `&&` / `||` / `??` operators and per direct recursive call, and rolls a nested closure's cost up into its enclosing named function—so moving code into an inline callback or arrow does not hide it. Lift multi-statement callbacks, command/tool `execute` handlers, and loop/retry body steps into named module-private helper functions or private methods rather than nesting closures inside loops or `try` / `catch` blocks. Keep `src/` flat by placing helpers in the same module (or its existing companion policy module) instead of creating new files. Qlty itself skips anonymous functions and default exports, and `eslint.config.mjs` is excluded from Qlty analysis, so size limits there are a review matter rather than a lint failure.

- **Function parameter count.** Keep every function and method in `src/` and `scripts/` at `<= 5` parameters, matching Qlty's `function-parameters` smell (threshold 5) and enforced by `@typescript-eslint/max-params` at `{ max: 5 }` in `npm run lint`, so a 6-parameter signature fails CI before Qlty reports it. Group related arguments into a typed options/context object (`HandshakeParams` in `src/server-manager.ts`, the `options` object of `landReleaseOnMain` in `scripts/release.ts`) instead of growing a positional tail. `max: 5` rather than 4 keeps Pi's 5-argument `ToolDefinition.execute(_toolCallId, params, signal, _onUpdate, _ctx)` callback legal, and `tests/**` turns the rule off because `fast-check`'s `fc.property(...)` combinators pass one callback parameter per arbitrary.

## Invariants: don't regress

Each of these was a real bug, and the listed suites guard it. If you touch the area, run those suites first.

**Lifecycle & processes** (`server-manager.test.ts`, `stdio-process.test.ts`, `connection-coordinator.test.ts`, `connection-coordination.test.ts`, `management-tools.test.ts`)
- `server.attempt` and `connectAttempts` entries are cleared in `finally` / `_shutdown()` on every path: success, failure, abort, reload.
- stdio: pass the session `cwd` — or the per-server `config.cwd` resolved against it by `resolveStdioCwd` (`~` expanded, relative paths resolved, unset keeps the session cwd) — to `StdioClientTransport`, track the child PID as soon as it spawns (`instrumentStdioTransport`), and have `_shutdown()` do SIGTERM → bounded wait → SIGKILL (`ensurePidTerminated`), including before retrying a failed handshake.
- Health checks never overlap, each ping is time-bounded, and transport `onclose` triggers recovery for all three transports.
- Decode child `stderr` with `StringDecoder` (`createLineSplitter`) and pass every line and server-controlled log/error message through `sanitizeTerminalText` (`sanitizeStderrLine`) before storing or displaying it.
- `session_start` / `session_shutdown`, `/mcp*` commands, and management tools are registered even if bootstrap config loading fails or finds no servers, because a later `session_start` in another directory may load a valid `.pi/mcp.json`. On reload, abort in-flight attempts, stop the callback server, call `ToolBridge.updateSettings`, and refresh the roots `cwd`. Root URIs use `pathToFileURL(cwd).href`.

**Security & OAuth** (`oauth-fixes.test.ts`, `auth-lock.test.ts`, `auth-commands.test.ts`, `pi-1x-compat.test.ts`)
- Project trust: never read `<cwd>/.pi/mcp.json` during bootstrap or when `ctx.isProjectTrusted()` is false (`loadConfig` with `includeProjectConfig: false`).
- OAuth state is origin-bound. The state file records `serverUrl` and is rejected on load if it doesn't match the configured URL (`urlsMatch`), so a project server that reuses a global server's name can't receive its tokens. Preserve DCR `token_endpoint_auth_method` and `redirect_uris`.
- OAuth state is also bound to the authorization server: persist and return the SDK's `issuer` on stored tokens and client information unchanged (including in silent mode and peer reloads), never re-bind a stamped client to another issuer, and never write a config-supplied `client_secret` to disk (GHSA-6qxp-vccf-f47h).
- Sensitive files (`<hash>.json`, `<hash>.json.lock`) are written `0o600` inside `0o700` directories via temp file + `rename`. Corrupt state for one server must not break `mcp_status` or `/mcp <name>` for the others: both go through `collectServerStatus`, which reports the backed-up file instead of throwing.
- Refresh tokens are single-use. Before invalidating tokens, reload them from disk once in case a peer process already rotated them, and coordinate interactive writes through the auth lock.
- Trigger OAuth only on a genuine HTTP 401 (during `initialize` **and** `tools/list`) or a 403 with `insufficient_scope`. Never substring-match `"401"` in error messages. The only exception is the anchored message fallback inside `isOAuthUnauthorizedError`, after its structured checks; Semgrep `pi-mcp.no-401-substring` enforces this everywhere else.
- Redirect URLs are loopback `http:`/`https:` with an explicit port. Validate callback `state` on success **and** on `?error=` responses. Only `http:`/`https:` authorization URLs reach the OS browser opener, and unvalidated strings never reach a shell.

**Schema conversion** (`tool-bridge.test.ts`): Pi runs `Value.Convert(schema, args)` before validating.
- In unions, `Type.Null()` must come before `String` / `Number` / `Integer` / `Boolean`, or `null` gets coerced to `""` / `0` / `false`.
- Keep object `properties` when `anyOf` / `oneOf` / `allOf` are present, and emit `{ type: "object", properties: {} }` (not `patternProperties`) for empty objects, because Gemini and OpenAI reject the latter.
- An `allOf` that composes object sub-schemas or `$ref`s to object definitions **must** infer `type: "object"` and flatten `properties` / `required` — recursively through nested `allOf` and chained `$ref`s, cycle-safe — while still carrying the `allOf` members for Intersect semantics. Generators (Pydantic, FastAPI, OpenAPI 3.0) omit `type: "object"` on the wrapper, and a bare `Type.Intersect` has no `properties`: Pi's `normalizeOptionalNulls` then skips the object (coercing optional `null`s into `"null"` / `0` / `false`) and Anthropic's adapter sends an empty `input_schema`. An `allOf` whose members are not object-like stays a bare Intersect.
- Track `$ref`s on the active resolution path (`seenRefs`) to stop recursive blow-up. Preserve `integer`, `enum`, `const`, tuple `items`, and numeric/string constraints.

**Config validation** (`config.test.ts`, `pi-1x-compat.test.ts`): reject bad config at load time, not at connect time.
- `toolPrefix` must match `^[a-zA-Z][a-zA-Z0-9_]*$`.
- `auth` is rejected on `stdio` servers, and `auth.redirectUrl` (including the `callbackUrl` / `callbackPort` aliases) is validated when the config loads.
- A Pi 1.3.0 partial project entry (no `command`, `url`, `type`, or `transport`) is an override of the global entry with that name: it is merged onto the **raw** global entry before validation (global command/URL/headers/auth kept) and may only set `enabled`, `lifecycle`, and Pi's `exposure` / `toolExposure` (the last two accepted and ignored). A project override must never fail the whole config — that tore down every global server on `session_start` — and an unknown name or any other key is a config error naming file and server.
- `enabled: false` normalizes to `lifecycle: "lazy"` even when `lifecycle: "eager"` is also set; a non-boolean `enabled` is rejected at load time.
- `auth.provider` (Pi's `/login` provider token) is rejected with a `config` error rather than silently downgraded to OAuth 2.1 DCR, and `cwd` is accepted only on `stdio` transports.

**Diagnostics** (`debug-log.test.ts`, `server-manager.test.ts`)
- The extension writes to `stderr` only when no UI context exists, and only `warn`/`error` events (plus `info` events explicitly flagged `stderr: true`, e.g. child-server output and the headless OAuth URL fallback); other `info` telemetry is log-file only, so headless stderr output is unchanged from before the sink. While a UI is active, every diagnostic goes through `reportDiagnostic(...)` in `src/debug-log.ts`: the log file when `PI_MCP_DEBUG=1`, a `ctx.ui.notify(...)` for user-actionable events, and nothing otherwise. Semgrep `pi-mcp.no-stderr` keeps direct `console.error` / `process.stderr.write` calls out of every module except `src/debug-log.ts`.
- The log file lives in `<agentDir>/logs/pi-mcp.log` (`0o600` in a `0o700` directory), is rotated to `pi-mcp.log.1` at ~2 MB, and is only created when `PI_MCP_DEBUG=1` is set. File-mode assertions are POSIX-only: skip them on Windows (`fs.stat` there reports `0o666`).
- The logger API takes allow-listed field names only (`SAFE_FIELD_NAMES`); unknown names are dropped, and a final pass masks token-like substrings. Never pass a raw error object, an HTTP body, or a token to it.

## Testing & bug-fix workflow

New functionality, observable behavior changes, and bug fixes **must** add or update deterministic automated tests in `tests/`. Tests must cover observable behavior rather than mirror implementation details; use injected fakes, clocks, or transports instead of wall-clock sleeps. A change that cannot affect runtime behavior (for example, docs-only, CI-only, chore-only, or behavior-preserving refactoring already covered by existing tests) does not need a new test; state the rationale in the PR.

For bug fixes, follow this deterministic regression-test workflow:

1. **Reproduce:** write a deterministic failing test in `tests/` (fake clocks, transports, or deps; no wall-clock sleeps) before editing `src/`.
2. **Trace:** follow the whole state machine, including abort, reload, and multi-process interleavings, not just the symptom.
3. **Fix at the root**, keeping pure policy separate from I/O.
4. **Verify:** run the new test, the full suite, lint, typecheck, and pack.

Self-review before finishing:
- Are promises, timers, child processes, and abort listeners cleaned up on error, abort, and reload?
- Does anything write to stdout or swallow errors?
- Is external input Zod-validated and are URLs scheme-checked?
- Are credentials origin-bound and written `0o600`?
- Does every new or modified function in `src/` stay within the `<= 4` return statement and `<= 4` control-flow nesting bounds via clean helper decomposition (verified by `npm run lint`)?
- Does every new or modified function in `src/` stay within the cognitive and cyclomatic complexity `<= 15` limit (verified by `npm run lint` via `complexity` and `pi-mcp/max-cognitive-complexity`), and does `qlty smells --all` report zero `function_complexity` findings?
- Does every `&&` / `||` expression stay at `<= 3` logical operators (verified by `npm run lint` via `pi-mcp/max-boolean-operators`), and does `qlty smells --all` report zero `boolean_logic` (`Complex binary expression`) findings?

## CI

Workflows live in `.github/workflows/`. The required workflows below run on every PR (`pull_request`, whatever its base branch so each PR in a stack is checked too), on `merge_group` (so every required check is merge-queue-ready), and on pushes to `main`. A release PR needs one more step before those checks exist: it is opened by the release job with `GITHUB_TOKEN`, and GitHub records a `GITHUB_TOKEN` PR's `pull_request` workflows but never executes them (`action_required`, no check runs) — and `GITHUB_TOKEN` may not approve a workflow run. The release flow therefore approves each of those pending runs with the `RELEASE_APPROVE_TOKEN` PAT (a fine-grained token with Actions write access) and waits for exactly the run on the pushed head, so its check runs — the only kind that attach to a PR — satisfy the ruleset's required status checks. (A `workflow_dispatch` run on the same branch never attaches to the PR; the triggers on these workflows are for manual runs.)

| Workflow | Job | What it enforces |
|---|---|---|
| `ci.yml` | `check` (Node 22, 24) | `npm audit signatures`, `npm audit --omit=dev --audit-level=high` (Node 22), lint, typecheck, tests (coverage floor on Node 22; emits `lcov.info` and uploads to Qlty over OIDC on same-repo runs), `npm pack --dry-run` |
| `ci.yml` | `test (macos-latest)`, `test (windows-latest)` | `npm test` on Node 22. Both legs are blocking: Windows became blocking once its runs were reliably green (#137) |
| `workflow-lint.yml` | `workflow-lint` | `actionlint` (syntax, expressions, shellcheck of `run:` scripts) and `zizmor` (Actions security: injection, pinning, permissions, credentials), failing on any finding of low severity or above. Also runs on `workflow_dispatch` (manual runs) |
| `secret-scan.yml` | `gitleaks` | No secrets in the PR's or merge group's commits (pushes to `main`: the pushed range; weekly and on dispatch: full history). Output is redacted |
| `semgrep.yml` | `semgrep` | Semgrep registry packs (`p/typescript`, `p/javascript`, `p/github-actions`) plus the custom rules in `.semgrep/rules/` that encode hard rules 1, 4, 5 and the security invariants above; drops in-source-suppressed findings before SARIF upload |
| `dependency-review.yml` | `dependency-review` | Dependencies added or changed by the PR: no high/critical advisories and no copyleft licenses in runtime scope. Also runs on `workflow_dispatch` (manual runs) |
| `pr-title.yml` | `pr-title` | PR title is a Conventional Commit; `feat` / `fix` / `perf` / `!` titles must change `CHANGELOG.md`; a PR-description line starting with `BREAKING CHANGE:` requires `!` in the title. Also runs on `workflow_dispatch` (manual runs) |
| `ruleset-audit.yml` | `ruleset-audit` | Weekly, on `workflow_dispatch`, and on PRs touching `.github/rulesets/**`: every live ruleset must match its file field for field (`name`, `target`, `enforcement`, `conditions`, `rules` + `parameters`, `bypass_actors`), every file must have a live ruleset and vice versa, and every required check context must still be reported by a recent commit on `main` or a recent PR head. Not a required check (it is not in `REQUIRED_WORKFLOWS`). A PR from a fork can only verify contexts, so it posts a warning annotation saying the live comparison was skipped |

### OpenSSF Scorecard

`scorecard.yml` runs on pushes to `main`, weekly, and on dispatch. It publishes signed results to api.scorecard.dev (the README badge) and uploads SARIF to code scanning. Scorecard alerts are repository-level, so an accepted risk is dismissed in the GitHub UI with a written reason. Semgrep alerts are never dismissed there (see [Hard rules](#hard-rules)).

| Check | How this repo satisfies it | Don't regress |
|---|---|---|
| `Pinned-Dependencies` | Actions are pinned by commit SHA, installs use `npm ci`, downloaded binaries are checksum-verified, and the release job uses Node 24's bundled npm | No `npm install -g`, `npx <pkg>@<ver>`, `pip install`, or `curl \| sh` in workflows |
| `SAST` | Semgrep and zizmor upload SARIF on every PR. Scorecard counts the last 30 PR-merged commits (direct release-bot pushes are excluded) | Never skip the SARIF uploads on same-repo PRs |
| `Fuzzing` | `tests/fuzz.test.ts` imports `fast-check` (Scorecard detects that import) and runs under `npm test` | Keep that import form and the file in `tests/` |
| `Token-Permissions`, `Dangerous-Workflow` | `permissions: {}` / `contents: read` at workflow level, untrusted input only through `env:` | Enforced by zizmor and actionlint |
| `Branch-Protection` | Repository ruleset from `.github/rulesets/default-branch.json`: a pull request with zero required approvals, branches up to date, and the required checks (see below) | Keep the live ruleset identical to the file |
| `Code-Review` | Accepted risk: a solo maintainer can't get approvals, since Scorecard needs a reviewer or merger other than the author. The zero-approval PR requirement does not satisfy its independent-review tier. Dismiss as "won't fix" | Revisit when a second maintainer joins |
| `CII-Best-Practices` | Maintainer action: register and self-certify at [bestpractices.dev](https://www.bestpractices.dev) | n/a |

**Repository rulesets as code.** `.github/rulesets/` contains the declarative sources of truth for branch and tag protections:
- `.github/rulesets/default-branch.json` protects `main`: it blocks deletion, blocks force pushes, requires linear history, requires a pull request with **zero required approvals and no Code Owner review**, requires the branch to be up to date (`strict_required_status_checks_policy: true`), and requires the status checks (`check (22)`, `check (24)`, `test (macos-latest)`, `test (windows-latest)`, `workflow-lint`, `pr-title`, `gitleaks`, `semgrep`, `dependency-review`). Every required workflow also declares a `merge_group` trigger so its check is merge-queue-ready (`pr-title.yml` is a no-op there because title validation already ran on the PR).
  - The PR requirement is what a solo maintainer can live with: approvals stay at zero (nobody can approve their own PR) and Code Owner review stays off, while every change still lands through a reviewed-in-CI pull request. Scorecard's independent-review tier is recorded as an accepted risk above until a second maintainer joins.
  - There are no bypass actors. Required status checks block direct pushes to `main` for everyone — on a user-owned repo the GitHub Actions app can't be a ruleset bypass actor (the API returns 422) — so even the release job lands every release through a PR (see [Commits & release](#commits--release)): it pushes `release/vX.Y.Z`, opens the release PR with `GITHUB_TOKEN` (which records the PR's `pull_request` workflows but never executes them, and may not approve them), approves each of those pending runs with the `RELEASE_APPROVE_TOKEN` PAT, waits for **the run on the pushed head** (an earlier attempt's run is on a different head, and a `workflow_dispatch` run never attaches to a PR at all), and squash-merges. A maintainer who needs an emergency direct push temporarily lifts the ruleset instead of carrying a bypass actor.
  - Because branches must be up to date, a release merge rejected by a concurrent push to `main` is retried on the new tip; nothing is published before the merge lands ([Release ordering](#release-ordering-npm--git)).
- **Merge queue readiness & release-flow interplay (issue #138):** `.github/rulesets/default-branch.json` and the live `default-branch` ruleset (`25409171`) do **not** include `"type": "merge_queue"` while the repository lives under a personal (`User`) account (`irahardianto`), because GitHub Merge Queues are an organization-only feature (`PUT /repos/irahardianto/pi-mcp-extension/rulesets/25409171` rejects `merge_queue` with `HTTP 422: Invalid rule 'merge_queue'`); `strict_required_status_checks_policy: true` + `pull_request` provides up-to-date branch protection instead. All required workflows already declare `merge_group` triggers (enforced by `tests/repo-policy.test.ts`), so `merge_queue` can be added if the repository is transferred to an organization. If `merge_queue` is enabled on an organization-owned repo, either the release actor must be added to `bypass_actors` (so `scripts/release.ts` can still squash-merge directly outside the queue) or `mergeReleasePullRequest` in `scripts/release.ts` must be updated to enqueue the PR (`gh pr merge --auto` / `enqueuePullRequest`) and wait for the queue to land the merge commit before fetching and tagging.
- `.github/rulesets/release-tags.json` protects release tags (`refs/tags/v*`): it blocks deletion, blocks force pushes, and blocks tag mutations, while allowing the maintainer (repository admin) to bypass and allowing `publish.yml` to create new release tags.

`ruleset-audit.yml` (via `scripts/ruleset-audit.ts`) is what keeps the files honest: it fails when any live ruleset field drifts from the file, when a ruleset exists on only one side, or when a required check context is no longer reported by a recent commit (a renamed job would otherwise block every merge to `main`, including releases). Both sides are normalized to the same comparable form first, so whitespace, key order, array order, and API-only fields (`id`, `node_id`, timestamps, `_links`, `source`) never read as drift.

The rulesets API needs repository administration read access, which the workflow `GITHUB_TOKEN` does not have. Create a fine-grained token with **Administration: read** (or a classic token with `repo`) and store it as the `RULESET_AUDIT_TOKEN` secret; the scheduled and dispatched audits fail without it. Pull requests never receive secrets from forks, so those runs skip the live comparison, still verify the check contexts, and post a warning annotation so a green check does not read as "the live rulesets were compared". The scheduled or dispatched run is the authoritative one.

The files must state every parameter the API returns, including its defaults (`do_not_enforce_on_create`, `required_reviewers`, `require_extra_approval_for_unattributed_changes`, …). When the audit reports a new live-only parameter, add it to the file in the same PR that responds to the failure — never silence the audit.

```bash
gh workflow run ruleset-audit.yml                                                                                     # the drift audit (weekly + on demand)
gh api repos/irahardianto/pi-mcp-extension/rulesets                                                                   # list live rulesets (debugging drift by hand)
gh api --method POST repos/irahardianto/pi-mcp-extension/rulesets --input .github/rulesets/default-branch.json        # create branch ruleset
gh api --method PUT repos/irahardianto/pi-mcp-extension/rulesets/<id> --input .github/rulesets/default-branch.json   # update branch ruleset
gh api --method POST repos/irahardianto/pi-mcp-extension/rulesets --input .github/rulesets/release-tags.json         # create tag ruleset
gh api --method PUT repos/irahardianto/pi-mcp-extension/rulesets/<id> --input .github/rulesets/release-tags.json    # update tag ruleset
```

When you edit a workflow:

- Pin every `uses:` to a full 40-character commit SHA with a `# vX.Y.Z` comment. Never use a tag or branch.
- Grant least privilege: `permissions: contents: read` (or `{}`) at the workflow level, widened per job only where a step needs it.
- Check out with `persist-credentials: false`, and give every job a `timeout-minutes`.
- Never interpolate `${{ github.event.* }}`, `${{ inputs.* }}`, or `${{ steps.*.outputs.* }}` into `run:`. Pass them through `env:` and quote `"$VAR"`.
- Run `actionlint` and `uvx zizmor@1.31.1 .github/` (or `pipx run zizmor==1.31.1 .github/`) before pushing; both must be clean.

## Commits & release

Work on a branch and open a PR. Use Conventional Commits; scopes are fine (e.g. `fix(oauth): ...`).

- **Regular PRs are squash-merged**, so **the PR title becomes the commit that decides the release**, and the PR description becomes the commit body. The `pr-title` check enforces both (see [CI](#ci)).
- **Branches must be up to date** with `main` before merging (a `default-branch` ruleset rule). After `main` moves, a PR needs an update or rebase and a fresh check run; a stacked PR has to be retargeted onto `main` once its parent lands.
- **Stacked PRs are the exception**: their commits can land on `main` individually, so every commit subject in a stack must be a correct Conventional Commit.

`.github/workflows/publish.yml` runs on every push to `main`. Its `verify` job repeats the CI checks on Node 22 and 24 with a read-only token; only then does the `release` job (the only job with elevated permissions — `contents: write`, `id-token: write`, `pull-requests: write`, `actions: read`, in the `npm-publish` environment) scan **all commit subjects since the last tag** and release automatically. Releases land on `main` through a pull request, because the ruleset requires one and its required status checks block direct pushes for everyone: the release job pushes `release/vX.Y.Z`, opens `chore: release vX.Y.Z` with `GITHUB_TOKEN`, approves the PR's pending `pull_request` runs with the `RELEASE_APPROVE_TOKEN` PAT (the only runs whose check runs attach to the PR; `GITHUB_TOKEN` may not approve a run), waits for them to pass, and squash-merges. Because a squash merge creates a commit the runner's clone has never seen, the flow fetches `main` again after the merge and verifies `package.json` at that commit before creating the tag. The `chore: release vX.Y.Z` commit and the `vX.Y.Z` tag land on `main` **before** the package is published:

| Prefix | Release |
|---|---|
| `type!:`, or `BREAKING CHANGE:` in a body | major |
| `feat:` | minor |
| `fix:`, `perf:` | patch |
| anything else (`docs:`, `chore:`, `refactor:`, `test:`, `ci:`, …) | none |

- For `feat` / `fix` / `perf` / breaking changes, add a user-facing entry under `## [Unreleased]` in `CHANGELOG.md`. The workflow stamps the version and date.
- For `feat:` (minor) and `type!:` / `BREAKING CHANGE:` (major) changes, update the Supported Versions table in `SECURITY.md` in the same PR: the new minor line becomes `:white_check_mark:` and the line before it becomes `:x:`. The release flow bumps `package.json` and `CHANGELOG.md` on its own, but it never edits `SECURITY.md`, so a missed update leaves the security policy pointing users at an unsupported release (and at the wrong BadgeApp `vulnerability_report_process` evidence).
- Because the scan covers everything since the last tag, a `docs:` push still publishes if unreleased `fix:` / `feat:` commits are already on `main`.
- The bot creates the `chore: release vX.Y.Z` commit and the tag (through the release PR). Don't create them by hand. A maintainer may squash-merge a stuck release PR by hand — the next run detects the landed release commit and repairs the missing tag or publish.
- Dependabot PRs are titled `chore(deps): ...`, `chore(deps-dev): ...`, or `ci(deps): ...`, so they don't release. When a runtime bump must raise the minimum version for users (e.g. a security floor), retitle it `fix(deps): ...` and add a `CHANGELOG.md` entry.
- Releases never overlap (`concurrency: publish`) and are never cancelled mid-flight. The release job runs on Node 24 and uses its bundled npm (>= 11.5.1, verified fail-closed without downloads) for OIDC Trusted Publishing; it never runs `npm ci` or `npm install`, so no install script runs with the write token.
- Maintainers can rehearse a release with `gh workflow run publish.yml -f dry_run=true`: it runs `npm publish --dry-run` and never commits, tags, or pushes (with no release-worthy commits it rehearses a patch). A real manual release (`dry_run=false`) is only allowed from `main`.

### Release ordering (npm ↔ git)

The release flow lives in `scripts/release.ts` and runs on Node's built-in type stripping (`node scripts/release.ts`), so the release job never installs dependencies. Its order is the point of #82:

1. **Land first.** The `chore: release vX.Y.Z` commit lands on `main` through the release PR (`release/vX.Y.Z` + the PR's approved `pull_request` check runs + squash merge), the runner fetches the squash-merge commit (its clone has never seen it) and pushes the `vX.Y.Z` tag at that commit, and only then is the package published to npm. If `main` moves while the release runs, the merge is rejected — non-fast-forward, or a stale branch under the ruleset's required-up-to-date policy — and because nothing was published yet, the release is retried on the new `main` tip (the release commit is recreated there, and the retry approves and waits only for the `pull_request` runs its own push recorded on the new head) instead of leaving npm and git out of sync. The published tarball is always exactly the tree that landed, so the release always ships the current `main`, whose commits each passed the `pull_request` CI of their own PR.
2. **Never publish without a tag.** A version reaches npm only after its commit *and* its tag are on `main`. A rejected merge therefore leaves npm untouched; the next run repairs the state.
3. **Self-healing.** Each run first reconciles npm and git: a version npm holds without a git tag gets its release commit and tag recreated (through a release PR), and a tagged version npm never received gets published. A failed publish, a failed tag push, or a failed required check on the release PR is therefore repaired by the next run instead of stalling the release forever.
4. **Bump rules are unchanged** (see the table above).

`tests/release.test.ts` is the harness for this: it drives the real git adapter against a throwaway repository with fake pull-request and registry ports, and covers the race (`main` moving mid-release, rejected merge), the "merge rejected" and "required checks failed" cases (nothing is published), the two repair cases, and the dry-run rehearsal.
