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

/**
 * How long a closed transport's stderr stream must stay quiet before its unterminated remainder
 * is emitted.
 *
 * WHY: nothing ends the SDK's stderr `PassThrough` after close, so the last line has to be
 * released by us; waiting for silence instead of flushing each chunk keeps a line whole when its
 * bytes arrive across several ticks, and still surfaces the last one promptly.
 */
export const POST_CLOSE_FLUSH_DELAY_MS = 100;

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

/** A transport whose child stderr can be wired and whose `close()` can be wrapped. */
interface StderrCarrier {
  stderr?: unknown;
  close(): Promise<void>;
}

/**
 * Split a stdio transport's stderr into lines and make them survive `close()`.
 *
 * Returns the provisional flush that teardown paths call before destroying the pipes, or
 * `null` when the transport has no stderr stream to read.
 *
 * WHY: `StdioClientTransport.close()` never ends its stderr `PassThrough` — it only waits
 * (bounded) for the child's `'close'` event — and a descendant that inherited the stderr write
 * end keeps that event from firing. A line written without a trailing newline would then stay
 * in the splitter's remainder forever. Flushing when close settles, and again after
 * `POST_CLOSE_FLUSH_DELAY_MS` of silence for any chunks that arrive afterwards (nothing will
 * emit `'end'` to do it), keeps the child's last words.
 * Both flushes are provisional: they must not finalise the decoder, because the bytes of a
 * character can be split across the close boundary; only the stream's own `'end'`/`'close'`
 * finalises it.
 */
export function instrumentStderr(
  transport: StderrCarrier,
  onLine: (line: string) => void,
): (() => void) | null {
  const stream = transport.stderr as NodeJS.EventEmitter | null | undefined;
  if (!stream || typeof stream.on !== "function") return null;

  const splitter = createLineSplitter(onLine);
  let closed = false;
  let idleFlush: NodeJS.Timeout | null = null;
  const cancelIdleFlush = (): void => {
    if (idleFlush) {
      clearTimeout(idleFlush);
      idleFlush = null;
    }
  };
  const flush = (): void => {
    cancelIdleFlush();
    splitter.flush();
  };
  // WHY: after close settles nothing emits 'end', so a remainder nobody else will flush has to be
  // released — but a single chunk boundary is not the end of a line. Waiting for the stream to go
  // quiet keeps a line whose chunks straddle several ticks whole, while still surfacing the last
  // unterminated one within POST_CLOSE_FLUSH_DELAY_MS.
  const scheduleIdleFlush = (): void => {
    cancelIdleFlush();
    idleFlush = setTimeout(() => {
      idleFlush = null;
      splitter.flush();
    }, POST_CLOSE_FLUSH_DELAY_MS);
    idleFlush.unref();
  };

  stream.on("data", (chunk: Buffer) => {
    splitter.write(chunk);
    if (closed) scheduleIdleFlush();
  });
  const onStreamEnd = (): void => {
    cancelIdleFlush();
    splitter.end();
  };
  stream.on("end", onStreamEnd);
  stream.on("close", onStreamEnd);

  const origClose = transport.close.bind(transport);
  transport.close = (): Promise<void> =>
    origClose().finally(() => {
      closed = true;
      flush();
    });
  return flush;
}

export interface InstrumentStdioTransportOptions {
  onPid(pid: number): void;
  onStderrLine(line: string): void;
}

/**
 * Wrap a `StdioClientTransport` to capture its child PID as soon as it spawns,
 * memoize `close()` across duplicate calls, and wire `stderr` through `instrumentStderr`.
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

  // Wire stderr first: `instrumentStderr` wraps `close()` with the flush, and the memoization
  // below has to sit on top of that wrapper.
  const flushStderr = instrumentStderr(transport, onStderrLine);

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
      closePromise = origClose();
    }
    return closePromise;
  };
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

/** What one `kill(2)` attempt reported about a PID. */
type PidSignalOutcome =
  /** The signal was delivered: the PID resolves to a process this caller may signal. */
  | "signalled"
  /** ESRCH: nothing holds this PID any more. */
  | "gone"
  /** EPERM or another platform refusal: the PID is not this caller's to signal. */
  | "denied";

/**
 * POSIX liveness: a PID is alive while `kill(pid, 0)` fails with anything but ESRCH.
 *
 * WHY: EPERM means the PID is taken but belongs to a process this caller may not signal (a
 * recycled PID under another uid, a sandboxed child, PID 1). A caller that asks only whether the
 * PID is *occupied* must read that as occupied, not free; teardown asks the stricter
 * `isPidSignalable` instead. Auth-lock's staleness check needs this reading too and keeps its own
 * probe (`defaultIsPidAlive` in `src/auth-lock.ts`), so it does not call this one.
 */
export function isPidAlive(pid: number, deps?: Partial<Pick<StdioProcessDeps, "kill">>): boolean {
  return signalPid(pid, 0, resolveDeps(deps)) !== "gone";
}

function signalPid(
  pid: number,
  signal: NodeJS.Signals | number,
  d: StdioProcessDeps,
): PidSignalOutcome {
  try {
    d.kill(pid, signal);
    return "signalled";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return "gone";
    }
    // WHY: EPERM and platform refusals mean this PID cannot be signalled (a recycled PID
    // or a sandboxed process). Teardown still has to signal the rest of the tree within
    // the bounded wait instead of rejecting the caller's shutdown path.
    return "denied";
  }
}

/**
 * A PID this teardown can still act on: alive *and* signalable.
 *
 * WHY: a PID the caller cannot signal is not one a bounded wait can make progress on. `EPERM`
 * means no signal of ours reaches that PID — the child has exited and the PID was recycled to a
 * process under another uid, the child changed credentials (a wrapper that `setuid`s), or a
 * policy layer refuses the signal — so polling it re-reads the same `EPERM` every 25ms until
 * the timeout, and escalating to SIGKILL only buys a second refused signal.
 *
 * This answers "can we still reach it", never "is it our child": a PID recycled to another
 * process of the *same* uid stays signalable and is signalled, exactly as before this guard
 * existed. Identity would need the child's start time compared against `/proc/<pid>/stat`, and
 * the `ChildProcess` handle is gone by the time teardown runs.
 */
function isPidSignalable(pid: number, d: StdioProcessDeps): boolean {
  return signalPid(pid, 0, d) === "signalled";
}

function allExited(pids: readonly number[], d: StdioProcessDeps): boolean {
  return pids.every((pid) => !isPidSignalable(pid, d));
}

/**
 * Send `signal` to the PIDs that accept it, then wait only for those to exit.
 *
 * Resolves `true` when nothing that could still be running is left, which is what gates the
 * SIGKILL escalation. A PID that reported ESRCH is gone, and one that reported EPERM is not
 * ours to wait for — but it is not assumed dead either.
 */
async function signalAndWaitForExit(
  pids: readonly number[],
  signal: NodeJS.Signals,
  timeoutMs: number,
  d: StdioProcessDeps,
): Promise<boolean> {
  const attempts = pids.map((pid) => ({ pid, outcome: signalPid(pid, signal, d) }));
  const signalled = attempts.filter((a) => a.outcome === "signalled").map((a) => a.pid);
  const refused = attempts.filter((a) => a.outcome === "denied").map((a) => a.pid);

  // A window can only be ended by a signal that was actually delivered, so nothing is waited
  // for when nothing was. (The refused targets still decide the result below.)
  if (signalled.length > 0) {
    const deadline = d.now() + timeoutMs;
    while (d.now() < deadline && !allExited(signalled, d)) {
      await d.sleep(25);
    }
  }

  // WHY: a refused signal is not proof of a dead target. Permission is mediated per signal on
  // some systems — SELinux keeps separate `sigterm`/`sigkill` permissions, AppArmor matches a
  // signal set, and a seccomp filter can match the signal argument — so SIGTERM can be refused
  // while SIGKILL is allowed. A refused target that a liveness probe still finds signalable
  // therefore keeps the tree alive and sends the caller straight to the SIGKILL escalation,
  // without paying for a wait window this signal can never end; one that is no longer
  // signalable is out of reach (recycled to another uid, or the child changed credentials) and
  // counts as gone. ESRCH targets are never re-probed: that verdict is final, and re-probing a
  // recycled PID could sign it up for a SIGKILL it has nothing to do with.
  return allExited(signalled, d) && !refused.some((pid) => isPidSignalable(pid, d));
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
    isPidSignalable(candidate, d),
  );
  const targets = [...survivors, rootPid].filter((candidate) => isPidSignalable(candidate, d));
  if (targets.length === 0) return;
  await signalAndWaitForExit(targets, "SIGKILL", 200, d);
}

export async function ensurePidTerminated(
  pid: number | null | undefined,
  deps?: Partial<StdioProcessDeps>,
): Promise<void> {
  const d = resolveDeps(deps);
  if (!pid) return;
  const root = signalPid(pid, 0, d);
  // WHY: ESRCH is the only verdict that says the PID is free — nothing to snapshot, nothing to
  // signal. EPERM does not describe the tree: the root may be out of reach while descendants
  // are ours (a privileged wrapper that dropped to our uid for the real server), so they are
  // still signalled below.
  if (root === "gone") return;

  // WHY: Snapshot before signalling any PID: a wrapper that exits first re-parents its
  // children to init, after which they can no longer be found by parent PID. The snapshot runs
  // even for an out-of-reach root, because that root may still own signalable descendants.
  const descendants = await d.listDescendantPids(pid);
  const targets = descendants.filter((candidate) => isPidSignalable(candidate, d));
  // WHY: a root nobody can signal is skipped as a target — no wait window can end it — but it
  // must not hide the descendants that a signal can still reach.
  if (root === "signalled") targets.push(pid);
  if (targets.length === 0) return;

  if (await signalAndWaitForExit(targets, "SIGTERM", 500, d)) return;

  await escalateToSigkill(pid, descendants, d);
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

/**
 * The PID to tear down for a stdio transport, from the most to the least authoritative source.
 *
 * WHY: `server.childPid` is normally set at spawn time, but it is not the only place the PID
 * can come from — the instrumented record outlives `_process` (which
 * `StdioClientTransport.close()` clears synchronously), and a transport we never instrumented
 * still exposes `pid`. Resolving all of them in one place is what keeps a connect cleanup and a
 * shutdown from disagreeing about which process they own.
 */
export function resolveTransportPid(
  recordedPid: number | null | undefined,
  transport: object | null | undefined,
): number | null {
  if (typeof recordedPid === "number") return recordedPid;
  if (!transport) return null;
  const record = childRecords.get(transport);
  // WHY: a record outlives its child — 'close' only sets `closed` — and a released PID can be
  // recycled to an unrelated process, which teardown would then signal. `_process` and the
  // `pid` getter both disappear when the child exits, so only the record needs the guard.
  const recordedChildPid = record && !record.closed ? record.process.pid : undefined;
  const internal = (transport as { _process?: { pid?: number } })._process;
  const exposed = (transport as { pid?: unknown }).pid;
  return recordedChildPid ?? internal?.pid ?? (typeof exposed === "number" ? exposed : null);
}

/**
 * Terminate the stdio child process tree, then release the child's pipe handles.
 *
 * WHY: `client.close()` waits for the child's `'close'` event, which never fires while a
 * leaked grandchild still holds the inherited stdout/stderr write ends — the SDK then
 * burns its full 2 × 2,000ms escalation budget. Killing the tree first and destroying the
 * pipes afterwards keeps teardown bounded even if a descendant escaped the tree kill.
 */
export async function terminateStdioTree(
  pid: number | null,
  transport: object | null | undefined,
  deps?: Partial<StdioProcessDeps>,
): Promise<void> {
  try {
    await ensurePidTerminated(pid, deps);
    await waitForChildClose(transport);
  } finally {
    destroyStdioStreams(transport);
  }
}
