# AGENTS.md — pi-mcp-extension

Instructions for AI coding agents (Pi, Claude Code, OpenCode, Codex, Cursor, Antigravity, Gemini CLI) and human contributors. Keep this file accurate: if you add or rename a `src/` module, change a verification command, or change the release flow, update this file in the same change.

**What this is:** a TypeScript extension for the Pi coding agent that bridges MCP servers (`stdio`, `sse`, `streamable-http`) into Pi tools and `/mcp*` commands, with OAuth 2.1 (PKCE + DCR) for remote servers. Pi loads `src/index.ts` directly as TypeScript. There is no build step, and the npm tarball ships `src/` as-is (relative imports use `.js` specifiers per `Node16` resolution).

## Commands

```bash
npm run lint                                         # eslint . (type-aware flat config)
npm run typecheck                                    # tsc --noEmit (strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess, unused/return/override/fallthrough)
npm test                                             # all suites: node --import tsx/esm --test ./tests/*.test.ts
npm run test:coverage                                # all suites with coverage floor (95% lines / 85% branches / 83% functions)
node --import tsx/esm --test tests/config.test.ts    # one suite
node --import tsx/esm --test tests/fuzz.test.ts      # property-based fuzz tests (fast-check)
FAST_CHECK_SEED=123456789 node --import tsx/esm --test tests/fuzz.test.ts # replay exact fuzz seed
node --import tsx/esm --test --test-name-pattern="collision" tests/tool-bridge.test.ts   # matching tests
npm pack --dry-run                                   # tarball must contain only src/, README.md, LICENSE, package.json
semgrep --test --metrics=off .semgrep/               # custom Semgrep rules against their fixtures
semgrep scan --metrics=off --config p/typescript --config p/javascript --config p/github-actions --config .semgrep/ --error   # the CI scan
gitleaks git --redact -v                             # secret scan of the full git history (uses .gitleaks.toml)
```

Node 22+ (CI runs 22 and 24 on Linux, and 22 on macOS and Windows). A change is done only when lint, typecheck, test, and pack all pass.

Tests must pass on macOS and Windows too. Skip a test only when the behavior is POSIX-only by design (e.g. file modes), and only on that platform: `{ skip: process.platform === "win32" && "WHY: <reason>" }`.

## Hard rules

1. **Never write to `stdout`** (`console.log`, `process.stdout`). It belongs to Pi's TUI/RPC stream. User-facing output goes through `ctx.ui.notify(...)` / `ctx.ui.setStatus("pi-mcp", ...)`; use `console.error("[pi-mcp] ...")` only when no UI context exists.
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
| `src/index.ts` | Extension entry (default export); `session_start` / `session_shutdown`; connection coordination (`connectRequested`, `connectAttempts`, `authQueue`, startup auth prompts); interactive `authorize()`; `/mcp`, `/mcp:start`, `/mcp:stop`, `/mcp:auth`; `mcp_status` / `mcp_connect` tools |
| `src/commands.ts` | Pure `/mcp*` command argument parsing (`parseAuthArguments`), server-name tab completions (`serverNameCompletions`), and extension-registered server config merging (`collectRegisteredServers`, `mergeWithRegisteredServers`) |
| `src/server-manager.ts` | Per-server lifecycle (`stopped → starting → ready → failed`), pure connect-failure classification (`classifyConnectFailure`), retry/backoff, health checks, `onclose` recovery, `roots/list`, `sanitizeStderrLine` |
| `src/transport-factory.ts` | SDK transport construction (`stdio`, `streamable-http`, `sse`), environment resolution (`resolveEnv`), silent OAuth provider wiring, and transport-level SDK workarounds (`createTransport`) |
| `src/stdio-process.ts` | Stdio child-process supervision (`isPidAlive`, `ensurePidTerminated`, `instrumentStdioTransport`, injectable `StdioProcessDeps`) and `StringDecoder` stderr line splitting (`createLineSplitter`) |
| `src/tool-bridge.ts` | `tools/list` discovery, tool naming/hashing/collisions, Pi tool registration and `callTool` |
| `src/schema-convert.ts` | Pure MCP JSON Schema → TypeBox conversion (`convertJsonSchemaToTypebox`, `orderUnionMembers`, `resolveRefTarget`) |
| `src/config.ts` | Zod schemas, JSONC parsing, global `<agentDir>/mcp.json` + project `.pi/mcp.json` merge (project overrides only what it states; **no `${VAR}` interpolation**), Pi 1.x config aliases |
| `src/oauth-provider.ts` | MCP SDK `OAuthClientProvider`: silent vs. interactive modes, refresh rotation, credential invalidation |
| `src/oauth-state-store.ts` | Persisted OAuth state: Zod schemas (`StoredStateSchema`), URL canonicalization and origin-binding checks (`canonicalServerUrl`, `urlsMatch`, `isResourceCompatibleWithServerUrl`), atomic `0o600` load/save (`loadState`, `saveState`) |
| `src/auth-lock.ts` | Cross-process `<hash>.json.lock` with heartbeat and stale-lock reclaim; injectable `AuthLockDeps` |
| `src/callback-server.ts`, `src/callback-url.ts` | Instance-scoped `CallbackServer` loopback OAuth callback listener; pure redirect/callback URL validation (`callbackServerConfigFromRedirectUrl`) and headless paste-back parsing |
| `src/auth-challenge.ts` | `WWW-Authenticate` discovery (RFC 9728 `resource_metadata`, `scope`) |
| `src/terminal-text.ts` | Pure terminal/notification text sanitization (`sanitizeTerminalText`): strips ANSI/OSC/DCS/C1 escape sequences and C0/C1 control characters, collapses line breaks, and bounds string length on code-point boundaries |
| `src/errors.ts` | `McpError` kinds `config \| connection \| auth \| timeout \| protocol`; `AuthRequiredError`, `AuthLockError`, `AuthCancelledError` |

Tests live in `tests/*.test.ts` (`node:test` + `node:assert/strict`, run through `tsx`). Fixtures: `tests/mock-server.ts`, `tests/helpers/`. Property-based fuzz tests live in `tests/fuzz.test.ts` (using `fast-check`, detected by OpenSSF Scorecard). Keep tests out of `src/`.

User-facing docs and repository policies to keep in sync with behavior changes: `README.md` (config, commands, tools), `OAUTH.md` (auth flows), `examples/mcp.json.example` (config schema), `CHANGELOG.md`, `SECURITY.md` (security scope and reporting), and `.github/rulesets/default-branch.json` (branch protection ruleset). `.github/CODEOWNERS` lists the security-sensitive paths.

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

**Lifecycle & processes** (`server-manager.test.ts`, `stdio-process.test.ts`, `connection-coordination.test.ts`, `management-tools.test.ts`)
- `server.attempt` and `connectAttempts` entries are cleared in `finally` / `_shutdown()` on every path: success, failure, abort, reload.
- stdio: pass the session `cwd` to `StdioClientTransport`, track the child PID as soon as it spawns (`instrumentStdioTransport`), and have `_shutdown()` do SIGTERM → bounded wait → SIGKILL (`ensurePidTerminated`), including before retrying a failed handshake.
- Health checks never overlap, each ping is time-bounded, and transport `onclose` triggers recovery for all three transports.
- Decode child `stderr` with `StringDecoder` (`createLineSplitter`) and pass every line and server-controlled log/error message through `sanitizeTerminalText` (`sanitizeStderrLine`) before storing or displaying it.
- `session_start` / `session_shutdown`, `/mcp*` commands, and management tools are registered even if bootstrap config loading fails or finds no servers, because a later `session_start` in another directory may load a valid `.pi/mcp.json`. On reload, abort in-flight attempts, stop the callback server, call `ToolBridge.updateSettings`, and refresh the roots `cwd`. Root URIs use `pathToFileURL(cwd).href`.

**Security & OAuth** (`oauth-fixes.test.ts`, `auth-lock.test.ts`, `auth-commands.test.ts`, `pi-1x-compat.test.ts`)
- Project trust: never read `<cwd>/.pi/mcp.json` during bootstrap or when `ctx.isProjectTrusted()` is false (`loadConfig` with `includeProjectConfig: false`).
- OAuth state is origin-bound. The state file records `serverUrl` and is rejected on load if it doesn't match the configured URL (`urlsMatch`), so a project server that reuses a global server's name can't receive its tokens. Preserve DCR `token_endpoint_auth_method` and `redirect_uris`.
- OAuth state is also bound to the authorization server: persist and return the SDK's `issuer` on stored tokens and client information unchanged (including in silent mode and peer reloads), never re-bind a stamped client to another issuer, and never write a config-supplied `client_secret` to disk (GHSA-6qxp-vccf-f47h).
- Sensitive files (`<hash>.json`, `<hash>.json.lock`) are written `0o600` inside `0o700` directories via temp file + `rename`. Corrupt state for one server must not break `mcp_status` for the others.
- Refresh tokens are single-use. Before invalidating tokens, reload them from disk once in case a peer process already rotated them, and coordinate interactive writes through the auth lock.
- Trigger OAuth only on a genuine HTTP 401 (during `initialize` **and** `tools/list`) or a 403 with `insufficient_scope`. Never substring-match `"401"` in error messages. The only exception is the anchored message fallback inside `isOAuthUnauthorizedError`, after its structured checks; Semgrep `pi-mcp.no-401-substring` enforces this everywhere else.
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
4. **Verify:** run the new test, the full suite, lint, typecheck, and pack.

Self-review before finishing:
- Are promises, timers, child processes, and abort listeners cleaned up on error, abort, and reload?
- Does anything write to stdout or swallow errors?
- Is external input Zod-validated and are URLs scheme-checked?
- Are credentials origin-bound and written `0o600`?

## CI

Workflows live in `.github/workflows/`. The checks below run on every PR, whatever its base branch (so each PR in a stack is checked too), and on every push to `main`.

| Workflow | Job | What it enforces |
|---|---|---|
| `ci.yml` | `check` (Node 22, 24) | `npm audit signatures`, `npm audit --omit=dev --audit-level=high` (Node 22), lint, typecheck, tests (coverage floor on Node 22), `npm pack --dry-run` |
| `ci.yml` | `test (macos-latest)`, `test (windows-latest)` | `npm test` on Node 22. macOS is blocking; Windows is non-blocking (`continue-on-error`) until it's proven green (#54) |
| `workflow-lint.yml` | `workflow-lint` | `actionlint` (syntax, expressions, shellcheck of `run:` scripts) and `zizmor` (Actions security: injection, pinning, permissions, credentials), failing on any finding of low severity or above |
| `secret-scan.yml` | `gitleaks` | No secrets in the PR's commits (pushes to `main`: the pushed range; weekly and on dispatch: full history). Output is redacted |
| `semgrep.yml` | `semgrep` | Semgrep registry packs (`p/typescript`, `p/javascript`, `p/github-actions`) plus the custom rules in `.semgrep/rules/` that encode hard rules 1, 4, 5 and the security invariants above; drops in-source-suppressed findings before SARIF upload |
| `dependency-review.yml` | `dependency-review` | Dependencies added or changed by the PR: no high/critical advisories and no copyleft licenses in runtime scope |
| `pr-title.yml` | `pr-title` | PR title is a Conventional Commit; `feat` / `fix` / `perf` / `!` titles must change `CHANGELOG.md`; a PR-description line starting with `BREAKING CHANGE:` requires `!` in the title |

### OpenSSF Scorecard

`scorecard.yml` runs on pushes to `main`, weekly, and on dispatch. It publishes signed results to api.scorecard.dev (the README badge) and uploads SARIF to code scanning. Scorecard alerts are repository-level, so an accepted risk is dismissed in the GitHub UI with a written reason. Semgrep alerts are never dismissed there (see [Hard rules](#hard-rules)).

| Check | How this repo satisfies it | Don't regress |
|---|---|---|
| `Pinned-Dependencies` | Actions are pinned by commit SHA, installs use `npm ci`, downloaded binaries are checksum-verified, and the release job uses Node 24's bundled npm | No `npm install -g`, `npx <pkg>@<ver>`, `pip install`, or `curl \| sh` in workflows |
| `SAST` | Semgrep and zizmor upload SARIF on every PR. Scorecard counts the last 30 PR-merged commits (direct release-bot pushes are excluded), so older pre-Semgrep commits age out | Never skip the SARIF uploads on same-repo PRs |
| `Fuzzing` | `tests/fuzz.test.ts` imports `fast-check` (Scorecard detects that import) and runs under `npm test` | Keep that import form and the file in `tests/` |
| `Token-Permissions`, `Dangerous-Workflow` | `permissions: {}` / `contents: read` at workflow level, untrusted input only through `env:` | Enforced by zizmor and actionlint |
| `Branch-Protection` | Repository ruleset from `.github/rulesets/default-branch.json` (see below) | Keep the live ruleset identical to the file |
| `Code-Review` | Accepted risk: a solo maintainer can't get approvals, since Scorecard needs a reviewer or merger other than the author. Dismiss as "won't fix" | Revisit when a second maintainer joins |
| `CII-Best-Practices` | Maintainer action: register and self-certify at [bestpractices.dev](https://www.bestpractices.dev) | n/a |

**Branch ruleset as code.** `.github/rulesets/default-branch.json` is the source of truth for protecting `main`: it blocks deletion and force pushes, with no bypass actors (Scorecard tier 1). It deliberately does **not** require PRs, reviews, or status checks:
- A solo maintainer can't approve their own PRs.
- The release job pushes `chore: release vX.Y.Z` straight to `main` with `GITHUB_TOKEN`. On a user-owned repo the GitHub Actions app can't be a ruleset bypass actor (the API returns 422), so such rules would break publishing. Branch rulesets don't apply to tags.

```bash
gh api repos/irahardianto/pi-mcp-extension/rulesets                                                                  # list live rulesets (check for drift)
gh api --method POST repos/irahardianto/pi-mcp-extension/rulesets --input .github/rulesets/default-branch.json       # create
gh api --method PUT repos/irahardianto/pi-mcp-extension/rulesets/<id> --input .github/rulesets/default-branch.json  # update
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
- **Stacked PRs are the exception**: their commits can land on `main` individually, so every commit subject in a stack must be a correct Conventional Commit.

`.github/workflows/publish.yml` runs on every push to `main`. Its `verify` job repeats the CI checks on Node 22 and 24 with a read-only token; only then does the `release` job (the only job with `contents: write` / `id-token: write`, in the `npm-publish` environment) scan **all commit subjects since the last tag** and publish automatically:

| Prefix | Release |
|---|---|
| `type!:`, or `BREAKING CHANGE:` in a body | major |
| `feat:` | minor |
| `fix:`, `perf:` | patch |
| anything else (`docs:`, `chore:`, `refactor:`, `test:`, `ci:`, …) | none |

- For `feat` / `fix` / `perf` / breaking changes, add a user-facing entry under `## [Unreleased]` in `CHANGELOG.md`. The workflow stamps the version and date.
- Because the scan covers everything since the last tag, a `docs:` push still publishes if unreleased `fix:` / `feat:` commits are already on `main`.
- The bot creates the `chore: release vX.Y.Z` commit and the tag. Don't create them by hand.
- Dependabot PRs are titled `chore(deps): ...`, `chore(deps-dev): ...`, or `ci(deps): ...`, so they don't release. When a runtime bump must raise the minimum version for users (e.g. a security floor), retitle it `fix(deps): ...` and add a `CHANGELOG.md` entry.
- Releases never overlap (`concurrency: publish`) and are never cancelled mid-flight. The release job runs on Node 24 and uses its bundled npm (>= 11.5.1, verified fail-closed without downloads) for OIDC Trusted Publishing; it never runs `npm ci` or `npm install`, so no install script runs with the write token.
- Maintainers can rehearse a release with `gh workflow run publish.yml -f dry_run=true`: it runs `npm publish --dry-run` and never commits, tags, or pushes (with no release-worthy commits it rehearses a patch). A real manual release (`dry_run=false`) is only allowed from `main`.
