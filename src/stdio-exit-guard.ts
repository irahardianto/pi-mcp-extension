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
  terminatePidTreeSync: (pid: number) => void;
}

function readPositiveCount(holder: unknown): number {
  const count = (holder as { count?: unknown } | undefined)?.count;
  return typeof count === "number" && Number.isInteger(count) && count > 0 ? count : 0;
}

/**
 * Count passive `signal-exit` v3/v4 `SIGINT` listeners attached to `proc`.
 *
 * WHY: Pi 1.3.0 bundles `signal-exit` v3 (via `proper-lockfile`), which registers a `SIGINT`
 * listener that only acts when `listeners.length === emitter.count`. Subtracting those passive
 * wrappers lets our guard detect whether an active host handler (such as Pi TUI's `Ctrl+Z`
 * `ignoreSigint`) owns `SIGINT` without deadlocking in headless `rpc`/`json`/`print` modes.
 */
export function countPassiveSigintListeners(proc: unknown): number {
  if (!proc || typeof proc !== "object") return 0;
  const v3 = (proc as { __signal_exit_emitter__?: unknown }).__signal_exit_emitter__;
  const v4 = (proc as Record<symbol, unknown>)[SIGNAL_EXIT_V4_SYMBOL];
  return readPositiveCount(v3) + readPositiveCount(v4);
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
  const tids = readdirSync(taskDir);
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

function readPsProcessTableSync(
  parseProcessTable?: (stdout: string) => Map<number, number[]>,
): Map<number, number[]> {
  if (!parseProcessTable) return new Map();
  const stdout = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: PS_SYNC_TIMEOUT_MS,
  });
  return parseProcessTable(stdout);
}

function createSyncChildReader(
  parseProcessTable?: (stdout: string) => Map<number, number[]>,
): (pid: number) => number[] {
  if (process.platform === "linux") return readProcChildrenSync;
  if (process.platform === "win32") return () => [];
  let table: Map<number, number[]> | null = null;
  return (pid: number): number[] => {
    table ??= readPsProcessTableSync(parseProcessTable);
    return table.get(pid) ?? [];
  };
}

function walkDescendantsSync(pid: number, readChildren: (pid: number) => number[]): number[] {
  const descendants: number[] = [];
  const seen = new Set<number>([pid]);
  const pending = [...readChildren(pid)];
  while (pending.length > 0 && descendants.length < MAX_DESCENDANTS) {
    const next = pending.shift();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    descendants.push(next);
    pending.push(...readChildren(next));
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
  parseProcessTable?: (stdout: string) => Map<number, number[]>,
): number[] {
  try {
    const reader = readChildren ?? createSyncChildReader(parseProcessTable);
    return walkDescendantsSync(pid, reader).reverse();
  } catch {
    // WHY: Best-effort sync discovery during signal/exit; fallback still signals the root PID.
    return [];
  }
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
  const listDescendants = deps?.listDescendantPidsSync ?? listDescendantPidsSync;
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
  private readonly killTreeSync: (pid: number) => void;
  private attached = false;

  private readonly onSigint = (): void => {
    // WHY: Yield whenever Pi (e.g. interactive-mode handleCtrlZ's ignoreSigint) or another
    // active listener owns SIGINT; ignore passive signal-exit wrappers so headless rpc/json/print
    // modes do not deadlock when both listeners are present.
    const otherActive =
      this.proc.listenerCount("SIGINT") - 1 - countPassiveSigintListeners(this.proc);
    if (otherActive > 0) return;
    this.terminateAll();
    this.reRaiseSigint();
  };

  private readonly onExit = (): void => {
    this.terminateAll();
  };

  constructor(deps?: Partial<StdioExitGuardDeps>) {
    this.proc = deps?.proc ?? (process as unknown as SignalExitProcess);
    this.killTreeSync = deps?.terminatePidTreeSync ?? ((pid) => terminatePidTreeSync(pid));
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
    for (const pid of snapshot) {
      this.killTreeSync(pid);
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
