/**
 * Stdio child-process supervision and stderr line decoding.
 *
 * Provides pure StringDecoder-based line splitting across chunk boundaries,
 * StdioClientTransport instrumentation (early PID capture, memoized close,
 * stderr wiring), descendant process-tree discovery for wrappers such as
 * `npx`, `uvx`, or `sh -c`, and deterministic SIGTERM → bounded wait → SIGKILL
 * cleanup with injectable process/timer dependencies.
 */

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type { ChildProcess } from "node:child_process";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);

// ─── Line Splitting ───────────────────────────────────────────────────────────

export interface LineSplitter {
  write(chunk: Buffer): void;
  /** Emit the decoded remainder without finalising the decoder (teardown paths). */
  flush(): void;
  /** Finalise the decoder (real EOF) and emit whatever is left. Idempotent. */
  end(): void;
}

/**
 * Create a pure UTF-8 `StringDecoder`-based line splitter with an idempotent `end()`.
 *
 * `flush()` and `end()` differ on purpose: `flush()` emits what has already been decoded and
 * leaves an incomplete UTF-8 sequence buffered inside the decoder, while `end()` is terminal
 * and replaces such a sequence with U+FFFD. Teardown uses `flush()` because bytes can still
 * arrive after a forced close, and finalising the decoder first would turn a character split
 * across that boundary into replacement characters.
 */
export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  const decoder = new StringDecoder("utf8");
  let remainder = "";
  let flushed = false;

  const emitRemainder = (): void => {
    if (!remainder) return;
    const trailing = remainder;
    remainder = "";
    onLine(trailing);
  };

  return {
    write(chunk: Buffer): void {
      flushed = false;
      remainder += decoder.write(chunk);
      const lines = remainder.split("\n");
      remainder = lines.pop() ?? "";
      for (const rawLine of lines) {
        onLine(rawLine);
      }
    },
    flush(): void {
      emitRemainder();
    },
    end(): void {
      if (flushed) return;
      flushed = true;
      remainder += decoder.end();
      emitRemainder();
    },
  };
}

// ─── Transport Instrumentation ────────────────────────────────────────────────

/** Grace window for an exited child's pipes to drain naturally before force-destroying them. */
const PIPE_DRAIN_GRACE_MS = 100;

interface StdioChildRecord {
  process: ChildProcess;
  closed: boolean;
  /** Flush the buffered partial stderr line before the pipe is destroyed. */
  flushStderr(): void;
}

/**
 * Child processes of instrumented transports, keyed by transport.
 *
 * WHY: `StdioClientTransport.close()` clears `_process` synchronously, so the child
 * handle is gone by the time teardown needs its pipes and its stderr flush. A WeakMap
 * keeps both reachable without pinning a closed transport in memory.
 */
const childRecords = new WeakMap<object, StdioChildRecord>();

export interface InstrumentStdioTransportOptions {
  onPid(pid: number): void;
  onStderrLine(line: string): void;
}

/**
 * Wrap a `StdioClientTransport` to capture its child PID as soon as it spawns,
 * memoize `close()` across duplicate calls, and wire `stderr` through
 * `createLineSplitter`.
 */
export function instrumentStdioTransport(
  transport: StdioClientTransport,
  { onPid, onStderrLine }: InstrumentStdioTransportOptions,
): void {
  // WHY: Capture child PID immediately when StdioClientTransport spawns the process
  // (before `initialize` is sent), so a timeout or cancellation during `initialize`
  // can still terminate the child process deterministically before retrying.
  const spawnedProcess = (): ChildProcess | undefined =>
    (transport as unknown as { _process?: ChildProcess })._process;

  let flushStderr: (() => void) | null = null;

  const recordProcess = (proc: ChildProcess | undefined): void => {
    if (!proc?.pid) return;
    if (!childRecords.has(transport)) {
      const record: StdioChildRecord = {
        process: proc,
        closed: false,
        flushStderr: () => flushStderr?.(),
      };
      proc.once?.("close", () => {
        record.closed = true;
      });
      childRecords.set(transport, record);
    }
    onPid(proc.pid);
  };

  const origStart = transport.start.bind(transport);
  transport.start = async () => {
    const startPromise = origStart();
    recordProcess(spawnedProcess());
    await startPromise;
    const proc = spawnedProcess();
    if (proc?.pid) {
      recordProcess(proc);
    } else if (transport.pid) {
      onPid(transport.pid);
    }
  };

  // WHY: Client.connect's catch block fires `void this.close()` without awaiting it,
  // which clears `this._process = undefined` synchronously on the first call. Memoize
  // transport.close() so our `await client.close()` awaits the actual close completion.
  let closePromise: Promise<void> | null = null;
  const origClose = transport.close.bind(transport);
  transport.close = () => {
    if (!closePromise) {
      // WHY: `StdioClientTransport.close()` never ends its `PassThrough` stderr stream — it only
      // waits (bounded) for the child's 'close' event. A descendant that inherited the stderr
      // write end keeps that event from ever firing, so a line written without a trailing
      // newline stays trapped in the splitter's remainder and never reaches the server log.
      // Flushing when close settles makes the transport boundary itself guarantee the child's
      // last words, instead of relying on every caller remembering `destroyStdioStreams()`.
      // Safe to flush here even if bytes are still in flight: `end()` is idempotent, and the
      // next `write()` re-opens the latch so the stream's own 'end'/'close' flushes the rest.
      closePromise = origClose().finally(() => flushStderr?.());
    }
    return closePromise;
  };

  if (transport.stderr) {
    const splitter = createLineSplitter(onStderrLine);
    transport.stderr.on("data", (chunk: Buffer) => {
      splitter.write(chunk);
    });
    // WHY: teardown flushes provisionally. Bytes written just before the child died can still be
    // in the pipe, so finalising the UTF-8 decoder here would corrupt a character split across
    // the boundary; the stream's own 'end'/'close' is what really finalises it.
    const flush = (): void => {
      splitter.flush();
    };
    flushStderr = flush;
    transport.stderr.on("end", () => splitter.end());
    transport.stderr.on("close", () => splitter.end());
  }
}

/**
 * Wait briefly for an exited child process to drain its stdio pipes and emit `'close'`
 * naturally before `destroyStdioStreams` force-destroys the parent's pipe read ends.
 *
 * WHY: On Windows, `process.stderr` is an overlapped named pipe whose final bytes can
 * still be in flight in libuv when `TerminateProcess` completes. Letting `'close'` fire
 * naturally preserves trailing stderr output when no grandchild holds the pipe open, while
 * bounding the wait to `PIPE_DRAIN_GRACE_MS` when a surviving grandchild keeps it open.
 */
export async function waitForChildClose(
  transport: object | null | undefined,
  timeoutMs = PIPE_DRAIN_GRACE_MS,
): Promise<void> {
  if (!transport) return;
  const record = childRecords.get(transport);
  if (!record || record.closed || typeof record.process.once !== "function") return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      record.process.removeListener?.("close", onClose);
      resolve();
    }, timeoutMs);
    const onClose = (): void => {
      clearTimeout(timer);
      resolve();
    };
    record.process.once("close", onClose);
  });
}

/**
 * Destroy the child's `stdout`/`stderr` pipes once the process tree is gone.
 *
 * WHY: A surviving grandchild (e.g. a server spawned by an `npx` wrapper) inherits the
 * wrapper's pipe write ends, so Node never emits `'close'` for the wrapper and
 * `StdioClientTransport.close()` burns its full 4000ms escalation budget waiting for the
 * `'close'` event. Destroying the parent's read ends lets `close()` resolve immediately
 * even when a descendant escaped the tree kill. `stdin` is left alone: it is our write
 * end and the SDK still ends it as part of its own close sequence.
 */
export function destroyStdioStreams(transport: object | null | undefined): void {
  if (!transport) return;
  const record = childRecords.get(transport);
  if (!record) return;
  childRecords.delete(transport);
  // WHY: Flush the buffered partial stderr line first. Destroying our read end keeps the
  // SDK's PassThrough from ever emitting 'end', so without this a forced teardown drops the
  // server's last words (the buffered remainder of a line with no trailing newline).
  record.flushStderr();
  record.process.stdout?.destroy();
  record.process.stderr?.destroy();
}

// ─── Descendant Discovery ─────────────────────────────────────────────────────

/**
 * Upper bound on tracked descendants.
 *
 * WHY: A wrapper that respawns children while we walk the tree could otherwise make
 * discovery unbounded; teardown only needs the tree as it stood when we snapshotted it.
 */
const MAX_DESCENDANTS = 256;

/** Read the direct child PIDs of `pid` from Linux `/proc`. */
async function readProcChildren(pid: number): Promise<number[]> {
  // WHY: /proc/<pid>/task/<tid>/children lists each thread's direct children, so a
  // multithreaded wrapper is covered without scanning every process in /proc.
  const taskDir = `/proc/${pid}/task`;
  const tids = await readdir(taskDir);
  const children: number[] = [];
  for (const tid of tids) {
    const raw = await readChildrenFile(`${taskDir}/${tid}/children`);
    for (const token of raw.split(/\s+/)) {
      if (token) children.push(Number(token));
    }
  }
  return children;
}

async function readChildrenFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    // WHY: A thread can exit between readdir() and readFile(), and a process that dies
    // mid-walk simply has no children left to report.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** Timeout for a single `ps` process-table snapshot on non-Linux POSIX systems. */
const PS_TIMEOUT_MS = 1_000;

/**
 * Read the full `ps` process table and index it as `parentPid → childPids`.
 *
 * WHY: macOS and other non-Linux POSIX systems have no `/proc`; `ps -A -o pid=,ppid=`
 * dumps the entire process table in one call so a single snapshot can serve the whole
 * tree walk without spawning `ps` once per node.
 */
async function readPsProcessTable(): Promise<Map<number, number[]>> {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid="], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: PS_TIMEOUT_MS,
  });
  return indexProcessTable(stdout);
}

/** Index `ps -A -o pid=,ppid=` output as a parent PID → child PIDs map. */
export function indexProcessTable(stdout: string): Map<number, number[]> {
  const childrenOf = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const childPid = Number(match[1]);
    const parentPid = Number(match[2]);
    const siblings = childrenOf.get(parentPid);
    if (siblings) {
      siblings.push(childPid);
    } else {
      childrenOf.set(parentPid, [childPid]);
    }
  }
  return childrenOf;
}

function createPlatformChildReader(): (pid: number) => Promise<number[]> {
  if (process.platform === "linux") return readProcChildren;
  if (process.platform === "win32") {
    // WHY: Windows has no `/proc` or `ps`, and the portable tree kill (`taskkill /T`)
    // must be driven by the caller's own signal semantics. Discovery reports nothing so
    // teardown falls back to killing the top-level PID plus destroying the pipes.
    return () => Promise.resolve([]);
  }
  let tablePromise: Promise<Map<number, number[]>> | null = null;
  return async (pid: number): Promise<number[]> => {
    tablePromise ??= readPsProcessTable();
    const childrenOf = await tablePromise;
    return childrenOf.get(pid) ?? [];
  };
}

/**
 * Snapshot the descendant PIDs of `pid`, deepest generation first.
 *
 * Returns `[]` when discovery is unavailable (Windows, containers without `ps` or
 * `/proc`), which leaves the caller's single-PID teardown intact.
 */
export async function listDescendantPids(
  pid: number,
  readChildren: (pid: number) => Promise<number[]> = createPlatformChildReader(),
): Promise<number[]> {
  try {
    const descendants = await walkDescendants(pid, readChildren);
    // Breadth-first order reversed: each generation is signalled before its parent, so a
    // wrapper cannot respawn or reap a child that is still being torn down.
    return descendants.reverse();
  } catch {
    // WHY: Discovery is best-effort by design: the PID can exit between the liveness check
    // and the `/proc` walk, and minimal containers ship neither `ps` nor `/proc`. A tree we
    // cannot read must never fail the caller's shutdown path — teardown still kills the
    // root PID and releases the inherited pipes.
    return [];
  }
}

async function walkDescendants(
  pid: number,
  readChildren: (pid: number) => Promise<number[]>,
): Promise<number[]> {
  const descendants: number[] = [];
  const seen = new Set<number>([pid]);
  const pending = await readChildren(pid);
  while (pending.length > 0 && descendants.length < MAX_DESCENDANTS) {
    const next = pending.shift();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    descendants.push(next);
    pending.push(...(await readChildren(next)));
  }
  return descendants;
}

// ─── Process Supervision ──────────────────────────────────────────────────────

export interface StdioProcessDeps {
  kill(pid: number, signal?: NodeJS.Signals | number): void | boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Snapshot descendant PIDs of `pid`, deepest first. Resolves `[]` when unavailable. */
  listDescendantPids(pid: number): Promise<number[]>;
}

const defaultDeps: StdioProcessDeps = {
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  listDescendantPids: (pid) => listDescendantPids(pid),
};

function resolveDeps(deps?: Partial<StdioProcessDeps>): StdioProcessDeps {
  if (!deps) return defaultDeps;
  return {
    kill: deps.kill ?? defaultDeps.kill,
    sleep: deps.sleep ?? defaultDeps.sleep,
    now: deps.now ?? defaultDeps.now,
    listDescendantPids: deps.listDescendantPids ?? defaultDeps.listDescendantPids,
  };
}

export function isPidAlive(
  pid: number,
  deps?: Partial<Pick<StdioProcessDeps, "kill">>,
): boolean {
  const kill = deps?.kill ?? defaultDeps.kill;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    return true;
  }
}

/** Send `signal` to one PID; `false` when the PID was already gone (ESRCH). */
function signalPid(pid: number, signal: NodeJS.Signals, d: StdioProcessDeps): boolean {
  try {
    d.kill(pid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    // WHY: EPERM and platform refusals mean this PID cannot be signalled (a recycled PID
    // or a sandboxed process). Teardown still has to signal the rest of the tree within
    // the bounded wait instead of rejecting the caller's shutdown path.
    return true;
  }
}

function allExited(pids: readonly number[], d: StdioProcessDeps): boolean {
  return pids.every((pid) => !isPidAlive(pid, d));
}

async function signalAndWaitForExit(
  pids: readonly number[],
  signal: NodeJS.Signals,
  timeoutMs: number,
  d: StdioProcessDeps,
): Promise<boolean> {
  const attempted = pids.map((pid) => signalPid(pid, signal, d));
  // Every target reported ESRCH: the tree is already gone, so there is nothing to wait for.
  if (!attempted.some(Boolean)) {
    return true;
  }

  const deadline = d.now() + timeoutMs;
  while (d.now() < deadline) {
    if (allExited(pids, d)) {
      return true;
    }
    await d.sleep(25);
  }

  return allExited(pids, d);
}

/**
 * Escalate to SIGKILL across the surviving tree.
 *
 * WHY: The wrapper can spawn new children while it ignores SIGTERM, so the tree is
 * re-snapshotted; the original snapshot still covers descendants of a wrapper that
 * already exited (they were re-parented to init and are no longer discoverable).
 */
async function escalateToSigkill(
  rootPid: number,
  descendants: readonly number[],
  d: StdioProcessDeps,
): Promise<void> {
  const rescanned = await d.listDescendantPids(rootPid);
  const survivors = [...new Set([...rescanned, ...descendants])].filter((candidate) =>
    isPidAlive(candidate, d),
  );
  const targets = [...survivors, rootPid].filter((candidate) => isPidAlive(candidate, d));
  if (targets.length === 0) return;
  await signalAndWaitForExit(targets, "SIGKILL", 200, d);
}

export async function ensurePidTerminated(
  pid: number | null | undefined,
  deps?: Partial<StdioProcessDeps>,
): Promise<void> {
  const d = resolveDeps(deps);
  if (!pid || !isPidAlive(pid, d)) {
    return;
  }

  // WHY: Snapshot before signalling any PID: a wrapper that exits first re-parents its
  // children to init, after which they can no longer be found by parent PID.
  const descendants = await d.listDescendantPids(pid);
  if (await signalAndWaitForExit([...descendants, pid], "SIGTERM", 500, d)) {
    return;
  }

  await escalateToSigkill(pid, descendants, d);
}
