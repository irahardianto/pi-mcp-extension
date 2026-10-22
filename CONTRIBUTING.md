# Contributing to pi-mcp-extension

Thanks for helping improve this extension. This file is a short on-ramp; the
authoritative rules, commands, invariants, and release process live in
[`AGENTS.md`](./AGENTS.md).

## Start here

- [`AGENTS.md`](./AGENTS.md) — hard rules, verification commands, architecture,
  invariants, CI, and commits/release.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — behavioral overview of how
  the runtime fits together (lifecycle, coordination, config trust, and
  credential storage).
- [`README.md`](./README.md) — install, configuration, commands, and tools.
- [`OAUTH.md`](./OAUTH.md) — OAuth 2.1 flows, headless paste-back, and token storage.
- [`SECURITY.md`](./SECURITY.md) — security scope and private reporting.

## Setup

Node 22 or newer is required (CI runs Node 22 and 24). Then:

```bash
npm ci
```

Verification commands (from `AGENTS.md` → *Commands*):

```bash
npm run lint                    # eslint . (type-aware)
npm run typecheck               # tsc --noEmit
npm test                        # all suites
npm run test:coverage           # suites + coverage floor
node --import tsx/esm --test tests/config.test.ts   # one suite
npm pack --dry-run              # tarball contents check
```

`AGENTS.md` is authoritative if this list ever differs. A change is done only
when lint, typecheck, test, and pack all pass. Tests must also pass on macOS
and Windows; skip only POSIX-only behavior and only on the affected platform.

## Workflow

- New functionality, observable behavior changes, and bug fixes must add or
  update deterministic automated tests in `tests/`. Test observable behavior,
  using injected fakes instead of wall-clock sleeps. If no test is needed (for
  example, docs-only, CI-only, or chore-only changes with no runtime impact, or
  behavior-preserving refactoring already covered by existing tests), explain
  why in the PR.
  See [`AGENTS.md`](./AGENTS.md#testing--bug-fix-workflow) for the full policy.
- Work on a branch and open a PR. Do not push to `main`; every push to `main`
  can publish to npm.
- Use a [Conventional Commit](https://www.conventionalcommits.org/) **PR title**.
  PRs are squash-merged, so the title becomes the commit that decides the
  release: `feat` → minor, `fix` / `perf` → patch, `type!` / `BREAKING CHANGE:` →
  major, everything else → no release.
- Add a user-facing `## [Unreleased]` entry in [`CHANGELOG.md`](./CHANGELOG.md)
  for `feat` / `fix` / `perf` / breaking changes.
- In a stacked PR, every commit can land on `main` individually, so every
  commit subject must itself be a valid Conventional Commit.
- Never run `npm publish` / `npm version`, edit `package.json` `version`, or
  hand-write a release heading. See `AGENTS.md` → *Commits & release*.

## Pre-merge smoke test

`docs:`, `refactor:`, and `chore:` commits don't publish on their own, but they
ship with the next patch or feature release. A lifecycle regression can
therefore reach users bundled with an unrelated fix.

Run this checklist for PRs that touch `src/index.ts`,
`src/connection-coordinator.ts`, `src/server-manager.ts`,
`src/transport-factory.ts`, `src/stdio-process.ts`, OAuth/callback/lock modules
(`oauth-provider.ts`, `authorize-flow.ts`, `oauth-state-store.ts`,
`auth-lock.ts`, `callback-*.ts`), or any refactor that moves lifecycle code.
Paste the checklist with results into the PR description.

### Load the built package

Fastest while iterating (loads the repo's `src/` directly):

```bash
npm ci
pi -e ./src/index.ts
```

To test the actual npm artifact (catches packaging and missing-dependency bugs):

```bash
npm pack
rm -rf /tmp/pi-mcp-smoke && mkdir -p /tmp/pi-mcp-smoke
tar -xzf pi-mcp-extension-*.tgz -C /tmp/pi-mcp-smoke
cd /tmp/pi-mcp-smoke/package
npm install --omit=dev --omit=peer --ignore-scripts
pi -e /tmp/pi-mcp-smoke/package      # or: pi install /tmp/pi-mcp-smoke/package
```

`pi install ./pi-mcp-extension-*.tgz` does **not** work on current Pi: it treats
the `.tgz` as an extension file. Extract it first. A local package is not
dependency-installed by Pi, which is why the `npm install` step is needed.

Use an isolated agent directory so the smoke test doesn't touch your real
config: `export PI_CODING_AGENT_DIR=/tmp/pi-mcp-smoke/agent`.

### Checklist

- [ ] **stdio server** (e.g. `npx -y @modelcontextprotocol/server-everything`):
      Pi starts it, `/mcp` reports it ready, a tool call works (for example ask
      Pi to call `mcp_everything_echo`), `/mcp:stop everything` and
      `/mcp:start everything` both work. Note that these commands require the
      server name.
- [ ] **Crash recovery**: kill the stdio child
      (`pgrep -af mcp-server-everything`, then `kill <pid>`) and confirm the
      server reconnects automatically without restarting Pi.
- [ ] **streamable-http with OAuth**: first-time authorization completes in the
      browser; restarting Pi reconnects silently with stored tokens;
      `/mcp:auth <name> --reset` forces fresh registration and authorization.
- [ ] **Headless paste-back**: with no browser available, the redirect URL can
      be pasted back and authorization completes.
- [ ] **Project config trust**: an untrusted project's `.pi/mcp.json` is
      ignored; the same file is applied after trusting the project
      (`pi --approve`).
- [ ] **Session reload**: starting a new session (`/new`) or relaunching Pi in
      another directory restarts servers and leaves no orphan child processes
      (`pgrep -af <server command>` after Pi exits).

## Reporting security issues

Do not open a public issue for a vulnerability. Follow
[`SECURITY.md`](./SECURITY.md) and use GitHub Private Vulnerability Reporting.
