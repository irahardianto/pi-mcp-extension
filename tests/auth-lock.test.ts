import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  acquireAuthLock,
  AuthLockError,
  defaultIsPidAlive,
  HEARTBEAT_MS,
  isLockStale,
  lockPath,
  STALE_MS,
  statePath,
  type AuthLockClock,
  type AuthLockDeps,
  type AuthLockFs,
  type AuthLockTimer,
  type LockRecord,
} from "../src/auth-lock.js";
import { getAuthStatus, McpOAuthProvider } from "../src/oauth-provider.js";
import { McpError } from "../src/errors.js";

// ─── Fake FS & Clock Helpers for Fast Unit Tests ──────────────────────────────

interface FakeFileEntry {
  content: string;
  mtimeMs: number;
  mode: number;
}

function createFakeClock(initialNow = 1_000_000) {
  let currentNow = initialNow;
  let nextId = 1;
  const intervals = new Map<number, { cb: () => unknown; ms: number }>();

  interface FakeTimer extends AuthLockTimer {
    id: number;
  }

  const clock: AuthLockClock = {
    now: () => currentNow,
    setInterval: (cb, ms): FakeTimer => {
      const id = nextId++;
      intervals.set(id, { cb, ms });
      return {
        id,
        unref() {},
      };
    },
    clearInterval: (timer: ReturnType<typeof setInterval> | AuthLockTimer) => {
      const id = typeof timer === "object" && timer !== null && "id" in timer && typeof timer.id === "number" ? timer.id : Number(timer);
      intervals.delete(id);
    },
  };

  return {
    clock,
    advance(ms: number) {
      currentNow += ms;
    },
    setNow(now: number) {
      currentNow = now;
    },
    async runIntervals() {
      for (const entry of Array.from(intervals.values())) {
        await entry.cb();
      }
    },
    get activeIntervalCount() {
      return intervals.size;
    },
  };
}

function createErrno(code: string, message = code): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function createFakeFs(getNow: () => number) {
  const files = new Map<string, FakeFileEntry>();
  const hooks: {
    beforeRename?: ((oldPath: string, newPath: string) => void | Promise<void>) | undefined;
  } = {};
  const calls = {
    link: [] as Array<{ existingPath: string; newPath: string }>,
    unlink: [] as string[],
    rename: [] as Array<{ oldPath: string; newPath: string }>,
    utimes: [] as Array<{ path: string; mtimeMs: number }>,
  };

  const fs: AuthLockFs = {
    async mkdir(_path, _options) {
      return undefined;
    },
    async chmod(_path, _mode) {},
    async open(path, flags, mode = 0o600) {
      if (flags === "wx" && files.has(path)) {
        throw createErrno("EEXIST", `EEXIST: file already exists, open '${path}'`);
      }
      files.set(path, { content: "", mtimeMs: getNow(), mode });
      return {
        async writeFile(data: string) {
          const entry = files.get(path);
          if (!entry) throw createErrno("ENOENT");
          entry.content = data;
          entry.mtimeMs = getNow();
        },
        async sync() {},
        async close() {},
      };
    },
    async readFile(path, _encoding) {
      const entry = files.get(path);
      if (!entry) throw createErrno("ENOENT", `ENOENT: no such file or directory, open '${path}'`);
      return entry.content;
    },
    async stat(path) {
      const entry = files.get(path);
      if (!entry) throw createErrno("ENOENT", `ENOENT: no such file or directory, stat '${path}'`);
      return { mtimeMs: entry.mtimeMs };
    },
    async rename(oldPath, newPath) {
      await hooks.beforeRename?.(oldPath, newPath);
      calls.rename.push({ oldPath, newPath });
      const entry = files.get(oldPath);
      if (!entry) throw createErrno("ENOENT", `ENOENT: no such file or directory, rename '${oldPath}'`);
      files.delete(oldPath);
      files.set(newPath, entry);
    },
    async unlink(path) {
      calls.unlink.push(path);
      if (!files.has(path)) throw createErrno("ENOENT", `ENOENT: no such file or directory, unlink '${path}'`);
      files.delete(path);
    },
    async link(existingPath, newPath) {
      calls.link.push({ existingPath, newPath });
      const entry = files.get(existingPath);
      if (!entry) throw createErrno("ENOENT", `ENOENT: no such file or directory, link '${existingPath}'`);
      if (files.has(newPath)) throw createErrno("EEXIST", `EEXIST: file already exists, link '${newPath}'`);
      files.set(newPath, { ...entry });
    },
    async utimes(path, _atime, mtime) {
      const entry = files.get(path);
      if (!entry) throw createErrno("ENOENT", `ENOENT: no such file or directory, utime '${path}'`);
      const mtimeMs = typeof mtime === "number" ? mtime * 1000 : Number(mtime);
      entry.mtimeMs = mtimeMs;
      calls.utimes.push({ path, mtimeMs });
    },
  };

  return { fs, files, hooks, calls };
}

// ─── 1. Pure Unit Tests: isLockStale ──────────────────────────────────────────

describe("isLockStale pure policy", () => {
  const baseNow = 500_000;
  const freshMtime = baseNow - 10_000;
  const staleMtime = baseNow - (STALE_MS + 1);

  const baseRecord: LockRecord = {
    v: 1,
    pid: 4242,
    hostname: "host-a",
    nonce: "nonce-1",
    createdAt: freshMtime,
  };

  it("should return true when lock holder PID is dead on the same host even if heartbeat is fresh", () => {
    // Arrange
    const self = { hostname: "host-a", isPidAlive: () => false };

    // Act
    const stale = isLockStale(baseRecord, freshMtime, baseNow, self);

    // Assert
    assert.equal(stale, true);
  });

  it("should return false when lock holder PID is alive on the same host and heartbeat is fresh", () => {
    // Arrange
    const self = { hostname: "host-a", isPidAlive: () => true };

    // Act
    const stale = isLockStale(baseRecord, freshMtime, baseNow, self);

    // Assert
    assert.equal(stale, false);
  });

  it("should return false when isPidAlive reports true for EPERM on the same host and heartbeat is fresh", () => {
    // Arrange
    const isPidAliveWithEperm = (_pid: number) => {
      const err = createErrno("EPERM");
      return err.code === "EPERM";
    };
    const self = { hostname: "host-a", isPidAlive: isPidAliveWithEperm };

    // Act
    const stale = isLockStale(baseRecord, freshMtime, baseNow, self);

    // Assert
    assert.equal(stale, false);
  });

  it("should return true when heartbeat age exceeds STALE_MS on the same host even if PID is alive", () => {
    // Arrange
    const self = { hostname: "host-a", isPidAlive: () => true };

    // Act
    const stale = isLockStale(baseRecord, staleMtime, baseNow, self);

    // Assert
    assert.equal(stale, true);
  });

  it("should return true when heartbeat age exceeds STALE_MS on a different host", () => {
    // Arrange
    const self = { hostname: "host-b", isPidAlive: () => false };

    // Act
    const stale = isLockStale(baseRecord, staleMtime, baseNow, self);

    // Assert
    assert.equal(stale, true);
  });

  it("should return false when lock is held on a different host and heartbeat is fresh", () => {
    // Arrange
    const self = { hostname: "host-b", isPidAlive: () => false };

    // Act
    const stale = isLockStale(baseRecord, freshMtime, baseNow, self);

    // Assert
    assert.equal(stale, false);
  });

  it("should return false when record is null and mtime is within STALE_MS", () => {
    // Arrange
    const self = { hostname: "host-a", isPidAlive: () => false };

    // Act
    const stale = isLockStale(null, freshMtime, baseNow, self);

    // Assert
    assert.equal(stale, false);
  });

  it("should return true when record is null and mtime is older than STALE_MS", () => {
    // Arrange
    const self = { hostname: "host-a", isPidAlive: () => true };

    // Act
    const stale = isLockStale(null, staleMtime, baseNow, self);

    // Assert
    assert.equal(stale, true);
  });

  it("should detect current process PID as alive in defaultIsPidAlive", () => {
    // Arrange & Act
    const alive = defaultIsPidAlive(process.pid);

    // Assert
    assert.equal(alive, true);
  });
});

// ─── 2. Injected Fake FS & Clock Unit Tests ───────────────────────────────────

describe("acquireAuthLock with injected fake fs and clock", () => {
  const storageDir = "/virtual/mcp-auth";
  const serverName = "test-server";
  const targetLockPath = lockPath(serverName, storageDir);

  it("should restore fresh lock via link and throw AuthLockError when a reclaim race causes a nonce mismatch", async () => {
    // Arrange
    const fakeClock = createFakeClock(200_000);
    const { fs, files, hooks, calls } = createFakeFs(() => fakeClock.clock.now());

    const staleRecord: LockRecord = {
      v: 1,
      pid: 9999,
      hostname: "host-a",
      nonce: "stale-nonce-1",
      createdAt: 190_000,
    };
    files.set(targetLockPath, {
      content: JSON.stringify(staleRecord),
      mtimeMs: 190_000,
      mode: 0o600,
    });

    const freshWinnerRecord: LockRecord = {
      v: 1,
      pid: 8888,
      hostname: "host-a",
      nonce: "fresh-winner-nonce",
      createdAt: 200_000,
    };

    // Simulate another process reclaiming and creating a fresh lock right before our rename executes
    hooks.beforeRename = (oldPath) => {
      if (oldPath === targetLockPath) {
        files.set(targetLockPath, {
          content: JSON.stringify(freshWinnerRecord),
          mtimeMs: 200_000,
          mode: 0o600,
        });
      }
    };

    const deps: Partial<AuthLockDeps> = {
      fs,
      clock: fakeClock.clock,
      pid: 7777,
      hostname: "host-a",
      isPidAlive: (pid) => pid !== 9999,
    };

    // Act & Assert
    await assert.rejects(
      () => acquireAuthLock(serverName, storageDir, { deps }),
      (err: unknown) => err instanceof AuthLockError && /Another Pi process/.test(err.message),
    );

    assert.equal(calls.link.length, 1);
    assert.equal(calls.link[0]?.newPath, targetLockPath);
    const restored = JSON.parse(files.get(targetLockPath)!.content) as LockRecord;
    assert.equal(restored.nonce, "fresh-winner-nonce");
  });

  it("should invoke onLost and reject assertHeld when heartbeat detects nonce changed on disk", async () => {
    // Arrange
    const fakeClock = createFakeClock(100_000);
    const { fs, files } = createFakeFs(() => fakeClock.clock.now());
    let lostCount = 0;

    const unlock = await acquireAuthLock(serverName, storageDir, {
      onLost: () => {
        lostCount++;
      },
      deps: {
        fs,
        clock: fakeClock.clock,
        pid: 1111,
        hostname: "host-a",
        isPidAlive: () => true,
      },
    });

    await unlock.assertHeld();
    assert.equal(unlock.isLost(), false);

    // Simulate another process replacing the lock file with a different nonce
    const otherRecord: LockRecord = {
      v: 1,
      pid: 2222,
      hostname: "host-b",
      nonce: "stolen-nonce",
      createdAt: 130_000,
    };
    files.set(targetLockPath, {
      content: JSON.stringify(otherRecord),
      mtimeMs: 130_000,
      mode: 0o600,
    });

    // Act
    fakeClock.advance(HEARTBEAT_MS);
    await fakeClock.runIntervals();

    // Assert
    assert.equal(lostCount, 1);
    assert.equal(unlock.isLost(), true);
    assert.equal(fakeClock.activeIntervalCount, 0);
    await assert.rejects(
      () => unlock.assertHeld(),
      (err: unknown) =>
        err instanceof AuthLockError && /Authorization lock lost for test-server; retry/.test(err.message),
    );
  });

  it("should refresh lock mtime when heartbeat ticks and nonce matches", async () => {
    // Arrange
    const fakeClock = createFakeClock(100_000);
    const { fs, files, calls } = createFakeFs(() => fakeClock.clock.now());

    const unlock = await acquireAuthLock(serverName, storageDir, {
      deps: {
        fs,
        clock: fakeClock.clock,
        pid: 1111,
        hostname: "host-a",
        isPidAlive: () => true,
      },
    });

    // Act
    fakeClock.advance(HEARTBEAT_MS);
    await fakeClock.runIntervals();

    // Assert
    assert.equal(calls.utimes.length, 1);
    assert.equal(files.get(targetLockPath)?.mtimeMs, 100_000 + HEARTBEAT_MS);
    assert.equal(unlock.isLost(), false);
    await unlock();
  });

  it("should not delete another owner's lock when unlock is called after the nonce changed on disk", async () => {
    // Arrange
    const fakeClock = createFakeClock(100_000);
    const { fs, files, calls } = createFakeFs(() => fakeClock.clock.now());

    const unlock = await acquireAuthLock(serverName, storageDir, {
      deps: {
        fs,
        clock: fakeClock.clock,
        pid: 1111,
        hostname: "host-a",
        isPidAlive: () => true,
      },
    });

    const newOwnerRecord: LockRecord = {
      v: 1,
      pid: 3333,
      hostname: "host-a",
      nonce: "new-owner-nonce",
      createdAt: 120_000,
    };
    files.set(targetLockPath, {
      content: JSON.stringify(newOwnerRecord),
      mtimeMs: 120_000,
      mode: 0o600,
    });

    // Act
    await unlock();

    // Assert
    assert.equal(calls.unlink.length, 0);
    assert.ok(files.has(targetLockPath));
    const current = JSON.parse(files.get(targetLockPath)!.content) as LockRecord;
    assert.equal(current.nonce, "new-owner-nonce");
  });

  it("should reject interactive credential writes when assertLockHeld fails", async () => {
    // Arrange
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-assert-held-"));
    try {
      const fakeClock = createFakeClock(100_000);
      const { fs, files } = createFakeFs(() => fakeClock.clock.now());

      const unlock = await acquireAuthLock(serverName, storageDir, {
        deps: {
          fs,
          clock: fakeClock.clock,
          pid: 1111,
          hostname: "host-a",
          isPidAlive: () => true,
        },
      });

      const provider = new McpOAuthProvider(
        serverName,
        {},
        undefined,
        dir,
        false,
        () => false,
        () => unlock.assertHeld(),
      );

      // Remove lock from fake fs to simulate lock loss
      files.delete(targetLockPath);

      // Act & Assert
      await assert.rejects(
        () => provider.saveClientInformation({ client_id: "c1" }),
        /Authorization lock lost/,
      );
      await assert.rejects(
        () => provider.saveTokens({ access_token: "t1", token_type: "Bearer" }),
        /Authorization lock lost/,
      );
      await assert.rejects(
        () => provider.invalidateCredentials("all"),
        /Authorization lock lost/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── 3. Integration Tests: Real Temp Directory & Child Process ────────────────

describe("OAuth lock and state integration (real filesystem)", () => {
  it("should immediately reclaim a stale lock and acquire it when the child process holding the lock is killed with SIGKILL", async () => {
    // Arrange
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-sigkill-lock-"));
    const serverName = "sigkill-server";
    const childScript = `
      import { acquireAuthLock } from "./src/auth-lock.ts";
      const storageDir = process.env.TEST_AUTH_DIR;
      const serverName = process.env.TEST_SERVER_NAME;
      await acquireAuthLock(serverName, storageDir);
      process.stdout.write("LOCKED\\n");
      setInterval(() => {}, 10000);
    `;

    const child = spawn(process.execPath, ["--import", "tsx/esm", "-e", childScript], {
      cwd: process.cwd(),
      env: { ...process.env, TEST_AUTH_DIR: dir, TEST_SERVER_NAME: serverName },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("LOCKED")) resolve();
        });
        child.once("error", reject);
        child.once("exit", (code, sig) => {
          if (!output.includes("LOCKED")) {
            reject(new Error(`Child exited prematurely: code=${code} sig=${sig}`));
          }
        });
      });

      assert.ok(child.pid, "Child process must have a PID");

      // Kill the child with SIGKILL so its exit handler cannot run
      const exitPromise = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      process.kill(child.pid, "SIGKILL");
      await exitPromise;

      // On Linux, a killed child can briefly remain in /proc until reaped; poll defaultIsPidAlive briefly
      for (let i = 0; i < 50 && defaultIsPidAlive(child.pid); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Act: parent immediately reclaims the dead child's lock
      const unlock = await acquireAuthLock(serverName, dir);

      // Assert
      await unlock.assertHeld();
      const raw = await readFile(lockPath(serverName, dir), "utf8");
      const record = JSON.parse(raw) as LockRecord;
      assert.equal(record.pid, process.pid);
      await unlock();
    } finally {
      try {
        if (child.pid) process.kill(child.pid, "SIGKILL");
      } catch {
        // Ignore if already dead
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("should persist rotated refresh tokens during silent saveTokens when unlocked, avoid clobbering disk when locked, and fall back to in-memory cache when disk write fails", async () => {
    // Arrange
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-silent-refresh-"));
    const serverName = "refresh-server";
    try {
      const silent = new McpOAuthProvider(serverName, { clientId: "client-1" }, undefined, dir, true);
      const reader = new McpOAuthProvider(serverName, { clientId: "client-1" }, undefined, dir, true);

      // Act (Part 1: silent saveTokens when unlocked persists to disk and preserves expires_in + scope)
      await silent.saveTokens({
        access_token: "rotated-access-1",
        refresh_token: "rotated-refresh-1",
        token_type: "Bearer",
        expires_in: 1800,
        scope: "read:tools",
      });

      // Assert (Part 1: persisted to disk and readable by any provider with full fidelity)
      const diskTokens = await reader.tokens();
      assert.equal(diskTokens?.access_token, "rotated-access-1");
      assert.equal(diskTokens?.refresh_token, "rotated-refresh-1");
      assert.equal(diskTokens?.expires_in, 1800);
      assert.equal(diskTokens?.scope, "read:tools");

      // Act (Part 2: silent saveTokens while an interactive lock is held does NOT clobber disk or log error)
      const unlock = await acquireAuthLock(serverName, dir);
      const lockErrors: unknown[][] = [];
      const origErr = console.error;
      console.error = (...args: unknown[]) => {
        lockErrors.push(args);
      };
      try {
        await silent.saveTokens({
          access_token: "in-memory-while-locked",
          refresh_token: "in-memory-refresh",
          token_type: "Bearer",
        });
      } finally {
        console.error = origErr;
        await unlock();
      }

      // Assert (Part 2: silent provider serves cached tokens, disk still has rotated-access-1, zero errors logged)
      assert.equal(lockErrors.length, 0);
      assert.equal((await silent.tokens())?.access_token, "in-memory-while-locked");
      assert.equal((await reader.tokens())?.access_token, "rotated-access-1");

      // Arrange (Part 3: force disk write failure in silent.saveTokens)
      const blockedStorageDir = join(dir, "blocked-file-as-dir");
      await writeFile(blockedStorageDir, "not-a-directory", "utf8");
      const fallbackSilent = new McpOAuthProvider(
        serverName,
        { clientId: "client-1" },
        undefined,
        blockedStorageDir,
        true,
      );

      const errors: unknown[][] = [];
      const origConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args);
      };
      try {
        // Act (Part 3: silent saveTokens when disk persistence fails)
        await fallbackSilent.saveTokens({
          access_token: "cached-access-2",
          refresh_token: "cached-refresh-2",
          token_type: "Bearer",
        });
      } finally {
        console.error = origConsoleError;
      }

      // Assert (Part 3: error logged, and in-memory cache serves rotated tokens)
      assert.equal(errors.length, 1);
      const cachedTokens = await fallbackSilent.tokens();
      assert.equal(cachedTokens?.access_token, "cached-access-2");
      assert.equal(cachedTokens?.refresh_token, "cached-refresh-2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("should reload peer-rotated tokens on silent invalidateCredentials('tokens') and delete genuinely rejected tokens from disk", async () => {
    // Arrange
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-peer-refresh-"));
    const serverName = "peer-server";
    try {
      const seeder = new McpOAuthProvider(serverName, { clientId: "c1" }, undefined, dir, false);
      await seeder.saveClientInformation({ client_id: "c1" });
      await seeder.saveTokens({
        access_token: "access-1",
        refresh_token: "refresh-1",
        token_type: "Bearer",
      });

      const processA = new McpOAuthProvider(serverName, { clientId: "c1" }, undefined, dir, true);
      const processB = new McpOAuthProvider(serverName, { clientId: "c1" }, undefined, dir, true);

      // Both processes read initial tokens
      assert.equal((await processA.tokens())?.refresh_token, "refresh-1");
      assert.equal((await processB.tokens())?.refresh_token, "refresh-1");

      // Process A wins the refresh race and persists rotated tokens to disk
      await processA.saveTokens({
        access_token: "access-2",
        refresh_token: "refresh-2",
        token_type: "Bearer",
      });

      // Act (Part 1: Process B's refresh with refresh-1 fails with InvalidGrantError, triggering invalidateCredentials("tokens"))
      await processB.invalidateCredentials("tokens");

      // Assert (Part 1: Process B reloaded Process A's rotated tokens instead of throwing or deleting disk state)
      const reloaded = await processB.tokens();
      assert.equal(reloaded?.access_token, "access-2");
      assert.equal(reloaded?.refresh_token, "refresh-2");
      assert.equal((await getAuthStatus(serverName, dir))?.hasTokens, true);

      // Act (Part 2: If refresh fails again with no further peer rotation on disk, invalidateCredentials("tokens") removes tokens from disk and throws AuthRequiredError)
      await assert.rejects(
        () => processB.invalidateCredentials("tokens"),
        (err: unknown) => err instanceof Error && err.name === "AuthRequiredError",
      );

      // Assert (Part 2: Stale tokens removed from disk while clientInfo is preserved)
      const statusAfterReject = await getAuthStatus(serverName, dir);
      assert.equal(statusAfterReject?.hasTokens, false);
      assert.equal(statusAfterReject?.hasClientInfo, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("should retry transient ENOENT during stale-lock inspection and unlink restored lock file on unlock even if marked lost", async () => {
    // Arrange
    const fakeClock = createFakeClock(300_000);
    const { fs, files } = createFakeFs(() => fakeClock.clock.now());
    const storageDir = "/virtual/mcp-auth-race";
    const serverName = "race-server";
    const targetLockPath = lockPath(serverName, storageDir);

    let readCount = 0;
    const origReadFile = fs.readFile.bind(fs);
    let simulateTransientRenameWindow = false;
    fs.readFile = async (path, encoding) => {
      if (simulateTransientRenameWindow && path === targetLockPath) {
        readCount++;
        if (readCount === 1) {
          throw createErrno("ENOENT", "Transient ENOENT while contender renamed lock file");
        }
      }
      return origReadFile(path, encoding);
    };

    const holder = await acquireAuthLock(serverName, storageDir, {
      deps: {
        fs,
        clock: fakeClock.clock,
        pid: 1001,
        hostname: "host-a",
        isPidAlive: () => true,
      },
    });

    // Act (Part 1: transient ENOENT on first read recovers on microtask retry)
    simulateTransientRenameWindow = true;
    await holder.assertHeld();
    assert.equal(holder.isLost(), false);
    assert.equal(readCount, 2);
    simulateTransientRenameWindow = false;

    // Act (Part 2: even if lock was marked lost while temporarily moved, once restored with same nonce, unlock() must unlink it)
    const savedEntry = files.get(targetLockPath)!;
    files.delete(targetLockPath);
    await assert.rejects(() => holder.assertHeld(), /Authorization lock lost/);
    assert.equal(holder.isLost(), true);

    // Contender restores the holder's lock file via link() after seeing nonce mismatch
    files.set(targetLockPath, savedEntry);
    await holder();

    // Assert (Part 2: no zombie lock left behind)
    assert.equal(files.has(targetLockPath), false);
  });

  it("should rename a corrupt state file to *.corrupt-<ts> and throw McpError with code config without overwriting the backup", async () => {
    // Arrange
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-corrupt-state-"));
    const serverName = "corrupt-server";
    const filePath = statePath(serverName, dir);
    const corruptContent = "{invalid-json-content";

    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(filePath, corruptContent, { encoding: "utf8", mode: 0o600 });
      const provider = new McpOAuthProvider(serverName, {}, undefined, dir);

      // Act & Assert (First read backs up the corrupt file and throws McpError(code="config"))
      let backupFilePath = "";
      await assert.rejects(
        () => provider.tokens(),
        (err: unknown) => {
          assert.ok(err instanceof McpError);
          assert.equal(err.code, "config");
          assert.equal(err.server, serverName);
          const match = err.message.match(/backed up to (.+\.corrupt-\d+)/);
          assert.ok(match?.[1], `Expected backup path in message: ${err.message}`);
          backupFilePath = match[1];
          return true;
        },
      );

      assert.equal(await readFile(backupFilePath, "utf8"), corruptContent);

      // Act & Assert (Second read sees ENOENT on state file and does not overwrite or duplicate backup)
      const statusAfter = await getAuthStatus(serverName, dir);
      assert.equal(statusAfter, null);
      const entries = (await readdir(dir)).filter((name) => name.includes(".corrupt-"));
      assert.equal(entries.length, 1);
      assert.equal(await readFile(backupFilePath, "utf8"), corruptContent);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("should keep PKCE codeVerifier in memory only and drop legacy codeVerifier from state file on next save", async () => {
    // Arrange
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-pkce-memory-"));
    const serverName = "pkce-server";
    const filePath = statePath(serverName, dir);

    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(
        filePath,
        JSON.stringify({
          tokens: { access_token: "initial-token", token_type: "Bearer" },
          codeVerifier: "legacy-disk-verifier",
        }),
        "utf8",
      );

      const provider = new McpOAuthProvider(serverName, {}, undefined, dir);

      // Act
      await assert.rejects(() => provider.codeVerifier(), /No PKCE code verifier/);
      await provider.saveCodeVerifier("in-memory-verifier");
      await provider.saveTokens({ access_token: "updated-token", token_type: "Bearer" });

      // Assert
      assert.equal(await provider.codeVerifier(), "in-memory-verifier");
      const rawDisk = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
      assert.equal("codeVerifier" in rawDisk, false);
      assert.equal((rawDisk.tokens as { access_token: string }).access_token, "updated-token");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
