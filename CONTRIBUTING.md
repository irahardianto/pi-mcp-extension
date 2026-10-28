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
when lint, typecheck, test, and pack all pass, plus the pre-merge smoke test
below for anything that touches runtime behavior. Tests must also pass on macOS
and Windows; skip only POSIX-only behavior and only on the affected platform.

## Workflow

- New functionality, observable behavior changes, and bug fixes must add or
  update deterministic automated tests in `tests/`. Test observable behavior,
  using injected fakes instead of wall-clock sleeps. If no test is needed (for
  example, docs-only, CI-only, or chore-only changes with no runtime impact, or
  behavior-preserving refactoring already covered by existing tests), explain
  why in the PR.
  See [`AGENTS.md`](./AGENTS.md#testing--bug-fix-workflow) for the full policy.
- `npm run lint` enforces Qlty-aligned structural complexity limits on
  `src/**/*.ts`: `<= 15` cyclomatic complexity (`complexity`), `<= 15` cognitive
  complexity (`pi-mcp/max-cognitive-complexity`), `<= 4` return statements, and
  `<= 4` control-flow nesting levels. Qlty's `function_complexity`,
  `return_statements`, and `nested_control_flow` smells use the same thresholds;
  keep `qlty smells --all` clean when you touch `src/`.
- `npm run lint` also caps boolean expressions at `<= 3` `&&` / `||` operators on
  `src/**/*.ts` and `scripts/**/*.ts` (`pi-mcp/max-boolean-operators`), matching
  Qlty's `boolean_logic` smell (threshold 4), and caps function/method parameter
  lists at `<= 5` parameters (`@typescript-eslint/max-params`), matching Qlty's
  `function-parameters` smell (threshold 5). Extract a named predicate or a
  lookup table instead of a long inline chain, and group related arguments into
  a typed options object; keep `qlty smells --all` free of `Complex binary expression`
  and `function-parameters` findings.
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
`src/register-commands.ts`, `src/connection-coordinator.ts`,
`src/server-manager.ts`, `src/transport-factory.ts`, `src/stdio-process.ts`,
the OAuth/callback/lock modules (`oauth-*.ts`, `authorize-*.ts`,
`oauth-state-store.ts`, `auth-lock.ts`, `callback-*.ts`), or `package.json`, and
for any refactor that moves lifecycle code. Paste the checklist with its output
into the PR description. [`AGENTS.md`](./AGENTS.md) carries the same rule, so an
agent that never opens this file still sees it.

Everything below runs without a TTY. The one exception — the OAuth browser
redirect — is marked in the checklist.

### Run the repository's Pi

The smoke test must exercise the Pi this repository pins. Call
`./node_modules/.bin/pi` (`npm ci` installs it) instead of a bare `pi`, which
resolves to whatever launcher is on `PATH`: often a different version, and
without a TTY that launcher can fall into a package-manager path
(`npm install -g …`) that dies with `EACCES` before any UI starts. That failure
is not an exemption from this checklist — Pi also runs headlessly over JSONL,
which is the primary recipe below.

### Isolate the run and its fixture

```bash
export PI_CODING_AGENT_DIR=/tmp/pi-mcp-smoke/agent   # never your real config
mkdir -p "$PI_CODING_AGENT_DIR"
```

Use the repository's own stdio fixture — `tests/mock-server.ts` serves `echo`,
`add`, `get_status`, `get_cwd`, and `fail_tool` — so the check needs no network
and no third-party download. The explicit `cwd` keeps
`node --import tsx/esm tests/mock-server.ts` resolvable wherever Pi runs:

```bash
cat > "$PI_CODING_AGENT_DIR/mcp.json" <<JSON
{
  "mcpServers": {
    "mock": {
      "type": "stdio",
      "command": "node",
      "args": ["--import", "tsx/esm", "tests/mock-server.ts"],
      "cwd": "$PWD",
      "lifecycle": "eager"
    }
  }
}
JSON
```

`$PWD` above is the repository root; run the recipes below from there.

### Headless (default): RPC mode

```bash
./node_modules/.bin/pi --mode rpc --no-session -e ./src/index.ts
```

RPC mode reads commands as JSON lines on stdin and writes responses, session
events, and extension UI records as JSON lines on stdout. Extension slash
commands execute directly with `data.disposition: "handled"` — no model call, no
PTY, and no ANSI scraping:

| stdin | expected stdout |
|---|---|
| `{"id":"1","type":"prompt","message":"/mcp"}` | `response` for `1`, then a `notify` record with `MCP: 1/1 servers ready` and `✓ mock (ready)` |
| `{"id":"2","type":"prompt","message":"/mcp mock"}` | `notify` with `Server: mock`, `State:  ready`, `Source: global` (or `project`), `Tools: 5/5 active` |
| `{"id":"3","type":"prompt","message":"/mcp:stop mock"}` | `notify` with `pi-mcp: Stopped mock` |
| `{"id":"4","type":"prompt","message":"/mcp:start mock"}` | `notify` with `pi-mcp: Started mock` |
| `{"id":"5","type":"new_session"}` | `response` for `5` with `data.cancelled: false`; a following `/mcp` reports the servers ready again |
| `{"type":"extension_ui_response","id":"<request id>","value":"…"}` | answers a pending `select` / `input` dialog (`{"confirmed":true}` for `confirm`, `{"cancelled":true}` to dismiss) — this is how the startup OAuth prompt and the headless paste-back dialog are driven |

Read stdout continuously and continue as soon as the expected record arrives —
do not sleep for a fixed time. Commands sent while `session_start` is still
connecting are handled once startup settles, so a slow first record is normal (a
failing server retries five times before it reports). `ctx.ui.setStatus("pi-mcp", …)`
arrives as a `setStatus` record with `statusKey: "pi-mcp"`; this extension only
sets text there for the auth hint (`run /mcp:auth <server>`), so a `setStatus`
record without `statusText` is a clear, not a failure.

When done, close stdin: Pi runs `session_shutdown` and exits 0. Then confirm no
child survived:

```bash
pgrep -af "tsx/esm tests/mock-server.ts" || echo "no orphan stdio children"
```

The client below is the reference for that protocol. It asserts the ready line,
the per-server detail, the stop/start cycle, and a `new_session` reload, prints
one line per check, and exits non-zero on a failure. Save it as
`/tmp/pi-mcp-smoke/smoke.mjs` and paste its output into the PR.

```js
// Headless pi-mcp smoke client: drives Pi over RPC (JSONL on stdin/stdout), no TTY.
// Run from the repository root:  node /tmp/pi-mcp-smoke/smoke.mjs [--approve]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const pi = spawn("./node_modules/.bin/pi", ["--mode", "rpc", "--no-session", "-e", "./src/index.ts", ...process.argv.slice(2)], {
  stdio: ["pipe", "pipe", "inherit"],
});
const records = [];
const waiters = [];

createInterface({ input: pi.stdout }).on("line", (line) => {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return; // WHY: Pi writes only JSONL to stdout; a non-JSON line is noise, not a reason to abort.
  }
  records.push(record);
  for (const waiter of [...waiters]) {
    if (records.indexOf(record) < waiter.from || !waiter.match(record)) continue;
    waiters.splice(waiters.indexOf(waiter), 1);
    clearTimeout(waiter.timer);
    waiter.resolve(record);
  }
});

/** Send one command; the returned cursor keeps the next waitFor on later records. */
function send(command) {
  const from = records.length;
  pi.stdin.write(`${JSON.stringify(command)}\n`);
  return from;
}

function waitFor(label, match, from = 0, timeoutMs = 60_000) {
  const seen = records.find((record, index) => index >= from && match(record));
  if (seen) return Promise.resolve(seen);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    waiters.push({ from, match, resolve, timer });
  });
}

const notify = (fragment) => (record) => record.method === "notify" && String(record.message).includes(fragment);
const response = (id) => (record) => record.type === "response" && record.id === id;
const ready = (from) => waitFor("/mcp ready line", notify("servers ready"), from);

const results = [];
async function check(name, body) {
  try {
    await body();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
  }
}

await check("/mcp reports every server ready", async () => {
  const line = await ready(send({ id: "1", type: "prompt", message: "/mcp" }));
  if (!/1\/1 servers ready/.test(line.message)) throw new Error(line.message);
});

await check("/mcp <name> reports a ready server, live tools, and its source", async () => {
  const detail = await waitFor("/mcp mock detail", notify("Server: mock"), send({ id: "2", type: "prompt", message: "/mcp mock" }));
  for (const expected of ["State:  ready", /Source: (global|project)/, /Tools: \d+\/\d+ active/]) {
    const ok = expected instanceof RegExp ? expected.test(detail.message) : detail.message.includes(expected);
    if (!ok) throw new Error(`missing ${String(expected)}:\n${detail.message}`);
  }
});

await check("/mcp:stop then /mcp:start restores the server", async () => {
  await waitFor("stop notify", notify("Stopped mock"), send({ id: "3", type: "prompt", message: "/mcp:stop mock" }));
  await waitFor("start notify", notify("Started mock"), send({ id: "4", type: "prompt", message: "/mcp:start mock" }));
  const line = await ready(send({ id: "5", type: "prompt", message: "/mcp" }));
  if (!/1\/1 servers ready/.test(line.message)) throw new Error(line.message);
});

await check("new_session reloads the servers", async () => {
  await waitFor("new_session response", response("6"), send({ id: "6", type: "new_session" }));
  const line = await ready(send({ id: "7", type: "prompt", message: "/mcp" }));
  if (!/1\/1 servers ready/.test(line.message)) throw new Error(line.message);
});

pi.stdin.end(); // closing stdin runs Pi's teardown (session_shutdown) and exits 0
const exitCode = await new Promise((resolve) => pi.on("exit", resolve));
const failed = results.filter((line) => line.startsWith("FAIL")).length;
console.log(results.map((line) => `  ${line}`).join("\n"));
console.log(`pi exited ${String(exitCode)}; ${String(failed)} failed`);
process.exit(failed === 0 ? 0 : 1);
```

### Project config trust

Run both halves from a throwaway project directory, and never `--approve` this
repository itself: its local `.pi/mcp.json` points at real remote servers and
OAuth providers.

```bash
mkdir -p /tmp/pi-mcp-smoke/proj/.pi
cat > /tmp/pi-mcp-smoke/proj/.pi/mcp.json <<JSON
{
  "mcpServers": {
    "proj": {
      "type": "stdio",
      "command": "node",
      "args": ["--import", "tsx/esm", "tests/mock-server.ts"],
      "cwd": "<absolute path to this repository>",
      "lifecycle": "eager"
    }
  }
}
JSON
cd /tmp/pi-mcp-smoke/proj
```

- **Untrusted** (`--no-approve`, and the default with a fresh
  `PI_CODING_AGENT_DIR`): `/mcp mock` carries
  `Project config: not loaded (/tmp/pi-mcp-smoke/proj/.pi/mcp.json) — this project is not trusted, so its mcp.json is never read`,
  and `/mcp proj` answers `pi-mcp: No server named "proj"`.
- **Trusted** (`--approve`): `/mcp` reports `2/2 servers ready` and
  `/mcp proj` reports `State:  ready` with `Source: project`.

### Interactive TUI (browser half only)

The OAuth browser redirect needs a real terminal and a browser; everything else
runs headless above.

```bash
./node_modules/.bin/pi -e ./src/index.ts      # add -a to trust the project for this run
```

With a fresh `PI_CODING_AGENT_DIR`, Pi asks `Trust project folder?` before
`session_start`. Answer it (or pass `-a`) — the prompt is expected and is not a
reason to skip the run.

### Packaged artifact

To test the actual npm artifact (catches packaging and missing-dependency bugs),
drive the extracted tarball instead of `./src/index.ts`:

```bash
npm pack
rm -rf /tmp/pi-mcp-smoke/package && mkdir -p /tmp/pi-mcp-smoke/package
tar -xzf pi-mcp-extension-*.tgz -C /tmp/pi-mcp-smoke/package
cd /tmp/pi-mcp-smoke/package
npm install --omit=dev --omit=peer --ignore-scripts
./node_modules/.bin/pi -e /tmp/pi-mcp-smoke/package
```

Installing the `.tgz` directly does **not** work on current Pi: it treats the
archive as an extension file. Extract it first. A local package is not
dependency-installed by Pi, which is why the `npm install` step is needed.

### Checklist

Paste these with their result into the PR description. The headless items come
from `smoke.mjs` and the two RPC transcripts above.

- [ ] **stdio server, lifecycle** (headless): `/mcp` reports every server ready;
      `/mcp mock` shows `State:  ready`, `Tools: 5/5 active`, and its source;
      `/mcp:stop mock` then `/mcp:start mock` restores it.
- [ ] **tool call** (TUI, needs a model): ask Pi to call the fixture's `echo`
      tool (`mcp_mock_echo` with the default prefix) and check the reply.
- [ ] **crash recovery** (headless): kill the stdio child
      (`pgrep -af "tsx/esm tests/mock-server.ts"`, then `kill <pid>`) and confirm
      `/mcp` reports the server ready again without restarting Pi.
- [ ] **streamable-http with OAuth** (TUI + browser): first-time authorization
      completes in the browser; restarting Pi reconnects silently with stored
      tokens; `/mcp:auth <name> --reset` forces fresh registration and
      authorization.
- [ ] **Headless paste-back** (RPC): with no browser available, the redirect URL
      can be pasted back and authorization completes — the prompt arrives as an
      `extension_ui_request` you answer with `extension_ui_response`.
- [ ] **Project config trust** (headless pair above): an untrusted project's
      `.pi/mcp.json` is ignored, and the same file is applied with `--approve`
      (`Source: project`).
- [ ] **Session reload and orphans** (headless): `new_session` restarts the
      servers, and `pgrep -af "tsx/esm tests/mock-server.ts"` finds no orphan
      child after Pi exits.

## Reporting security issues

Do not open a public issue for a vulnerability. Follow
[`SECURITY.md`](./SECURITY.md) and use GitHub Private Vulnerability Reporting.
