/**
 * Cross-process per-server interactive OAuth authorization lock.
 *
 * Uses an atomic lock file (<hash>.json.lock, mode 0600) containing a
 * versioned JSON record (PID, hostname, random nonce, creation timestamp)
 * plus a periodic mtime heartbeat. Automatically reclaims locks left behind
 * by crashed or SIGKILLed processes using a nonce-verified rename protocol.
 */

import {
  open,
  readFile,
  stat,
  rename,
  unlink,
  link,
  utimes,
  mkdir,
  chmod,
} from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { agentDir } from "./config.js";
import {
  formatHolderDetails,
  HEARTBEAT_MS,
  isLockStale,
  parseLockRecord,
  type LockRecord,
} from "./auth-lock-policy.js";

// ─── Errors ───────────────────────────────────────────────────────────────────

export class AuthRequiredError extends Error {
  constructor(
    serverName: string,
    message = `Authorization required for ${serverName}. Connect in an interactive Pi session or use /mcp:auth ${serverName}.`,
  ) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export class AuthLockError extends AuthRequiredError {
  constructor(serverName: string, details?: string) {
    const message = details
      ? details.startsWith("Authorization lock") || details.startsWith("Another Pi process")
        ? details
        : `Another Pi process (${details}) is authorizing ${serverName}. Retry after it finishes.`
      : `Another Pi process is authorizing ${serverName}. Retry after it finishes.`;
    super(serverName, message);
    this.name = "AuthLockError";
  }
}

// ─── Dependency Injection Types ───────────────────────────────────────────────

export interface AuthLockFileHandle {
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AuthLockFs {
  open(path: string, flags: string, mode?: number): Promise<AuthLockFileHandle>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  utimes(path: string, atime: number | string | Date, mtime: number | string | Date): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<string | undefined | void>;
  chmod(path: string, mode: number): Promise<void>;
}

export interface AuthLockTimer {
  unref?: () => void;
}

export interface AuthLockClock {
  now(): number;
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval> | AuthLockTimer;
  clearInterval(timer: ReturnType<typeof setInterval> | AuthLockTimer): void;
}

export interface AuthLockDeps {
  fs: AuthLockFs;
  clock: AuthLockClock;
  pid: number;
  hostname: string;
  isPidAlive: (pid: number) => boolean;
}

export interface AcquireAuthLockOptions {
  onLost?: (() => void) | undefined;
  deps?: Partial<AuthLockDeps> | undefined;
}

export type AuthLockHandle = (() => Promise<void>) & {
  unlock: () => Promise<void>;
  assertHeld: () => Promise<void>;
  isLost: () => boolean;
};

// ─── Path & Default Dependency Helpers ────────────────────────────────────────

export function authDir(storageDir?: string): string {
  return storageDir ?? join(agentDir(), "mcp-auth");
}

export function statePath(serverName: string, storageDir?: string): string {
  // Hash the server name to avoid filesystem issues with special chars
  const hash = createHash("sha256").update(serverName).digest("hex").slice(0, 16);
  return join(authDir(storageDir), `${hash}.json`);
}

export function lockPath(serverName: string, storageDir?: string): string {
  return `${statePath(serverName, storageDir)}.lock`;
}

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createDefaultAuthLockDeps(): AuthLockDeps {
  return {
    fs: {
      open: (path, flags, mode) => open(path, flags, mode),
      readFile: (path, encoding) => readFile(path, encoding),
      stat: (path) => stat(path),
      rename: (oldPath, newPath) => rename(oldPath, newPath),
      unlink: (path) => unlink(path),
      link: (existingPath, newPath) => link(existingPath, newPath),
      utimes: (path, atime, mtime) => utimes(path, atime, mtime),
      mkdir: (path, options) => mkdir(path, options),
      chmod: (path, mode) => chmod(path, mode),
    },
    clock: {
      now: () => Date.now(),
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
    },
    pid: process.pid,
    hostname: osHostname(),
    isPidAlive: defaultIsPidAlive,
  };
}

// ─── Lock Acquisition, Heartbeat & Release ────────────────────────────────────

const MAX_ACQUIRE_ATTEMPTS = 3;

async function readLockRecordWithRetry(
  fs: AuthLockFs,
  path: string,
  usingRealFs = false,
): Promise<LockRecord | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const raw = await fs.readFile(path, "utf8");
      return parseLockRecord(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && i < 2) {
        // WHY: During stale-lock inspection, a contender briefly renames `path` to
        // `movedPath` and restores it via `link(movedPath, path)` on nonce mismatch.
        // Yield across microtasks (and a brief macrotask on real fs) before treating ENOENT as genuine lock loss.
        await Promise.resolve();
        await Promise.resolve();
        if (usingRealFs && i === 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        continue;
      }
      return null;
    }
  }
  return null;
}

interface LockContext {
  serverName: string;
  path: string;
  myRecord: LockRecord;
  deps: AuthLockDeps;
  usingRealFs: boolean;
  onLost?: (() => void) | undefined;
}

async function runHeartbeatTick(
  ctx: LockContext,
  isStateActive: () => boolean,
  markLost: () => void,
): Promise<void> {
  const { path, myRecord, deps, usingRealFs } = ctx;
  if (!isStateActive()) return;
  const current = await readLockRecordWithRetry(deps.fs, path, usingRealFs);
  if (!isStateActive() || !current || current.nonce !== myRecord.nonce) {
    if (isStateActive()) markLost();
    return;
  }
  const nowSec = deps.clock.now() / 1000;
  try {
    await deps.fs.utimes(path, nowSec, nowSec);
  } catch {
    if (!isStateActive()) return;
    const after = await readLockRecordWithRetry(deps.fs, path, usingRealFs);
    if (!after || after.nonce !== myRecord.nonce) {
      markLost();
      return;
    }
    await deps.fs.utimes(path, nowSec, nowSec).catch(() => {
      // WHY: If utimes still fails after verifying the restored lock nonce, mark lock lost.
      if (isStateActive()) markLost();
    });
  }
}

interface LockLifecycleState {
  released: boolean;
  lost: boolean;
  heartbeatTimer: ReturnType<typeof setInterval> | AuthLockTimer | null;
}

function stopHeartbeat(ctx: LockContext, state: LockLifecycleState): void {
  if (state.heartbeatTimer === null) return;
  ctx.deps.clock.clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

function unlinkOwnLockFileSync(ctx: LockContext, state: LockLifecycleState): void {
  // WHY: Do not skip cleanup when `lost` is true — if a contender restored our
  // lock file via `link()` after a transient rename, we must still unlink our own nonce.
  if (state.released || !ctx.usingRealFs) return;
  try {
    const raw = readFileSync(ctx.path, "utf8");
    const current = parseLockRecord(raw);
    if (current && current.nonce === ctx.myRecord.nonce) {
      unlinkSync(ctx.path);
    }
  } catch {
    // WHY: Best-effort synchronous cleanup on process exit; lock file may already be unlinked.
  }
}

function markLockLost(ctx: LockContext, state: LockLifecycleState): void {
  if (state.lost || state.released) return;
  state.lost = true;
  stopHeartbeat(ctx, state);
  ctx.onLost?.();
}

function startHeartbeat(ctx: LockContext, state: LockLifecycleState): void {
  state.heartbeatTimer = ctx.deps.clock.setInterval(() => {
    void runHeartbeatTick(
      ctx,
      () => !state.released && !state.lost,
      () => markLockLost(ctx, state),
    );
  }, HEARTBEAT_MS);
  state.heartbeatTimer.unref?.();
}

function lostLockError(serverName: string): AuthLockError {
  return new AuthLockError(serverName, `Authorization lock lost for ${serverName}; retry`);
}

async function assertLockHeldFor(ctx: LockContext, state: LockLifecycleState): Promise<void> {
  if (state.lost || state.released) throw lostLockError(ctx.serverName);
  const current = await readLockRecordWithRetry(ctx.deps.fs, ctx.path, ctx.usingRealFs);
  if (current && current.nonce === ctx.myRecord.nonce) return;
  markLockLost(ctx, state);
  throw lostLockError(ctx.serverName);
}

async function releaseLock(
  ctx: LockContext,
  state: LockLifecycleState,
  onExit: () => void,
): Promise<void> {
  if (state.released) return;
  state.released = true;
  stopHeartbeat(ctx, state);
  process.removeListener("exit", onExit);
  // WHY: Always check and unlink if the file on disk still carries our nonce, even if
  // `lost` was set during a contender's temporary stale-check rename+link window.
  const current = await readLockRecordWithRetry(ctx.deps.fs, ctx.path, ctx.usingRealFs);
  if (!current || current.nonce !== ctx.myRecord.nonce) return;
  await ctx.deps.fs.unlink(ctx.path).catch(() => {
    // WHY: Best-effort lock removal on unlock; ignore ENOENT if concurrently removed.
  });
}

function createLockHandle(ctx: LockContext): AuthLockHandle {
  const state: LockLifecycleState = { released: false, lost: false, heartbeatTimer: null };
  const onExit = () => unlinkOwnLockFileSync(ctx, state);
  process.once("exit", onExit);
  startHeartbeat(ctx, state);
  const unlock = async (): Promise<void> => releaseLock(ctx, state, onExit);
  return Object.assign(unlock, {
    unlock,
    assertHeld: () => assertLockHeldFor(ctx, state),
    isLost: () => state.lost,
  });
}

async function inspectAndReclaimStaleLock(
  serverName: string,
  path: string,
  deps: AuthLockDeps,
): Promise<void> {
  // Lock file already exists — inspect and check staleness
  let statResult: { mtimeMs: number };
  try {
    statResult = await deps.fs.stat(path);
  } catch (statErr) {
    if ((statErr as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw statErr;
  }

  let record: LockRecord | null = null;
  try {
    const raw = await deps.fs.readFile(path, "utf8");
    record = parseLockRecord(raw);
  } catch (readErr) {
    if ((readErr as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    record = null;
  }

  const stale = isLockStale(record, statResult.mtimeMs, deps.clock.now(), {
    hostname: deps.hostname,
    isPidAlive: deps.isPidAlive,
  });
  if (!stale) {
    throw new AuthLockError(serverName, formatHolderDetails(record));
  }

  // Reclaim protocol: move stale candidate aside, verify identity, then delete or restore
  const movedPath = `${path}.stale-${randomUUID()}`;
  try {
    await deps.fs.rename(path, movedPath);
  } catch (renameErr) {
    if ((renameErr as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw renameErr;
  }

  let movedRecord: LockRecord | null = null;
  try {
    const movedRaw = await deps.fs.readFile(movedPath, "utf8");
    movedRecord = parseLockRecord(movedRaw);
  } catch {
    movedRecord = null;
  }

  let matchesStale = false;
  if (record !== null) {
    matchesStale = movedRecord !== null && movedRecord.nonce === record.nonce;
  } else {
    try {
      const movedStat = await deps.fs.stat(movedPath);
      matchesStale = movedRecord === null && movedStat.mtimeMs === statResult.mtimeMs;
    } catch {
      matchesStale = false;
    }
  }

  if (matchesStale) {
    await deps.fs.unlink(movedPath).catch(() => {
      // WHY: Best-effort removal of reclaimed stale lock file.
    });
    return;
  }

  await deps.fs.link(movedPath, path).catch(() => {
    // WHY: Best-effort restore of contender's fresh lock file if path was not already recreated.
  });
  await deps.fs.unlink(movedPath).catch(() => {
    // WHY: Best-effort cleanup of temporary stale-check file.
  });
  throw new AuthLockError(serverName, formatHolderDetails(movedRecord));
}

function resolveAuthLockDeps(options?: AcquireAuthLockOptions): AuthLockDeps {
  const overrides = options?.deps ?? {};
  const defaults = createDefaultAuthLockDeps();
  return {
    fs: overrides.fs ?? defaults.fs,
    clock: overrides.clock ?? defaults.clock,
    pid: overrides.pid ?? defaults.pid,
    hostname: overrides.hostname ?? defaults.hostname,
    isPidAlive: overrides.isPidAlive ?? defaults.isPidAlive,
  };
}

async function prepareAuthDirectory(
  deps: AuthLockDeps,
  serverName: string,
  storageDir?: string,
): Promise<string> {
  const directory = authDir(storageDir);
  await deps.fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await deps.fs.chmod(directory, 0o700);
  return lockPath(serverName, storageDir);
}

async function writeExclusiveLockFile(
  fs: AuthLockFs,
  path: string,
  record: LockRecord,
): Promise<void> {
  const file = await fs.open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(record));
    await file.sync();
  } catch (writeErr) {
    await file.close().catch(() => {
      // WHY: Best-effort file handle close after write failure.
    });
    await fs.unlink(path).catch(() => {
      // WHY: Best-effort cleanup of partially written lock file before rethrowing writeErr.
    });
    throw writeErr;
  }
  await file.close();
}

function createLockRecord(deps: AuthLockDeps): LockRecord {
  return {
    v: 1,
    pid: deps.pid,
    hostname: deps.hostname,
    nonce: randomUUID(),
    createdAt: deps.clock.now(),
  };
}

type LockAcquisitionContext = Omit<LockContext, "myRecord">;

async function tryCreateLock(ctx: LockAcquisitionContext): Promise<AuthLockHandle | null> {
  const myRecord = createLockRecord(ctx.deps);
  try {
    await writeExclusiveLockFile(ctx.deps.fs, ctx.path, myRecord);
    return createLockHandle({ ...ctx, myRecord });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    await inspectAndReclaimStaleLock(ctx.serverName, ctx.path, ctx.deps);
    return null;
  }
}

export async function acquireAuthLock(
  serverName: string,
  storageDir?: string,
  options?: AcquireAuthLockOptions,
): Promise<AuthLockHandle> {
  const deps = resolveAuthLockDeps(options);
  const path = await prepareAuthDirectory(deps, serverName, storageDir);
  const ctx: LockAcquisitionContext = {
    serverName,
    path,
    deps,
    usingRealFs: options?.deps?.fs === undefined,
    onLost: options?.onLost,
  };

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const handle = await tryCreateLock(ctx);
    if (handle) return handle;
  }

  throw new AuthLockError(serverName);
}

export { acquireAuthLock as acquireLock };
