/**
 * Synchronous process-level `SIGINT` / `exit` safety net for live stdio child trees.
 *
 * In headless Pi modes (`--mode rpc`, `--mode json`, `--print`), Pi binds graceful
 * shutdown only to `SIGTERM` and `SIGHUP`. When `SIGINT` arrives with no active host
 * handler, Node exits via default `SIGINT` disposition without firing `session_shutdown`.
 * This module tracks live stdio root PIDs and terminates their process trees synchronously
 * when unhandled `SIGINT` or unexpected `exit` fires, while yielding to active host
 * handlers (such as interactive TUI `Ctrl+Z` suspend) and ignoring passive `signal-exit`
 * wrappers.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const MAX_DESCENDANTS = 256;
const PS_SYNC_TIMEOUT_MS = 250;
const TASKKILL_TIMEOUT_MS = 500;
const SIGNAL_EXIT_V4_SYMBOL = Symbol.for("signal-exit emitter");

export interface SignalExitProcess {
  pid: number;
  on(event: "SIGINT", listener: () => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
  off(event: "exit", listener: (code: number) => void): unknown;
  listenerCount(event: "SIGINT" | "exit"): number;
  kill(pid: number, signal?: NodeJS.Signals | number): boolean;
  exit(code?: number): never;
  __signal_exit_emitter__?: unknown;
  [key: symbol]: unknown;
}

export interface SyncTreeTerminationDeps {
  platform: NodeJS.Platform;
  kill: (pid: number, signal?: NodeJS.Signals | number) => void | boolean;
  spawnSync: typeof spawnSync;
  listDescendantPidsSync: (pid: number) => number[];
}

export interface StdioExitGuardDeps {
  proc: SignalExitProcess;
  globalScope?: unknown;
  terminatePidTreeSync: (pid: number) => void;
}

function readPositiveCount(holder: unknown): number {
  const count = (holder as { count?: unknown } | undefined)?.count;
  return typeof count === "number" && Number.isInteger(count) && count > 0 ? count : 0;
}

function resolveGlobalScope(proc: unknown, globalScope?: unknown): unknown {
  if (globalScope !== undefined) return globalScope;
  return proc === process ? globalThis : undefined;
}

/**
 * Count passive `signal-exit` v3/v4 `SIGINT` listeners attached to `proc`.
 *
 * WHY: Pi 1.3.0 bundles `signal-exit` v3 (via `proper-lockfile`), which stores its emitter on
 * `process.__signal_exit_emitter__`, while `signal-exit` v4 stores its emitter on
 * `globalThis[Symbol.for("signal-exit emitter")]`. Both register passive `SIGINT` listeners
 * that only act when `listeners.length === count`. Subtracting those passive wrappers lets our
 * guard detect whether an active host handler (such as Pi TUI's `Ctrl+Z` `ignoreSigint`) owns
 * `SIGINT` without deadlocking in headless `rpc`/`json`/`print` modes.
 */
export function countPassiveSigintListeners(proc: unknown, globalScope?: unknown): number {
  if (!proc || typeof proc !== "object") return 0;
  const v3 = (proc as { __signal_exit_emitter__?: unknown }).__signal_exit_emitter__;
  const scope = resolveGlobalScope(proc, globalScope);
  const v4 =
    scope && typeof scope === "object"
      ? (scope as Record<symbol, unknown>)[SIGNAL_EXIT_V4_SYMBOL]
      : undefined;
  return readPositiveCount(v3) + readPositiveCount(v4);
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

function readTaskIdsSync(taskDir: string): string[] {
  try {
    return readdirSync(taskDir);
  } catch {
    // WHY: Best-effort sync /proc walk during signal/exit; a child can exit before its task dir is read.
    return [];
  }
}

function readChildrenFileSync(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // WHY: Best-effort sync /proc walk during signal/exit; a thread or process can exit mid-walk.
    return "";
  }
}

function readProcChildrenSync(pid: number): number[] {
  const taskDir = `/proc/${pid}/task`;
  const tids = readTaskIdsSync(taskDir);
  const children: number[] = [];
  for (const tid of tids) {
    const raw = readChildrenFileSync(`${taskDir}/${tid}/children`);
    for (const token of raw.split(/\s+/)) {
      const childPid = Number(token);
      if (token && Number.isInteger(childPid) && childPid > 0) {
        children.push(childPid);
      }
    }
  }
  return children;
}

function readPsProcessTableSync(): Map<number, number[]> {
  try {
    const stdout = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: PS_SYNC_TIMEOUT_MS,
    });
    return indexProcessTable(stdout);
  } catch {
    // WHY: Best-effort sync discovery during signal/exit; cache an empty table so one missing or
    // slow `ps` does not stall remaining roots, which still receive SIGTERM directly.
    return new Map();
  }
}

function createSyncChildReader(platform: NodeJS.Platform = process.platform): (pid: number) => number[] {
  if (platform === "linux") return readProcChildrenSync;
  if (platform === "win32") return () => [];
  let table: Map<number, number[]> | null = null;
  return (pid: number): number[] => {
    table ??= readPsProcessTableSync();
    return table.get(pid) ?? [];
  };
}

function readChildrenSafe(pid: number, readChildren: (pid: number) => number[]): number[] {
  try {
    return readChildren(pid);
  } catch {
    // WHY: Best-effort sync discovery during signal/exit; one exited child must not abort sibling discovery.
    return [];
  }
}

function walkDescendantsSync(pid: number, readChildren: (pid: number) => number[]): number[] {
  const descendants: number[] = [];
  const seen = new Set<number>([pid]);
  const pending = [...readChildrenSafe(pid, readChildren)];
  while (pending.length > 0 && descendants.length < MAX_DESCENDANTS) {
    const next = pending.shift();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    descendants.push(next);
    pending.push(...readChildrenSafe(next, readChildren));
  }
  return descendants;
}

/**
 * Synchronously snapshot descendant PIDs of `pid`, deepest generation first.
 * Used during `SIGINT` / `exit` cleanup where async awaits cannot run.
 */
export function listDescendantPidsSync(
  pid: number,
  readChildren?: (pid: number) => number[],
  platform: NodeJS.Platform = process.platform,
): number[] {
  const reader = readChildren ?? createSyncChildReader(platform);
  return walkDescendantsSync(pid, reader).reverse();
}

function trySignalSync(
  pid: number,
  signal: NodeJS.Signals,
  kill: SyncTreeTerminationDeps["kill"],
): void {
  try {
    kill(pid, signal);
  } catch {
    // WHY: Best-effort teardown during SIGINT/exit; ESRCH/EPERM must not abort sibling cleanup.
  }
}

function killWindowsTreeSync(
  pid: number,
  runSpawnSync: typeof spawnSync,
  kill: SyncTreeTerminationDeps["kill"],
): void {
  try {
    const result = runSpawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: TASKKILL_TIMEOUT_MS,
    });
    if (!result.error) return;
  } catch {
    // WHY: Fall back to signalling the root PID if taskkill cannot be spawned.
  }
  trySignalSync(pid, "SIGTERM", kill);
}

/**
 * Synchronously signal a stdio child process tree (`SIGTERM` deepest-first on POSIX,
 * `taskkill /T /F` with `SIGTERM` fallback on Windows).
 */
export function terminatePidTreeSync(
  pid: number,
  deps?: Partial<SyncTreeTerminationDeps>,
): void {
  const platform = deps?.platform ?? process.platform;
  const kill = deps?.kill ?? ((target, signal) => process.kill(target, signal));
  if (platform === "win32") {
    killWindowsTreeSync(pid, deps?.spawnSync ?? spawnSync, kill);
    return;
  }
  const listDescendants =
    deps?.listDescendantPidsSync ??
    ((root: number) => listDescendantPidsSync(root, undefined, platform));
  const targets = [...listDescendants(pid), pid];
  for (const target of targets) {
    trySignalSync(target, "SIGTERM", kill);
  }
}

function isValidPositivePid(pid: number | null | undefined): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

/**
 * Reference-counted process-level `SIGINT` / `exit` safety net for live stdio root PIDs.
 *
 * Listeners are attached only while at least one live stdio PID is tracked, and detached
 * immediately when the last PID stops or exits so tests and `/reload` leak no listeners.
 */
export class StdioExitGuard {
  private readonly pids = new Set<number>();
  private readonly proc: SignalExitProcess;
  private readonly globalScope: unknown;
  private readonly customKillTreeSync: ((pid: number) => void) | undefined;
  private attached = false;

  private readonly onSigint = (): void => {
    // WHY: Yield whenever Pi (e.g. interactive-mode handleCtrlZ's ignoreSigint) or another
    // active listener owns SIGINT; ignore passive signal-exit wrappers so headless rpc/json/print
    // modes do not deadlock when both listeners are present.
    const otherActive =
      this.proc.listenerCount("SIGINT") -
      1 -
      countPassiveSigintListeners(this.proc, this.globalScope);
    if (otherActive > 0) return;
    this.terminateAll();
    this.reRaiseSigint();
  };

  private readonly onExit = (): void => {
    this.terminateAll();
  };

  constructor(deps?: Partial<StdioExitGuardDeps>) {
    this.proc = deps?.proc ?? (process as unknown as SignalExitProcess);
    this.globalScope =
      deps && "globalScope" in deps
        ? deps.globalScope
        : resolveGlobalScope(this.proc);
    this.customKillTreeSync = deps?.terminatePidTreeSync;
  }

  track(pid: number): void {
    if (!isValidPositivePid(pid)) return;
    this.pids.add(pid);
    this.syncListeners();
  }

  untrack(pid: number | null | undefined): void {
    if (!isValidPositivePid(pid)) return;
    this.pids.delete(pid);
    this.syncListeners();
  }

  trackedCount(): number {
    return this.pids.size;
  }

  dispose(): void {
    this.pids.clear();
    this.syncListeners();
  }

  private syncListeners(): void {
    if (this.pids.size > 0 && !this.attached) {
      this.proc.on("SIGINT", this.onSigint);
      this.proc.on("exit", this.onExit);
      this.attached = true;
      return;
    }
    if (this.pids.size === 0 && this.attached) {
      this.proc.off("SIGINT", this.onSigint);
      this.proc.off("exit", this.onExit);
      this.attached = false;
    }
  }

  private terminateAll(): void {
    const snapshot = [...this.pids];
    this.pids.clear();
    this.syncListeners();
    if (this.customKillTreeSync) {
      for (const pid of snapshot) {
        this.customKillTreeSync(pid);
      }
      return;
    }
    // WHY: Share one sync child reader across every tracked root so macOS/BSD teardown runs
    // at most one bounded `ps` snapshot even when several stdio servers are running.
    const reader = createSyncChildReader();
    const listDescendants = (root: number): number[] => listDescendantPidsSync(root, reader);
    for (const pid of snapshot) {
      terminatePidTreeSync(pid, { listDescendantPidsSync: listDescendants });
    }
  }

  private reRaiseSigint(): void {
    try {
      this.proc.kill(this.proc.pid, "SIGINT");
    } catch {
      // WHY: Fallback when self-SIGINT is unsupported or refused in a restricted environment.
      this.proc.exit(130);
    }
  }
}
