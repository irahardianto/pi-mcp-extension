# MCP connection and OAuth coordination

## Scope

Connect each configured server through one shared in-process attempt. Repeated resets join an in-flight reset; a reset supersedes and cancels a normal connect. An explicit connect or `/mcp:start` waits for handshake and tool discovery. Eager servers still start on session start; lazy servers start only on request. OAuth uses stored credentials first and opens a browser only for an explicit interactive request. A pending browser flow offers Retry and Cancel. `/mcp:auth <name>` reuses credentials; `/mcp:auth <name> --reset` explicitly discards them.

## Acceptance criteria

- Concurrent starts share readiness and failures. Exhausted retries reject with an actionable error. Authentication-needed failures do not enter network retries.
- Stop, cancellation, and shutdown clear retry delays and prevent late connection or discovery from activating tools, including when reset overlaps connect.
- External stop or shutdown during health-check cleanup prevents automatic recovery; health failures without external stop can still recover.
- Interactive authorization uses one callback listener at a time, validates state, opens the browser once, and reopens only on Retry. Headless requests needing a browser fail promptly.
- Agent-visible status lists configured server names, lifecycle, connection and auth state, and sanitized actionable errors. Agent-visible connect validates the name, honors cancellation, and returns success only after tools are active. Connect failures expose only fixed actionable categories, never raw SDK response bodies or authorization headers.
- Tests use explicit temporary credential storage and config paths. No real browser, production server, global configuration, or user credentials are used.

## Non-goals

No daemon, schema cache, idle timeout, package update, lockfile change, automatic start of all lazy servers, or global credential reset on routine connect.

## Ordered checklist

- [x] Inspect documentation, connection/auth code, and existing tests.
- [x] Inject isolated credential storage and global config path in tests.
- [x] Coordinate lifecycle, retry cancellation, auth-required classification, and tool discovery.
- [x] Unify explicit OAuth and connection path; register status and connect tools.
- [x] Add regressions for concurrent starts, retries, cancellation, OAuth, and lazy tool activation.
- [x] Update user documentation and run `npm run typecheck` and `npm test` on the source checkout.
- [x] Repair review findings with regressions for reset/reset/stop, reset/connect/shutdown, health cleanup, and echoed-credential failures.
- [x] Confirm final source-checkout checks after review repairs: `npm run typecheck`, `npm test` with 117 passing tests, and `git diff --check`.

- [x] Preserve OAuth server names containing spaces and exact names ending in `--reset`; verify parser and command-flow regressions, including repeated reset and shutdown through slash commands.

## Remaining limits

These limits are observations, not an acceptance of technical debt. The agent-visible `mcp_connect` tool returns fixed error categories, but the legacy `/mcp`, `/mcp:start`, and `/mcp:auth` commands still display raw server error text. A server that echoes a credential in an HTTP error can therefore expose it through those command outputs. The per-server exclusive lock prevents simultaneous interactive flows for the same server across Pi processes. A process killed during authorization can leave a stale lock, which requires manual removal after checking that no authorization is active. Independent Pi processes still do not share connection attempts, and a silent token refresh can race with another process before it acquires the interactive lock. Different-server flows are serialized only within one Pi process; two processes can compete for a configured fixed callback port. Source-checkout tests use an injected browser opener and mock Pi API; they do not verify activation in the installed Pi runtime.

## Tool activation reporting follow-up

An independent extension can deactivate server tools while the MCP connection remains ready. Report discovered and active tool counts separately. Before `mcp_connect` reports success, verify that every currently discovered tool remains active. Do not silently override external restrictions on an already connected server. Regression coverage removes one and then all discovered tools between two connect calls and verifies the inactive set remains unchanged.

The related per-turn loss of dynamic tools belongs to the runtime composition in `pi-agent-suite`. Fixing that owner is separate from truthful connection reporting here.
