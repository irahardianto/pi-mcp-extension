# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Trailing MCP `notifications/progress` updates are no longer dropped when a notification and its `tools/call` response (or stream close) arrive in the same read batch (#300). `@modelcontextprotocol/sdk`'s `Protocol._onnotification` defers notification dispatch onto a microtask while `Protocol._onresponse` and `Protocol._onclose` clear `_progressHandlers` synchronously, so whenever `StdioClientTransport.processReadBuffer()`, an SSE chunk, or a JSON batch response delivered `[notifications/progress, result]` in one synchronous loop, the response deleted the progress handler before the notification microtask ran — dropping the final progress update and emitting `Received a progress notification for an unknown token`. `createTransport` now instruments `onmessage`, `onclose`, and `close()` in place to queue subsequent frames and close events in strict FIFO wire order behind any in-flight notification microtask (including re-entrant dispatches), isolate throwing `onerror` listeners and unstringifiable thrown values from wedging the queue, deduplicate `onclose` / concurrent `close()` dispatches across turns, and drain queued steps before `close()` settles while keeping ordinary notification-free turns synchronous.

## [1.15.0] - 2026-11-11

### Added
- MCP `notifications/progress` now reaches Pi while a tool runs, and each notification restarts the `tools/call` timeout (#254). `ToolBridge` dropped the SDK's `onprogress` callback, so `tools/call` carried no `_meta.progressToken`, a server's progress events were discarded as "unknown token", and the request kept its original inactivity deadline — a Playwright flow, migration, or test runner that reported progress every few seconds was still killed at `requestTimeoutMs` (30s) with nothing in the TUI to show work was happening. `execute` now forwards Pi's `onUpdate`, `callToolWithClient` passes `onprogress` plus `resetTimeoutOnProgress: true`, and each notification renders as one line: the server's own `message` when it sends one (trimmed, sanitized with `sanitizeTerminalText`, secret-masked with `redactSecrets`, and bounded to 200 characters), otherwise `Progress 3/10` from the numeric fields (`?` when `progress` is non-finite). Consecutive identical lines are collapsed so a chatty server does not re-render the in-progress row, the handler is installed even when Pi supplies no `onUpdate`, uncaught SDK notification-handler errors (such as a server sending `total: null` in `notifications/progress` or a throwing `onUpdate`) are recorded as `server.notification_error` diagnostics instead of tearing down `streamable-http` / `sse` streams, and `redactSecrets` preserves truncated `[REDACTED…` / `Authorization` scheme tails so post-redaction length capping stays strictly idempotent. The reset only extends a call that keeps proving it is alive — a silent or hung server still times out exactly as before, while a call that never stops reporting has no wall-clock cap and stays cancellable through the usual `AbortSignal` → `notifications/cancelled` path. Cancellation, `isError`, and the `timeout` / `protocol` error classification are unchanged.

## [1.14.6] - 2026-11-11

### Fixed
- The active MCP tool order no longer depends on connection timing (#278). Eager servers connect concurrently and each server's tools were activated when its own connection finished, while `desiredActive` followed `tools/list` order — which the MCP spec does not define — so Pi's active list, the system prompt's tool section, and the tools declared to the provider changed order between session starts even though the tool set was identical. That invalidated a server-side prefix cache (vLLM, SGLang, llama.cpp) for the whole conversation, since the tool section sits near the start of the prompt. Each reconcile now writes one ordered active list — this bridge's tools sorted by Pi name among the slots they occupy, every other extension's tool left where it is — `session_tree`, `input`, `before_agent_start`, and `tool_execution_end` re-apply that order without re-activating inactive tools when `/tree` restores transcript first-appearance order or another extension or tool (such as `tool_search`) reorders `setActiveTools` idle or mid-turn, and a `before_provider_request` handler applies the same order across top-level `tools` (`{ name }` and `{ function: { name } }`), AWS Bedrock Converse `toolConfig.tools` (`{ toolSpec: { name } }`, keeping trailing `cachePoint` and `toolChoice` intact), Google/Vertex `config.tools[].functionDeclarations` (keeping non-function Gemini tool groups untouched), and `pi-messages` `context.messages[].toolsAdded` (per `system` message, keeping non-system messages intact) while keeping any slot-level `cache_control` breakpoint on its slot — Pi otherwise rebuilds outgoing tool declarations from the transcript's first-appearance order (a pure reorder emits no transcript delta, so a server connecting after the first turn kept its tools at the end in connect order). A reconcile or re-order check whose set and order already match writes nothing; one whose set is unchanged but whose order differs rewrites it. Servers that connect after an earlier turn are announced on that later turn through the provider's mid-conversation tool-addition channel (Anthropic native tool changes, cross-turn transcript deltas), which cannot move back into earlier turns.

## [1.14.5] - 2026-11-08

### Fixed
- A live `notifications/tools/list_changed` refresh no longer re-activates MCP tools that another extension or a user policy deactivated while the server stayed connected (#214). `_reconcileTools` called `_activateServerTools` unconditionally, adding every discovered tool back into `pi.setActiveTools` — undoing the restriction `README.md` documents and `mcp_connect` otherwise respects, so a server exposing one additional tool silently re-enabled a destructive tool a policy had removed. The bridge now tracks which servers it has activated and not deactivated since and keys tool state by raw MCP tool name: a refresh while the server is still active activates only tools the connection has not seen before, preserves the active/inactive state of previously discovered tools even when a colliding sibling shifts their Pi identifiers, restores a re-advertised tool to the state it left in when dropped on that connection, and skips `pi.setActiveTools` altogether when the active set is unchanged. A first connect or a reconnect after a stop, background recovery, or session teardown still activates the whole discovered set and starts with a clean dropped-tool memory.

## [1.14.4] - 2026-11-08

### Fixed
- A stdio teardown no longer spends 700ms polling a PID it cannot signal (#203). `kill(pid, 0)` answers `EPERM` — not "gone" — for a PID that was recycled to another user's process (or for a signal a policy layer refuses), so `ensurePidTerminated` read the child as alive, burned its full SIGTERM window (20 × 25ms), escalated, and burned a second SIGKILL window (8 × 25ms); both teardown paths call it twice, so one failed connect or `/mcp:stop` stalled 1,400ms. A signal attempt is now classified as delivered, gone (`ESRCH`) or refused (`EPERM`): only the PIDs that accepted the signal are waited on, a refused signal no longer costs a wait window, and a root the caller cannot signal is dropped from the target list instead of being polled — its reachable descendants are still signalled. A refusal is not read as "already exited" either: when a liveness probe still finds the target signalable, the refusal came from that signal rather than the process — SELinux/AppArmor/seccomp can permit SIGKILL and deny SIGTERM — so the SIGKILL escalation runs at once, exactly as it did before, just without a wait that could never end.

## [1.14.3] - 2026-11-08

### Fixed
- The `PI_MCP_DEBUG` log no longer drops entries or deletes a peer's backup when concurrent Pi processes rotate `<agent dir>/logs/pi-mcp.log` at ~2 MB (#202). Rotation now uses a single `rename` (no `unlink` before `rename` that could delete a peer's freshly rotated 2 MB backup) and treats `ENOENT` on `rename` as a lost race so `appendFile` still runs without reporting `[pi-mcp] Debug log write failed: ENOENT …`. Before renaming, the size is re-read to narrow the lock-free race window: rotation is skipped if the file vanished or shrank (`currentSize < size`, after a peer rotated and recreated it) while still rotating if a peer merely appended (`currentSize >= size`). Rotation (by this process or a peer) and a lost `chmod` race leave `fileModeEnsured` false so `0o600` is enforced on the new file, and a `logs/` directory removed mid-write or between writes is recreated and retried once in the same write without dropping the entry.

## [1.14.2] - 2026-11-07

### Fixed
- Two tools from the same MCP server whose names sanitize to the same Pi identifier no longer trade places (#213). `_reconcileTools` assigned names in `tools/list` order, so a lossy name could claim the unhashed `<prefix>_<server>_<tool>` and push the tool that already matched that identifier onto the hashed fallback: with `my-tool` and `my_tool` on server `alpha`, calling `mcp_alpha_my_tool` ran `my-tool`, and a reconnect (or `notifications/tools/list_changed`) that reordered the same two tools silently swapped which MCP tool that name executed — `tools/list` order is not part of the MCP contract, so the README's stable-name guarantee did not hold. Colliding names are now assigned over a deterministic order of the tool set: the raw name that needs no substitution wins the unhashed identifier, remaining ties break by the raw name's code-point order, and every other member of the group takes its SHA-256-hashed name (or that name's numbered suffix when another server already holds it). Only the colliding group's own order can move (to its first member's slot, winner first), so every other tool keeps the name and the position the server gave it; because the result is a function of the tool set, a colliding sibling added in a later `tools/list` re-settles the group — same names in every session, no dependence on what the server listed first.

## [1.14.1] - 2026-11-07

### Fixed
- Extension-registered servers survive concurrent registration bursts correctly (#216). Pi's MCP registry emits `mcp_servers_change` synchronously for every `register()`/`unregister()` (`void this.emit(...)`, which never awaits an earlier listener), so two registrations in one turn ran two reconciles at once. Each reconcile awaits child-process teardown in `ServerManager.removeServer`, so the second one saw a half-shut-down entry, finished first, and the first one's resume then re-added a server that had just been unregistered — or deleted the entry the second one had just replaced, leaving its stdio child running with no owner (`session_shutdown` cannot kill a server that is no longer in the map). Reconciles now run through one serialized queue whose turn re-reads `pi.getMcpServers()` instead of applying its event's snapshot, so a burst collapses to the state that is current when the turn runs; a turn also bails at its checkpoints once its session has switched or shut down, and any in-flight reconcile eager start is aborted and cleaned up when a newer change event unregisters or replaces the server or when `session_start`/`session_shutdown` interrupts it. `ServerManager.removeServer` deletes the map entry only when it still holds the instance it just shut down, so an in-flight removal can never drop a replacement. Change events are ignored while no session is active (before `session_start` and after `session_shutdown`), matching the built-in MCP extension, since servers spawned then would be attached to no session; `session_start` drains any in-flight reconcile turn before reloading, reads the registry itself, keeps `sessionActive` false if `session_shutdown` interrupts startup, and, when a registration arrived while it was still starting servers, reconciles once more when it finishes instead of waiting for an unrelated later event.

## [1.14.0] - 2026-11-06

### Added
- Bridged MCP tools now carry their structured annotations into Pi (#253). `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` were only appended to the tool description as text, so every tool was registered with `annotations: undefined` and Pi permission extensions could not tell a read-only tool from a destructive one. The hints are now also passed to `registerTool` as `annotations`: only strictly boolean values are copied (`false` is kept), `title` stays the tool's label, and the field is omitted when a tool has no usable hint. Descriptions and labels are unchanged.

## [1.13.0] - 2026-11-04

### Added
- Connected MCP servers' initialize-handshake instructions are available in `/mcp <name>`, `mcp_status`, and successful `mcp_connect` results. Guidance is secret-redacted, terminal-sanitized, and bounded to 500 characters; absent or blank guidance is omitted (#256).

## [1.12.4] - 2026-11-04

### Fixed
- Tool results now summarize `resource_link` entries with their URI, label, metadata, and a `mcp_read_resource` hint. Embedded image resources reach the model as image blocks, and other blobs include their MIME type and decoded byte count (#255).

## [1.12.3] - 2026-11-04

## [1.12.2] - 2026-11-03

### Fixed
- `$ref` values whose target name is percent-encoded in the URI fragment now resolve instead of silently degrading to `Type.Any()`. RFC 6901 §6 represents a `#/…` pointer as a URI fragment, so a definition such as `$defs["Response[Item]"]` (e.g. a generic `Response<Item>` or `$defs["User Profile"]`) is referenced as `#/$defs/Response%5BItem%5D`; `resolveRefTarget` split the fragment on `/` and unescaped `~1`/`~0` but never percent-decoded the segments, so the property lookup missed and `convertJsonSchemaToTypebox` handed Pi an unconstrained `{}` schema — a tool that then accepted arguments the server rejects. The fragment is now split on `/` and each token percent-decoded before §4 unescaping (decoding first is required: `%7E1` denotes the escape sequence `~1`, i.e. `/`, not a literal `~1` key), which matches how ajv resolves fragments and covers the escaped-pointer cases in the official JSON-Schema-Test-Suite (`tilde~0field`, `slash~1field`, `percent%25field`, `foo%22bar`). Two fallbacks run only when that token-wise reading misses, so they can add a resolution but never change one: the undecoded tokens, so a server that emits a literal `%` in a definition name keeps resolving; and a whole-fragment decode, so a resolver that treats `%2F` as a separator still reaches the subtree. A malformed escape (`%ZZ`, a truncated `%E0%A4%A`) is looked up literally rather than throwing out of `tools/list` conversion — a definition named `Bad%ZZName` still resolves, and otherwise the `$ref` degrades like any unresolvable one (#210).

## [1.12.1] - 2026-11-01

### Fixed
- Variadic tuple schemas keep their rest element schema, so a tool whose parameters describe `[string, ...integer[]]` no longer rejects every call that supplies rest elements (#211). `convertArraySchema` converted `prefixItems` (or a draft-07 array `items`) straight into `Type.Tuple`, which always emits `additionalItems: false`, and dropped the sibling rest schema — `items` next to `prefixItems`, or `additionalItems` next to a draft-07 `items` array. Pi's `validateToolArguments` (`Compile(tool.parameters).Check(args)`) therefore failed with `Validation failed for tool "…": - <path>: schema is false` for any rest element, even when it matched the server's schema. The rest schema is now resolved from 2020-12 `items` (falling back to a legacy sibling `additionalItems`) or from draft-07 `additionalItems`, converted recursively so a `$ref` into `#/$defs`, constraints, and nested arrays/objects resolve, and passed to the tuple as `additionalItems`; a boolean is carried through unchanged. A tuple is closed only when the source says so (`items: false` / `additionalItems: false`) — an absent rest keyword constrains nothing in either draft, so a lone `prefixItems` no longer rejects every element after the first either.

## [1.12.0] - 2026-10-31

### Added
- MCP **Resources** are now bridged into Pi (issue #198): `mcp_list_resources` / `mcp_read_resource` agent tools plus a `/mcp:resources [server] [uri]` slash command expose server resources and URI templates that were previously only reachable when a server embedded them inside a `tools/call` result. Listing follows `resources/list` and `resources/templates/list` cursors with the same 100-page guard as `tools/list`, asks only servers that advertise the `resources` capability, and treats a JSON-RPC `-32601` from either list method as "no resources/templates" instead of a failure. Each server's catalog is cached after the first listing and invalidated by `notifications/resources/list_changed` — a page set that was in flight when the notification arrived is handed to its caller but never cached — and is dropped on stop/removal. `resources/read` returns text as text (including an empty `text: ""`), `image/*` blobs as Pi image blocks, and other binary blobs as a bounded `[Binary resource: … (mimeType, N bytes)]` summary so a large archive cannot flood the context window. Requests carry the per-server timeout and caller `AbortSignal`; cancellation stays a cancellation, an SDK request timeout keeps `"timeout"`, and a 401/403 routes through the existing re-authorization path. Resource names, URIs, descriptions, and previews are sanitized before they reach a notification, a catalog of thousands of entries renders 50 rows plus an "and N more" line, and `mcp_list_resources` keeps every healthy server's row when another server's listing fails (the failing row carries `error`) or when a server never advertised the capability (`resourcesUnsupported`) — `mcp_read_resource` reports the same capability gap in words instead of surfacing JSON-RPC `-32601`.

### Changed
- `ServerManager.resolveRequestTimeoutMs` is now public so the resource bridge and `/mcp:resources` resolve the same effective timeout as tool discovery and execution.

## [1.11.10] - 2026-10-29

### Changed
- `package.json` now declares `pi.image` (`docs/icon-preview.png`) and an expanded package `description` for the [Pi package gallery](https://pi.dev/packages/pi-mcp-extension) card and detail header, while keeping `docs/` excluded from the published npm tarball.

## [1.11.9] - 2026-10-29

### Fixed
- A stale-lock reclaim race no longer deletes the winning process's live authorization lock. `restoreCandidate` put a contender's fresh `<hash>.json.lock` back after the stale-check rename with `link()`, swallowed every error from it, and then unlinked the moved copy unconditionally — so on mounts and sandboxes where `link(2)` fails for a reason that says nothing about the destination (`ENOTSUP`/`EOPNOTSUPP` on FAT/exFAT/SMB/SSHFS/FUSE, `EPERM` under `fs.protected_hardlinks` or seccomp), the contender's only lock file disappeared and its in-flight interactive OAuth flow aborted with `Authorization lock lost`. A link failure that is neither `EEXIST` nor `ENOENT` now re-creates the record with the same exclusive-create write used to acquire a lock: the contender keeps it when the lock path is free, and a lock another process acquired in the meantime is never overwritten, because both restore paths refuse to replace an existing file. A restore that cannot complete is reported as `auth.lock_restore_failed` in the `PI_MCP_DEBUG` log instead of leaving an orphan `.stale-*` file behind (#204).

## [1.11.8] - 2026-10-28

### Fixed
- The `PI_MCP_DEBUG` diagnostic redactor now masks the credential shapes that child servers, MCP log notifications, and transport errors actually echo. It covers API keys and other key/value or JSON secrets (`api_key`, `apiKey`, `x-api-key`, `x_api_key`, `private_key`, `secret_key`, `secret_access_key`, `password`, `passwd`, `secret`, `token`) in double or single quotes, prefixed spellings such as `db_password` and `aws_secret_access_key`, query-string credentials on a server URL (`?api_key=`, `?token=`, `?key=`, `?secret=`, `?password=`, `?auth=`, `?code=`), `Authorization` headers in any scheme (`Token`, `ApiKey`, `DPoP`, `OAuth`, `Bearer`, `Basic`, `Digest`) with or without quotes — including the JSON `"Authorization": "…"` form — and URL userinfo passwords (`https://user:password@host`). A value is masked up to its own delimiter: a quoted value runs to its closing quote, so an apostrophe inside a secret no longer leaves its tail in the log, and an object or array value is masked as one unit instead of stopping at the first brace. Previously only the OAuth-specific field names in double quotes, six query-parameter spellings, and `Bearer`/`Basic`/`Digest` headers were masked, so an `x-api-key` header, a `?api_key=` URL, or a single-quoted `client_secret` reached `<agent dir>/logs/pi-mcp.log` in cleartext. The redactor stays idempotent and leaves prose such as `Unexpected token <` untouched.
- The same redaction now applies to the `/mcp` and `/mcp <name>` surfaces and error notifications users paste into bug reports: the per-server `stderr` ring buffer ("Recent output", also returned by `getServerLogs`), the `Last error:` line in `/mcp` and `/mcp <name>`, and start/auth/recovery failure notifications (`formatErrorMessage`, `/mcp:auth`). A child server that echoes its own key no longer surfaces it there, and neither does a connect failure whose message contains `?api_key=…` (#201).

## [1.11.7] - 2026-10-28

### Fixed
- A `stdio` server's final stderr line is no longer lost when it is written without a trailing newline and the process closes before its stderr reaches EOF: closing the transport now flushes the buffered partial line, so the fatal message that explains a timeout (e.g. `FATAL: Missing API_KEY`) still appears in `/mcp <name>` recent output and `getServerLogs`. `StdioClientTransport.close()` never ends its stderr `PassThrough` — it only waits, bounded, for the child's `'close'` event — and a descendant that inherited the stderr write end keeps that event from firing, so nothing flushed the splitter's remainder once teardown was bypassed. Both `instrumentStdioTransport` and `createTransport(..., onStderr)` now share `instrumentStderr`, which flushes at the `transport.close()` boundary as well as in `destroyStdioStreams()`, and releases any unterminated post-close chunks after `POST_CLOSE_FLUSH_DELAY_MS` of silence (or immediately on `'end'`/`'close'`) so a line split across ticks stays whole. Every close and teardown flush is provisional — it emits what has already been decoded without finalising the UTF-8 `StringDecoder` — so a multi-byte character split across the close boundary still arrives intact instead of turning into replacement characters (#206).

## [1.11.6] - 2026-10-28

### Fixed
- A server configured with both `auth` (OAuth) and a static `Authorization` header no longer sends the wrong credential. The MCP SDK builds `Authorization` from the OAuth access token and then spreads the configured headers on top of it, so an exact-case `Authorization` key silently replaced the token (the OAuth login never took effect), while a lowercase `authorization` key survived as a second entry that `new Headers()` comma-joined into one malformed header (`Bearer <token>, Bearer <static>`). `Authorization` now belongs to OAuth alone: when `auth` is set it is dropped in any casing — for `streamable-http` and `sse`, and in the authorize flow's challenge probe — and every other static header (tenant keys, gateway routing) still applies. The static value also no longer leaks to the authorization server's metadata, registration, and `/token` requests. Dropping it is recorded as a `config.static_authorization_ignored` diagnostic in the [`PI_MCP_DEBUG`](./README.md#debug-log) log, since a mixed config is a migration leftover (#208).

## [1.11.5] - 2026-10-28

### Fixed
- `isSdkTimeoutError` also reads the `message` of a plain `{ code, message }` rejection (a transport need not throw an `Error`), so a non-JSON-RPC timeout shape is still recognised while any negative JSON-RPC code keeps deciding on its own (#209).
- A `tools/call` the caller cancelled is reported as a cancellation (`McpError("Tool execution cancelled")`, code `protocol`) instead of a request timeout: the SDK rejects an aborted in-flight request with its own `RequestTimeout` error, so the abort must be recognised before the timeout code. A server-returned JSON-RPC error is likewise never mistaken for a timeout any more — a negative code other than the SDK's `-32001` (e.g. `InternalError`, or `-32000` "upstream query timed out") keeps code `protocol` instead of falling through to a message heuristic (#209).
- A `tools/list` request timeout during connect is again retryable and keeps the `timeout` failure category: a server that accepted `initialize` but answered discovery too slowly was reported as an `McpError` with code `protocol`, which fast-fails the connect classifier, so the attempt failed on the first try without consuming `settings.maxRetries`, `mcp_status` showed `Connection protocol`, and `mcp_connect` blamed tool discovery. A `tools/call` timeout is likewise reported as `timeout` instead of `protocol`, and a connect that times out now says the server did not respond in time instead of pointing at its configuration (#209).

## [1.11.4] - 2026-10-28

### Fixed
- The `run /mcp:auth <name>` footer hint and the `pi-mcp: <name> requires re-authorization` warning now stay in sync with the server's actual auth state: a mid-session HTTP 401/403 on a tool call or tool list warns and shows the hint instead of stopping the server silently, a declined server that later connects — after an eager restart or a background reconnect — clears the hint instead of leaving it stuck, a declined server whose later failure is a connection error clears the hint instead of blaming authorization, and `/mcp:stop` during an eager start no longer raises a spurious `Failed to start` toast for the cancelled authorization (#207).
- A 401/403 on the initial `tools/list` of a connect attempt (`initialize` succeeded, discovery did not) is again classified as an authorization failure: it used to be reported as a cancelled authorization, which suppressed the startup authorization prompt, skipped interactive OAuth, and hid the recovery failure. A `tools/list_changed` refresh that hits a 401/403 or is cancelled no longer adds a second, unrelated `Failed to refresh tools` error on top of the re-authorization warning (#207).

## [1.11.3] - 2026-10-27

### Fixed
- A `stdio` server launched through a wrapper command (`npx`, `npm exec`, `uvx`, `sh -c`) no longer leaves the real server process running after a timed-out `initialize` or a `/mcp:stop`: teardown now terminates the whole descendant tree (SIGTERM → bounded wait → SIGKILL per generation) instead of only the wrapper's PID. A surviving grandchild also held the wrapper's inherited `stdout`/`stderr` pipes open, which kept Node's `'close'` event from firing and made `StdioClientTransport.close()` burn its full 4,000ms escalation budget — a 300ms handshake timeout took 4.3s to reject and still leaked the server. Teardown now releases those pipes as well, so the same failure rejects in under a second with no orphaned processes (#205).

## [1.11.2] - 2026-10-27

### Fixed
- A tool schema that composes an object with `allOf` and does not repeat `type: "object"` on the wrapper — the shape Pydantic, FastAPI, and OpenAPI 3.0 generators emit, e.g. `{ "allOf": [{ "$ref": "#/$defs/Pagination" }, { "properties": { "search": { "type": "string" } } }] }` — now converts to an object schema with merged `properties` and `required` instead of a bare `allOf` with neither. Optional arguments left as `null` were coerced to `"null"`, `0`, or `false` (producing false validation errors such as `must be >= 1`), and Anthropic received an empty `input_schema` with no parameters at all. Nested `allOf` chains and chained `$ref` definitions now flatten transitively, and `$ref` cycles stay bounded (#212).

## [1.11.1] - 2026-10-26

### Added
- Pi 1.3.0 `McpStdioServerConfig.cwd` is honored for stdio servers (`pi mcp add --cwd <dir>`), so a server can be spawned in its own working directory: a relative path resolves against the session working directory and a leading `~` expands to your home directory. A `cwd` on a `streamable-http` or `sse` entry is rejected at load time.
- Pi 1.3.0 `oauth.clientName` (also accepted as `auth.clientName`) sets the `client_name` sent with Dynamic Client Registration (default `pi-mcp/<server name>`), for authorization servers that only accept known clients.

### Fixed
- A Pi 1.3.0 project override entry in `<cwd>/.pi/mcp.json` (`{ "internal-tools": { "enabled": false } }` — no `command`/`url`) no longer fails validation with `"command" is required for stdio transport` and tears down every global MCP server for the session: the override is merged onto the raw global entry (keeping its command, URL, headers, and OAuth config) and may only set `enabled`, `lifecycle`, Pi's `exposure`, or `toolExposure` (the two exposure keys are accepted for Pi compatibility and ignored). An override for a name no global entry defines, or with any other key, is a config error naming the file and the server (#215).
- `enabled: false` in `mcp.json`, `.pi/mcp.json`, or a `pi.registerMcpServer()` config now keeps the server out of the eager set (normalized to `lifecycle: "lazy"`) even when `lifecycle: "eager"` is also set, and a non-boolean `enabled` is rejected at load time instead of being silently ignored (#215).
- Pi's `auth.provider` (`/login` provider token) is rejected with a `config` error at load time instead of being silently stripped and downgraded to OAuth 2.1 Dynamic Client Registration, which could register a client against a server the user never meant to authorize that way (#215).

## [1.11.0] - 2026-10-26

### Added
- `/mcp <name>` now explains a server instead of only printing its state: the config source (`global`, `project`, or `extension`), transport and lifecycle, `Tools: <active>/<discovered> active`, the OAuth credential summary for servers with an `auth` config, a single troubleshooting `Hint:` when the server failed (`/mcp:auth <name>` or `--reset` for authorization failures, auth-lock contention, or `PI_MCP_DEBUG=1 pi` plus the issue tracker for connection failures), and a note when the project's `.pi/mcp.json` was skipped because the project is untrusted. A corrupt stored OAuth state file is reported as backed up and never breaks the view (#196).
- `mcp_status` reports a `source` field (`global`, `project`, `extension`, or `unknown`) on every row, so an agent can tell a global entry from a project override or a `pi.registerMcpServer()` entry (#196).

## [1.10.2] - 2026-10-23

### Security

- Bump `zod` runtime dependency floor to `^4.6.7` (`GHSA-mrhx-c7xc-m3w5`) and update transitive lockfile dependencies `body-parser` to `2.4.0` (`GHSA-27r3-jxmh-p828`) and `fast-uri` to `3.1.9` (`GHSA-w74x-v6f9-j3xg`, `GHSA-xhq7-xmqj-769h`, `GHSA-wjr9-j795-jxcr`, `GHSA-333x-w4r6-6crp`).

## [1.10.1] - 2026-10-23

### Fixed

- Release tooling: the automated release now fetches the squash-merge commit of its release PR before creating the `vX.Y.Z` tag (the runner's clone has never seen that commit, so the tag previously failed after the merge and only the next run repaired it).
- Release tooling: the release PR's required checks are now satisfied by approving and awaiting the `pull_request` runs the PR itself records. The release PR is opened with `GITHUB_TOKEN`, so GitHub records those runs but never executes them (`action_required`), and `GITHUB_TOKEN` may not approve a workflow run — while check runs from a dispatched `workflow_dispatch` run never attach to the PR at all, so the first real release failed at the merge with "the base branch policy prohibits the merge". The approval uses the new `RELEASE_APPROVE_TOKEN` secret (a fine-grained PAT with Actions write access), and the wait watches exactly the run recorded on the pushed head, so a retried attempt can never accept an earlier attempt's checks.

## [1.10.0] - 2026-10-20

### Added
- Opt-in debug log: set `PI_MCP_DEBUG=1` to record the extension's own decisions (server state transitions, retries and backoff, OAuth token refresh, cross-process auth-lock contention, 401/403 classification, session reloads) as JSON Lines in `<agent dir>/logs/pi-mcp.log`. The directory is `0o700` and the file is `0o600`, the log is rotated to `pi-mcp.log.1` at ~2 MB, and only allow-listed field names are recorded — a final pass masks anything token-like (`access_token`, `refresh_token`, `client_secret`, `code=`, `code_verifier`, `Authorization:` / `Bearer …`). Without the environment variable no log file is created (#71).

### Changed
- The extension no longer writes diagnostics to Pi's stderr while a UI is active — that stream belongs to the TUI. Server output, reconnection notices, and OAuth events now go to the debug log (when enabled) or are dropped, and user-actionable events are surfaced as Pi notifications. Headless runs without a UI keep the stderr output they have always had — warnings, errors, and child-server output; new informational events (state transitions, token refresh, session lifecycle) are recorded only in the debug log (#71).

## [1.9.11] - 2026-10-19

### Changed
- Upgrade the `zod` runtime dependency from 3.x to `^4.6.5` (#95). Existing `mcp.json` configs load and validate exactly as before. Some config validation messages that come from Zod's built-in errors now use Zod 4 wording (e.g. `Invalid url` → `Invalid URL`, `Number must be greater than 0` → `Too small: expected number to be >0`). Messages that pi-mcp defines itself are unchanged.

## [1.9.10] - 2026-10-19

### Fixed
- Tighten `isOAuthUnauthorizedError` message-text fallback patterns so unrelated `: 401` and `Unauthorized` substrings in non-HTTP errors no longer trigger unwanted OAuth flows (#81).

## [1.9.9] - 2026-10-18

### Security
- Sanitize server-controlled text (`notifications/message` payloads, error messages, and status summaries) with `sanitizeTerminalText` to strip ANSI/OSC/DCS/C0/C1 escape sequences, collapse line breaks, and bound length before writing to `stderr`, log buffers, or `ctx.ui.notify(...)` (#66).

## [1.9.8] - 2026-10-18

### Security
- **OAuth authorization-server issuer binding (GHSA-6qxp-vccf-f47h)**: Require patched `@modelcontextprotocol/sdk` (`^1.32.1`) and persist the authorization server `issuer` property on stored client information and OAuth tokens. This prevents an untrusted or compromised MCP server from directing stored refresh tokens or client credentials to an arbitrary authorization server. Existing credentials saved prior to this fix remain valid and are stamped with their authorization server issuer on first use. Users who may have connected to untrusted MCP servers should revoke credentials and run `/mcp:auth <server> --reset` to force fresh client registration and re-authorization.

## [1.9.7] - 2026-10-17

### Fixed
- Detach the retry-backoff `abort` listener from the connection `AbortSignal` when the backoff timer fires normally so retries do not accumulate stale listeners (#67).

## [1.9.6] - 2026-10-17

### Security
- Validate OAuth callback state on both successful and error responses, preventing forged error callbacks from bypassing the state check.

### Fixed
- Tear down stale session state when a session reloads or config loading fails; refresh timeout settings and MCP roots when settings or the working directory change.
- Propagate cancellation through queued authorization, and coordinate and deduplicate startup OAuth prompts with manual authorization and stop requests.
- Accept `/mcp:auth --reset` with the flag before or after the server name, and report `/mcp:start` cancellations as informational rather than errors.

## [1.9.5] - 2026-10-17

### Security
- Sanitize stdio server output before logging or displaying it, stripping terminal control sequences and other unsafe characters.

### Fixed
- Apply effective request timeouts and cancellation signals to MCP operations, and keep health-check pings bounded and non-overlapping.
- Recover from unexpected SSE and Streamable HTTP disconnects, unblock SSE startup when closing, and surface failed recovery to the user.
- Use the session working directory for stdio servers and encoded MCP root URIs, and reliably terminate child processes after failed handshakes and shutdown.

## [1.9.4] - 2026-10-17

### Security
- Bind stored OAuth tokens, client information, and discovery state to the configured canonical server URL, preventing project configs that reuse a global server name at another URL from accessing or overwriting its credentials. Preserve Dynamic Client Registration authentication and redirect metadata, and validate client-secret expiry and registered redirects.

### Fixed
- Coordinate OAuth state writes and refresh-token rotation across processes; recover from stale locks and isolate corrupt per-server state.
- Recover from rejected credentials during connection, tool listing, and tool calls, including `403 insufficient_scope`; discover auth challenges when a server rejects `GET` with `405` and pass configured headers during authorization.

## [1.9.3] - 2026-10-17

### Fixed
- Improve JSON Schema compatibility for nullable and multi-type values, composed and empty objects, recursive `$ref`s, tuples, enums, and validation constraints, including schemas expected by Gemini and OpenAI.
- Prevent tool-name collisions within and across servers and discard stale concurrent tool refreshes; preserve structured tool results and empty resource text, reject already-aborted calls, and include prompt snippets in `mcp_status` and `mcp_connect`.

## [1.9.2] - 2026-10-17

### Fixed
- **JSONC Config Support & Load-Time Validation (#28)**: Strip `//` and `/* */` JSONC comments before parsing `mcp.json`, wrap read/parse errors in `McpError` with the offending file path, enforce `/^[a-zA-Z][a-zA-Z0-9_]*$/` on `toolPrefix`, validate `auth.redirectUrl` (and `callbackUrl`/`callbackPort` aliases) at load time, and reject `auth` on `stdio` servers.

## [1.9.1] - 2026-10-17

### Added
- Support Pi 1.x extension-registered MCP servers via `pi.getMcpServers()` and live `mcp_servers_change` updates when replacing `builtin:mcp`, while preserving `mcp.json` precedence (#17).
- Support Pi 1.x server configuration aliases: URL-only HTTP entries (defaulting `transport` to `"streamable-http"`), `type` / `transport: "http"`, `oauth` (`redirectUrl`, `callbackUrl`, `callbackPort`), and `timeout` in seconds (#17).

### Changed
- Migrate peer dependencies and type imports from deprecated `@mariozechner/*` packages to `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` (#17).

### Security
- Enforce Pi's project trust boundary: never read `<cwd>/.pi/mcp.json` during bootstrap or when `ctx.isProjectTrusted()` is `false` (#17).

## [1.9.0] - 2026-10-17

### Added
- Eager OAuth servers that need interactive authorization at startup now offer a sequential `Authorize now` / `Not now` prompt instead of failing silently (#7).

### Fixed
- Silent startup and background reconnects no longer trigger Dynamic Client Registration when no client credentials are stored, avoiding orphan OAuth client registrations.

## [1.8.0] - 2026-10-17

### Added
- Headless/SSH authorization: the authorization URL is shown in Pi, and a new "Paste redirect URL" option completes the flow when the local callback is unreachable.

### Security
- Only `https:` (or loopback `http:`) authorization URLs are passed to the system browser opener.

## [1.7.3] - 2026-10-17

### Fixed
- Automatically reclaim stale OAuth authorization locks (`<hash>.json.lock`) using PID liveness checks, a 30-second heartbeat (90-second staleness threshold), and nonce-verified atomic lock replacement, while verifying lock ownership before interactive credential writes.
- Keep PKCE `codeVerifier` in memory per authorization flow and allow silent token refresh (`saveTokens`) to persist rotated tokens even while an interactive lock is held, falling back to an in-memory token cache if disk writes fail.
- Persist OAuth state files atomically via temporary files and back up corrupt state files to `<hash>.json.corrupt-<timestamp>` with a configuration error instead of silently ignoring corruption.

## [1.7.2] - 2026-10-17

### Changed
- `auth.redirectUrl` must include an explicit port (e.g. `http://127.0.0.1:19876/callback`). Previously a missing port fell back to 80.

### Fixed
- The stdio server SIGKILL safety net now captures the child PID from `StdioClientTransport.pid`.
- `/mcp:auth <name> --reset` reports failures to delete credentials instead of claiming success.
- OAuth-configured servers that surface `UnauthorizedError` or HTTP 401 transport errors during connection fail fast with `AuthRequiredError` instead of retrying, allowing interactive authorization to proceed (#1).

## [1.7.1] - 2026-10-17

### Fixed
- Resolve the global `mcp.json` and `mcp-auth` storage directory through `$PI_CODING_AGENT_DIR` (with tilde expansion) when set, falling back to `~/.pi/agent` (#5, #6).
- Project `.pi/mcp.json` files now override only the `settings` keys they explicitly state instead of replacing global settings with schema defaults (#6).

## [1.7.0] - 2026-10-17

### Added
- `mcp_status` and `mcp_connect` agent tools for on-demand inspection and connection of configured MCP servers, verifying active tools before reporting readiness (#8).

## [1.6.0] - 2026-10-17

### Added
- Server-name argument autocomplete for `/mcp`, `/mcp:start`, `/mcp:stop`, and `/mcp:auth` (#3).

## [1.5.4] - 2026-10-16

### Fixed
- Filter non-text content blocks when an MCP tool call returns `isError: true` and add image passthrough tests (#9).

## [1.5.3] - 2026-10-16

### Fixed
- Pass through MCP image content blocks (`type: "image"`) to Pi tool results (#9).

## [1.5.2] - 2026-10-16

### Fixed
- Automatically deactivate tools and reconnect when an MCP server's transport closes unexpectedly (#10).

## [1.5.1] - 2026-10-04

### Changed
- **Behavior change:** `/mcp:auth <name>` now reuses stored credentials and opens the browser
  only if authorization is actually required. Use `/mcp:auth <name> --reset` for the previous
  behavior (discard stored credentials and re-authorize) (#4).
- Eager startup and background reconnection never open a browser. When interactive
  authorization is required, the server stops and reports how to authorize, without retrying (#4).
- Interactive authorization requires an interactive Pi session. Print/RPC modes fail promptly (#4).

### Added
- Protected-resource metadata and scope are discovered from the server's `WWW-Authenticate`
  challenge (#4).
- A configured loopback `redirectUrl` binds its exact host and port (#4).
- Retry/Cancel controls while authorization is pending. Concurrent connects and resets are coordinated (#4).
- Server names containing spaces are supported in `/mcp:auth` (#4).

### Fixed
- Stop, cancellation, and shutdown cancel pending retries, callbacks, and late readiness (#4).

### Removed
- The `MCP_OAUTH_CALLBACK_PORT` documentation. This variable was documented in 1.5.0 but was
  never implemented. Configure `auth.redirectUrl` with an explicit port instead (#4).

## [1.5.0] - 2026-05-03

### Added
- OAuth 2.1 support with PKCE, dynamic client registration, and `/mcp:auth`.
