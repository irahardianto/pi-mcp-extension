# Architecture

A behavioral overview of how the pi-mcp-extension runtime fits together. This page
describes **responsibilities and flows**, not file names — the module that owns each
piece is listed in the [AGENTS.md Repository map](../AGENTS.md#repository-map). Class and
function names are used directly; everything here is checked against the current `main`
branch, and the invariants called out in [AGENTS.md](../AGENTS.md) are cited where they
apply.

The extension has no build step: Pi loads the entry module as TypeScript directly. The
entry wires four collaborators — a **connection coordinator**, a **server manager**, a
**tool bridge**, and an **OAuth provider** — around the Pi `ExtensionAPI`. Configuration,
credentials, and child processes are the only places that touch the filesystem, the
network, the clock, or PIDs; policy and transforms stay as pure functions.

---

## 1. Big picture

```mermaid
flowchart TD
    Pi["Pi coding agent<br/>(TUI / RPC, ExtensionAPI)"]

    subgraph Entry["Extension entry (default export)"]
        Coord["ConnectionCoordinator<br/>in-flight connects, authQueue, startup prompts, teardown"]
        Bridge["ToolBridge<br/>discovery, naming, activation"]
    end

    Mgr["ServerManager<br/>per-server lifecycle"]
    Tp["Transport factory<br/>stdio / streamable-http / sse"]
    Provider["McpOAuthProvider<br/>silent and interactive"]
    Cb["CallbackServer<br/>loopback /callback"]

    Registry["Pi tool registry"]
    State[("OAuth state<br/>hash.json")]
    Lock[("Cross-process lock<br/>hash.json.lock")]
    Servers["MCP servers"]

    Pi <-->|session events and tools| Entry
    Coord --> Mgr
    Mgr --> Tp
    Mgr --> Bridge
    Tp --> Servers
    Tp --> Provider
    Provider <--> State
    Provider <--> Lock
    Provider --> Cb
    Bridge <--> Registry
```

- The **entry** loads config, constructs the four collaborators, and registers
  `session_start` / `mcp_servers_change` / `session_shutdown`, the `/mcp*` commands, and
  the `mcp_status` / `mcp_connect` tools. It registers them even when bootstrap config
  loading fails, so a later `session_start` in another directory can still load a valid
  project config.
- **ServerManager** owns one 3-state lifecycle per configured server and hands each
  connection to a transport built by the **transport factory**.
- **ToolBridge** turns `tools/list` into Pi tools and keeps them active/inactive as the
  server connects and disconnects.
- **McpOAuthProvider** is the SDK `OAuthClientProvider`. It reads and writes per-server
  state on disk and is serialized against other Pi processes by a lock file. The
  **CallbackServer** is a loopback HTTP listener used only by the interactive flow.

---

## 2. Server lifecycle

Each server is one of `stopped`, `starting`, or `ready`. `startServer()` moves it to
`starting` and runs `_connect()`; readiness means the MCP handshake **and** `tools/list`
discovery both succeeded, not just the handshake.

```mermaid
stateDiagram-v2
    [*] --> stopped

    stopped --> starting : "startServer() / background recovery"
    starting --> ready : "handshake + tools/list discovery"
    starting --> starting : "retry after fixed delay (1s 3s 5s 10s 30s)"
    starting --> stopped : "fail: config or protocol"
    starting --> stopped : "auth-required (raise AuthRequiredError)"
    starting --> stopped : "give-up: retries exhausted"
    starting --> stopped : "cancelled (stop / abort / reload)"
    ready --> ready : "tools/list_changed refresh"
    ready --> starting : "onclose / onerror / health-check failure (_recover)"
    ready --> stopped : "stop / abort / reload (_shutdown)"

    note right of starting
        Invariant: server.attempt is cleared in
        startServer's finally, and the coordinator's
        connectAttempts entry is cleared in the
        attempt's finally; _shutdown clears both.
    end note
```

Failure handling is classified by a pure `classifyConnectFailure()` before it decides
what to do:

- **cancelled** — an `AbortSignal` fired or an `AuthCancelledError`; rethrow, no retry.
- **retry-corrupt-state** — the OAuth state file was corrupt and already backed up and
  removed by the provider; retry once immediately without consuming a retry slot.
- **auth-required** — `AuthRequiredError`, or a genuine 401 (during `initialize` and
  `tools/list`) / 403 `insufficient_scope`; invalidates stale tokens when applicable and
  raises `AuthRequiredError` so the coordinator can offer interactive authorization.
- **fail** — a fast-fail `config` or `protocol` `McpError`; no retry.
- **give-up** — `retryCount >= maxRetries`; wrap in an `McpError` (`timeout` or
  `connection`).
- **retry** — wait `RETRY_DELAYS_MS[retryCount]` (capped at the last entry) and reconnect.

While `ready`, three independent recovery paths exist:

- `notifications/tools/list_changed` → `ToolBridge.refreshTools()` re-registers the
  server's tools and deactivates ones the server no longer advertises.
- an opt-in **health check** timer pings at `healthCheckIntervalMs`; pings never overlap,
  each is time-bounded by the effective timeout, and a failure triggers `_recover()`.
- an unexpected transport close (`client.onclose`) or a stream error (`client.onerror`)
  triggers `_recover()`; deliberate closes abort the signal first and are ignored.

`_recover()` shuts the server down, bumps its `generation`, and reconnects on a
microtask; the generation guard prevents a stop during cleanup from being resurrected.
`_shutdown()` aborts the controller, clears the retry and health timers, resets `state`,
deactivates tools, closes the client, and — for stdio — runs
`ensurePidTerminated()` (SIGTERM → bounded wait → SIGKILL).

---

## 3. Session events

`session_start` runs once per session switch and distinguishes a first start from a
reload by comparing the freshly loaded config against the in-memory one.

```mermaid
sequenceDiagram
    autonumber
    participant Pi as Pi
    participant Entry as Extension entry
    participant Cfg as Config loader
    participant Coord as Coordinator
    participant Mgr as ServerManager
    participant Bridge as ToolBridge
    participant CB as CallbackServer

    Note over Pi,CB: Phase A — session_start (first start or reload)
    Pi->>Entry: session_start(ctx)
    Entry->>Coord: setActiveContext(ctx)
    Entry->>Cfg: loadConfig(cwd, globalPath, includeProjectConfig = isProjectTrusted())
    Cfg-->>Entry: merged McpConfig or McpError
    alt config invalid
        Entry->>Coord: teardown(ctx)
        Entry->>Mgr: rebuildServers(empty defaults)
        Entry->>Coord: startEagerServers(eager, ctx)
    else config changed
        Entry->>Coord: teardown(ctx)
        Entry->>Bridge: updateSettings(settings)
        Entry->>Mgr: rebuildServers(new config)
        Entry->>Coord: startEagerServers(eager, ctx)
    else config identical
        Entry->>Mgr: updateCwd(ctx.cwd)
        Entry->>Coord: syncStatus(ctx)
        Entry->>Coord: startEagerServers(eager, ctx)
    end

    Note over Pi,CB: Phase B — mcp_servers_change (dynamic registration)
    Pi->>Entry: mcp_servers_change(servers)
    Entry->>Coord: setActiveContext(ctx)
    Entry->>Entry: collectRegisteredServers(entries, fileConfig)
    loop removed or changed servers
        Entry->>Coord: cancelServer(name)
        Entry->>Bridge: removeServer(name)
        Entry->>Mgr: removeServer(name)
    end
    loop newly added servers
        Entry->>Mgr: setServer(name, cfg)
    end
    Entry->>Coord: startEagerServers(addedEager, ctx)

    Note over Pi,CB: Phase C — session_shutdown
    Pi->>Entry: session_shutdown(ctx)
    Entry->>Coord: teardown(ctx, removeServers = false)
    Coord->>Coord: abort startup prompts and in-flight attempts
    Coord->>CB: stop()
    Coord->>Bridge: deactivateServer(name) per server
    Coord->>Mgr: shutdownAll()
    Entry->>Coord: setActiveContext(undefined)
```

Key behaviors:

- **Project trust.** `includeProjectConfig` is `ctx.isProjectTrusted()` on
  `session_start`; bootstrap and untrusted projects never read `<cwd>/.pi/mcp.json`.
- **Invalid config** still tears down the previous session's servers, tools, prompts,
  and status, then rebuilds from empty defaults rather than leaving stale state active.
- **Config changed** tears everything down, applies `ToolBridge.updateSettings`, and
  rebuilds the server map from the new config.
- **Config identical** still refreshes roots: `ServerManager.updateCwd()` notifies ready
  servers whose `cwd` changed (root URIs are `pathToFileURL(cwd).href`) and re-syncs the
  status footer.
- **`mcp_servers_change`** reconciles dynamically registered servers: removed/changed
  ones are cancelled and dropped; new ones are added and started eagerly if configured.
- **Teardown** (`coordinator.teardown`) aborts startup prompts, aborts and awaits in-flight
  connect attempts, stops the callback server, deactivates (session reload) or removes
  (config change) each server's tools, and calls `shutdownAll()`. `session_shutdown`
  passes `removeServers: false` so tools stay registered but inactive.

---

## 4. Connect and auth coordination

The coordinator serializes the concurrency-sensitive parts: concurrent connect requests
join one in-flight attempt (a `--reset` supersedes a normal connect and shares one
pending reset), and interactive OAuth runs one server at a time through a promise-chain
`authQueue`.

```mermaid
sequenceDiagram
    autonumber
    participant Caller as mcp_connect / /mcp:auth / eager start
    participant Coord as Coordinator
    participant Queue as authQueue
    participant Mgr as ServerManager
    participant Authz as authorize()
    participant CB as CallbackServer
    participant Ui as Pi UI

    Caller->>Coord: connect(name, ctx)
    alt existing in-flight attempt with same reset state
        Coord-->>Caller: join existing attempt
    else reset supersedes a normal connect
        Coord->>Mgr: abort + stopServer()
    end

    alt reset requested
        Coord->>Bridge: deactivateServer(name)
        Coord->>Mgr: stopServer(name)
    else normal connect
        Coord->>Mgr: startServer(name, cwd)  [silent]
        Mgr-->>Coord: AuthRequiredError
    end

    alt no UI available
        Coord-->>Caller: AuthRequiredError
    else interactive session
        Coord->>Queue: enqueue serialized auth turn
        alt eager startup prompt pending
            Queue->>Ui: select "name needs authorization" [Authorize now / Not now]
            alt Not now
                Ui-->>Coord: decline remembered + status hint
            else Authorize now
                Ui-->>Coord: proceed
            end
        end
        Queue->>Authz: authorize(name, ctx, signal, reset)
        Authz->>CB: ensure(loopback callback)
        Authz->>Ui: open browser or paste redirect URL
        CB-->>Authz: validated code and state
        Authz-->>Coord: tokens persisted
        Coord->>Mgr: startServer(name, cwd)  [reconnect]
        Mgr-->>Coord: ready and tools activated
    end
```

Details:

- A silent connect never opens a browser or runs Dynamic Client Registration. If it
  ends in `AuthRequiredError` and the server is configured for OAuth, the coordinator
  offers interactive authorization.
- Interactive authorization goes through `authorize()`, which acquires the auth lock,
  optionally `--reset`s credentials, starts the callback server, generates the CSRF
  state, discovers the protected-resource challenge, and drives the SDK `auth()` flow.
  See [OAUTH.md](../OAUTH.md) for the browser and paste-back details.
- Eager OAuth servers that need authorization during `session_start` are queued behind
  `authQueue` and prompt sequentially (`Authorize now` / `Not now`) in an interactive
  session. Choosing **Not now** records the decline for the rest of the session and
  leaves a `run /mcp:auth <name>` status hint.
- `cancelServer()` aborts the startup prompt and the in-flight attempt; an aborted
  waiter wakes immediately and rejects with `AuthCancelledError` without breaking the
  queue for later waiters.

---

## 5. Config loading and project trust

```mermaid
flowchart TD
    Start["loadConfig(cwd, globalPath, includeProjectConfig)"]
    Trust{"includeProjectConfig?"}
    Global["Read hashless global mcp.json as JSONC<br/>(agentDir: PI_CODING_AGENT_DIR or ~/.pi/agent)"]
    Project["Read cwd/.pi/mcp.json as JSONC"]
    Skip["Project config skipped<br/>(bootstrap or untrusted project)"]
    GParse{"Global validates?"}
    PParse{"Project validates?"}
    Merge["Merge: project settings override only stated keys;<br/>a project server entry replaces the global one by name"]
    Empty["Empty valid config (no files present)"]
    Config["Validated McpConfig"]
    Err["McpError config with file path"]

    Start --> Trust
    Trust -->|false| Skip
    Trust -->|true| Project
    Start --> Global
    Global --> GParse
    GParse -->|no| Err
    GParse -->|yes| Merge
    Project --> PParse
    PParse -->|no| Err
    PParse -->|yes| Merge
    Skip --> Merge
    Merge --> Config
```

Behavior:

- **Bootstrap** calls `loadConfig()` with `includeProjectConfig: false`, so the global
  file is read but a project file never is, before trust is resolved.
- **`session_start`** sets `includeProjectConfig` from `ctx.isProjectTrusted()`.
- **JSONC.** `//` and `/* ... *` comments are stripped in a single pass that preserves
  newlines, so `JSON.parse` error messages keep accurate line numbers.
- **Merge.** Project `settings` override only the keys they state (project settings
  carry no defaults), and a project server entry replaces the global entry with the same
  name entirely. There is no deep merge and **no `${VAR}` interpolation** — config is
  WYSIWYG.
- **Pi 1.x aliases** are normalized before validation: `type` → `transport`, `"http"` →
  `"streamable-http"`, `oauth` → `auth`, and `timeout` (seconds) → `requestTimeoutMs`.
  Defaults: `transport` is `stdio` (or `streamable-http` when `url` is set), `lifecycle`
  is `lazy` (eager for extension-registered servers unless `enabled: false`),
  `toolPrefix` is `mcp`, `requestTimeoutMs` is `30000`, and `maxRetries` is `5`.
- **Load-time validation.** `toolPrefix` must match `^[a-zA-Z][a-zA-Z0-9_]*$`; `auth` is
  rejected on `stdio`; `auth.redirectUrl` (including the `callbackUrl` / `callbackPort`
  aliases) is validated when the config loads; `stdio` requires `command` and URL-based
  transports require `url`. Failures are `McpError` of kind `config` and include the file
  path.
- **Extension-registered servers** from `pi.registerMcpServer()` are collected on
  bootstrap and on every `mcp_servers_change`; a same-named `mcp.json` entry takes
  precedence.

---

## 6. Credential storage

OAuth credentials are stored per server, keyed by a hash of the server name, inside the
auth directory (`<agent dir>/mcp-auth/`, or `<storageDir>` when injected). The state file
is `<hash>.json`; the interactive lock is `<hash>.json.lock`.

```mermaid
flowchart TD
    subgraph WritePath["Write path — saveState and acquireAuthLock"]
        W1["loadState: validate schema, compare stored serverUrl to expected"]
        W2{"Another process holds<br/>hash.json.lock?"}
        W3["acquireAuthLock: create 0600 with pid, hostname, nonce, createdAt"]
        W4["30s heartbeat touches mtime; stale if mtime over 90s or same-host PID is dead"]
        W5["write temp file 0600 then rename; chmod dir 0700 and file 0600"]
        W6["AuthLockError, caller retries later"]
        W1 --> W2
        W2 -->|yes| W4
        W2 -->|no| W3
        W4 -->|stale| W3
        W4 -->|not stale| W6
        W3 --> W5
    end

    subgraph ReadPath["Read path — loadState"]
        R1["read hash.json"]
        R2{"stored serverUrl matches expected?"}
        R3["return state: clientInfo, tokens, discoveryState"]
        R4["return empty state; another origin is never reused"]
        R5{"parse or validate fails?"}
        R6["rename to hash.json.corrupt-timestamp and raise McpError config"]
        R1 --> R2
        R2 -->|yes| R5
        R2 -->|no| R4
        R5 -->|yes| R6
        R5 -->|no| R3
    end

    Tokens["Single-use refresh: reload from disk before invalidating; if a peer already rotated tokens, adopt them instead of deleting"]
```

Behavior:

- **Origin binding.** The state file records a canonical `serverUrl`. `loadState()`
  returns an empty state when the stored URL does not match the configured URL, so a
  project server that reuses a global server's name cannot inherit its tokens. A legacy
  file without `serverUrl` is also checked against the cached resource metadata.
- **Authorization-server binding.** The SDK's `issuer` is persisted and returned
  unchanged (including in silent mode and peer reloads); a stamped client is never
  re-bound to another issuer, and a config-supplied `client_secret` is never written to
  disk.
- **File safety.** Directories are created and forced to `0700`; files are written `0600`
  via a temp file plus `rename` (atomic on the same filesystem) and re-`chmod`ed.
- **Corrupt files.** A state file that fails schema validation is renamed to
  `<hash>.json.corrupt-<timestamp>` and raises an `McpError` of kind `config`; callers
  retry once so OAuth can proceed cleanly. A corrupt file for one server never breaks
  `mcp_status` for the others.
- **Interactive lock.** The lock file is created with `wx` and `0600` and holds a
  versioned JSON record (`pid`, `hostname`, `nonce`, `createdAt`). A 30s heartbeat
  updates its `mtime`; a lock is stale when the heartbeat is older than 90s or when it
  is on the same host and its PID is dead. Reclamation renames the candidate aside,
  verifies the nonce, then deletes it or restores a contender's fresh lock. A held lock
  that is lost mid-flow aborts the authorization with a retry error.
- **Refresh tokens are single-use.** Before invalidating tokens, the silent path reloads
  them from disk once: if a peer process already rotated them, it adopts the peer's
  tokens instead of deleting them. Interactive writes are coordinated through the lock.

---

## See also

- [AGENTS.md Repository map](../AGENTS.md#repository-map) — which module owns what.
- [OAUTH.md](../OAUTH.md) — the user-facing OAuth flow and troubleshooting.
- [README.md](../README.md) — configuration, commands, and MCP spec compliance.
