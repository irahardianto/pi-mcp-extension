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
import { describeError, reportDiagnostic } from "./debug-log.js";
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

/** Yield across microtasks (and briefly on the real fs) while a peer finishes its restore. */
async function yieldForPeerRestore(usingRealFs: boolean, attempt: number): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  if (usingRealFs && attempt === 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** Read the lock record, retrying while a peer may have the file briefly out of place. */
async function readLockRecordWithRetry(
  fs: AuthLockFs,
  path: string,
  usingRealFs = false,
): Promise<LockRecord | null> {
  for (let i = 0; i < 3; i++) {
    let record: LockRecord | null = null;
    try {
      record = parseLockRecord(await fs.readFile(path, "utf8"));
    } catch {
      // WHY: A missing or unreadable file is indistinguishable from a peer's in-flight restore
      // on a single read; the retry below decides whether the lock is really gone.
    }
    if (record !== null) return record;
    if (i === 2) return null;
    // WHY: During stale-lock inspection a contender briefly renames `path` to `movedPath` and
    // restores it via `link()` — or, where hard links are unsupported, re-creates it with an
    // exclusive write that publishes the file empty for an instant. Both read as "no lock"
    // here, so retry across microtasks (and a brief macrotask on the real fs) before
    // concluding the lock is genuinely gone.
    await yieldForPeerRestore(usingRealFs, i);
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

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

/** Stat the existing lock file; `undefined` when it disappeared (ENOENT) mid-race. */
async function statExistingLockFile(
  path: string,
  deps: AuthLockDeps,
): Promise<{ mtimeMs: number } | undefined> {
  try {
    return await deps.fs.stat(path);
  } catch (statErr) {
    if (errnoCode(statErr) === "ENOENT") {
      return undefined;
    }
    throw statErr;
  }
}

/**
 * Read and parse the lock record at `path`.
 * `undefined` means the file vanished (ENOENT); `null` means it is unreadable or corrupt.
 */
async function readExistingLockRecord(
  path: string,
  deps: AuthLockDeps,
): Promise<LockRecord | null | undefined> {
  try {
    return parseLockRecord(await deps.fs.readFile(path, "utf8"));
  } catch (readErr) {
    if (errnoCode(readErr) === "ENOENT") {
      return undefined;
    }
    return null;
  }
}

/** Read the moved stale candidate; a missing or corrupt candidate is treated as unparsable. */
async function readMovedLockRecord(path: string, deps: AuthLockDeps): Promise<LockRecord | null> {
  try {
    return parseLockRecord(await deps.fs.readFile(path, "utf8"));
  } catch {
    // WHY: Best-effort inspection of a renamed candidate; an unreadable file simply fails the
    // identity check below and the contender's lock is restored instead of reclaimed.
    return null;
  }
}

/** Move the stale candidate aside; `undefined` when it vanished (ENOENT) before the rename. */
async function moveStaleCandidate(path: string, deps: AuthLockDeps): Promise<string | undefined> {
  const movedPath = `${path}.stale-${randomUUID()}`;
  try {
    await deps.fs.rename(path, movedPath);
    return movedPath;
  } catch (renameErr) {
    if (errnoCode(renameErr) === "ENOENT") {
      return undefined;
    }
    throw renameErr;
  }
}

/**
 * Confirm the file moved aside is the same lock we measured as stale: either the same nonce, or,
 * when the stale lock was unparsable, an unparsable file with the same mtime.
 */
async function isSameStaleCandidate(
  record: LockRecord | null,
  movedRecord: LockRecord | null,
  movedPath: string,
  statResult: { mtimeMs: number },
  deps: AuthLockDeps,
): Promise<boolean> {
  if (record !== null) {
    return movedRecord !== null && movedRecord.nonce === record.nonce;
  }
  try {
    const movedStat = await deps.fs.stat(movedPath);
    return movedRecord === null && movedStat.mtimeMs === statResult.mtimeMs;
  } catch {
    // WHY: A vanished moved file cannot be the stale lock we measured; fall back to restore.
    return false;
  }
}

/** Remove the temporary stale-check file; an already-removed candidate is not a failure. */
async function unlinkCandidate(movedPath: string, deps: AuthLockDeps): Promise<void> {
  await deps.fs.unlink(movedPath).catch(() => {
    // WHY: Best-effort cleanup of temporary stale-check file.
  });
}

/**
 * Give up on a candidate that cannot be put back, and say so.
 *
 * The displaced holder finds out on its next heartbeat and aborts with `Authorization lock
 * lost`; nothing in this module ever reads a `<path>.stale-*` file again, so leaving the
 * candidate behind would only accumulate orphans in the auth directory.
 */
async function abandonCandidate(
  serverName: string,
  movedPath: string,
  err: unknown,
  deps: AuthLockDeps,
): Promise<void> {
  const { kind, message } = describeError(err);
  reportDiagnostic({
    level: "warn",
    event: "auth.lock_restore_failed",
    server: serverName,
    message: `Could not restore the authorization lock file for "${serverName}": ${message}`,
    fields: { kind },
  });
  await unlinkCandidate(movedPath, deps);
}

/**
 * Re-create `path` from the candidate when hard links are unavailable.
 *
 * Uses the same exclusive-create write as lock acquisition, so a lock another process acquired
 * while `path` was free is never overwritten; `EEXIST` means that process now holds the lock.
 */
async function restoreCandidateByWrite(
  serverName: string,
  movedPath: string,
  path: string,
  deps: AuthLockDeps,
): Promise<void> {
  let data: string;
  try {
    data = await deps.fs.readFile(movedPath, "utf8");
  } catch (readErr) {
    await abandonCandidate(serverName, movedPath, readErr, deps);
    return;
  }
  try {
    await writeExclusiveLockFile(deps.fs, path, data);
  } catch (writeErr) {
    if (errnoCode(writeErr) === "EEXIST") {
      // WHY: Another process acquired the lock while `path` was free; its record wins and the
      // displaced holder detects the loss itself.
      await unlinkCandidate(movedPath, deps);
      return;
    }
    await abandonCandidate(serverName, movedPath, writeErr, deps);
    return;
  }
  await unlinkCandidate(movedPath, deps);
}

/**
 * Restore the contender's fresh lock file, then clean up the temporary candidate path.
 *
 * Reached only when `isSameStaleCandidate` found the moved file carries a *different* nonce:
 * the reclaim race was lost and this record is that process's only copy of its lock. Both
 * restore primitives refuse to replace an existing lock — `link` fails `EEXIST`, and the
 * fallback write is exclusive-create — because a filesystem that refuses hard links
 * (`ENOTSUP`/`EOPNOTSUPP` on FAT/exFAT/SMB/SSHFS/FUSE, `EPERM` under `fs.protected_hardlinks`
 * or seccomp) says nothing about whether `path` is free. Overwriting there would destroy the
 * live lock of whichever process acquired it in the meantime, which is the very failure this
 * path exists to prevent.
 *
 * At most one holder survives: if `path` is taken, the displaced holder's record is dropped
 * and it aborts on its next heartbeat, exactly as if the reclaim had never restored it.
 */
async function restoreCandidate(
  serverName: string,
  movedPath: string,
  path: string,
  deps: AuthLockDeps,
): Promise<void> {
  try {
    await deps.fs.link(movedPath, path);
  } catch (linkErr) {
    const code = errnoCode(linkErr);
    if (code === "EEXIST") {
      // WHY: `path` holds a lock another process acquired while it was free, so restoring this
      // record would delete a live lock. Keep that lock; the displaced holder detects the loss.
      await unlinkCandidate(movedPath, deps);
      return;
    }
    if (code === "ENOENT") {
      await abandonCandidate(serverName, movedPath, linkErr, deps);
      return;
    }
    await restoreCandidateByWrite(serverName, movedPath, path, deps);
    return;
  }
  await unlinkCandidate(movedPath, deps);
}

async function inspectAndReclaimStaleLock(
  serverName: string,
  path: string,
  deps: AuthLockDeps,
): Promise<void> {
  // Lock file already exists — inspect and check staleness
  const statResult = await statExistingLockFile(path, deps);
  if (!statResult) {
    return;
  }

  const record = await readExistingLockRecord(path, deps);
  if (record === undefined) {
    return;
  }

  const stale = isLockStale(record, statResult.mtimeMs, deps.clock.now(), {
    hostname: deps.hostname,
    isPidAlive: deps.isPidAlive,
  });
  if (!stale) {
    throw new AuthLockError(serverName, formatHolderDetails(record));
  }

  // Reclaim protocol: move stale candidate aside, verify identity, then delete or restore
  const movedPath = await moveStaleCandidate(path, deps);
  if (!movedPath) {
    return;
  }

  const movedRecord = await readMovedLockRecord(movedPath, deps);
  if (await isSameStaleCandidate(record, movedRecord, movedPath, statResult, deps)) {
    await deps.fs.unlink(movedPath).catch(() => {
      // WHY: Best-effort removal of reclaimed stale lock file.
    });
    return;
  }

  await restoreCandidate(serverName, movedPath, path, deps);
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
  data: string,
): Promise<void> {
  const file = await fs.open(path, "wx", 0o600);
  try {
    await file.writeFile(data);
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
    await writeExclusiveLockFile(ctx.deps.fs, ctx.path, JSON.stringify(myRecord));
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
