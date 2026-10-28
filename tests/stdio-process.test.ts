import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createLineSplitter,
  destroyStdioStreams,
  ensurePidTerminated,
  indexProcessTable,
  instrumentStdioTransport,
  isPidAlive,
  listDescendantPids,
  waitForChildClose,
  type StdioProcessDeps,
} from "../src/stdio-process.js";

function createEsrchError(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error("kill ESRCH");
  err.code = "ESRCH";
  return err;
}

function createEpermError(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error("kill EPERM");
  err.code = "EPERM";
  return err;
}

describe("stdio-process", () => {
  describe("createLineSplitter", () => {
    it("splits lines across arbitrary chunk boundaries and flushes trailing content once on end()", () => {
      const lines: string[] = [];
      const splitter = createLineSplitter((line) => lines.push(line));

      splitter.write(Buffer.from("first ", "utf8"));
      assert.deepEqual(lines, []);

      splitter.write(Buffer.from("line\nsec", "utf8"));
      assert.deepEqual(lines, ["first line"]);

      splitter.write(Buffer.from("ond line\n\nthird", "utf8"));
      assert.deepEqual(lines, ["first line", "second line", ""]);

      splitter.end();
      assert.deepEqual(lines, ["first line", "second line", "", "third"]);

      // Idempotent: subsequent end() calls must not re-emit
      splitter.end();
      assert.deepEqual(lines, ["first line", "second line", "", "third"]);
    });

    it("reassembles multi-byte UTF-8 code points split across chunk boundaries", () => {
      const lines: string[] = [];
      const splitter = createLineSplitter((line) => lines.push(line));

      // "🚀" is 4 bytes (F0 9F 9A 80); "é" is 2 bytes (C3 A9)
      const fullPayload = Buffer.from("launch 🚀 pad\ncafé", "utf8");
      const rocketOffset = fullPayload.indexOf(0xf0);
      assert.ok(rocketOffset > 0);

      // Split right inside the 4-byte emoji and inside the 2-byte accented char
      const chunk1 = fullPayload.subarray(0, rocketOffset + 2);
      const chunk2 = fullPayload.subarray(rocketOffset + 2, fullPayload.length - 1);
      const chunk3 = fullPayload.subarray(fullPayload.length - 1);

      splitter.write(chunk1);
      assert.deepEqual(lines, []);

      splitter.write(chunk2);
      assert.deepEqual(lines, ["launch 🚀 pad"]);

      splitter.write(chunk3);
      splitter.end();
      splitter.end();

      assert.deepEqual(lines, ["launch 🚀 pad", "café"]);
    });

    it("flush() emits the decoded remainder without finalising a split UTF-8 character", () => {
      const lines: string[] = [];
      const splitter = createLineSplitter((line) => lines.push(line));
      const payload = Buffer.from("fatal 🚀", "utf8");

      // Cut inside the 4-byte emoji: the decoder holds the incomplete sequence.
      splitter.write(payload.subarray(0, 8));
      splitter.flush();
      assert.deepEqual(lines, ["fatal "]);

      splitter.write(payload.subarray(8));
      splitter.end();
      assert.deepEqual(lines, ["fatal ", "🚀"]);
      assert.ok(
        lines.every((line) => !line.includes("\uFFFD")),
        `expected no replacement characters, got ${JSON.stringify(lines)}`,
      );
    });

    it("does not emit on end() when there is no trailing remainder", () => {
      const lines: string[] = [];
      const splitter = createLineSplitter((line) => lines.push(line));

      splitter.write(Buffer.from("complete\n", "utf8"));
      splitter.end();
      splitter.end();

      assert.deepEqual(lines, ["complete"]);
    });
  });

  describe("instrumentStdioTransport", () => {
    it("captures PID early during start(), memoizes close(), and flushes stderr once across end and close", async () => {
      const stderrStream = new EventEmitter();
      const capturedPids: number[] = [];
      const stderrLines: string[] = [];
      let closeCallCount = 0;
      let resolveStart!: () => void;

      interface FakeStdioTransport {
        _process: { pid?: number } | undefined;
        pid: number | null;
        stderr: EventEmitter | null;
        start(): Promise<void>;
        close(): Promise<void>;
      }

      const fakeTransport: FakeStdioTransport = {
        _process: undefined,
        pid: null,
        stderr: stderrStream,
        start(): Promise<void> {
          fakeTransport._process = { pid: 4242 };
          return new Promise<void>((resolve) => {
            resolveStart = () => {
              fakeTransport.pid = 4242;
              resolve();
            };
          });
        },
        close(): Promise<void> {
          closeCallCount += 1;
          fakeTransport._process = undefined;
          return Promise.resolve();
        },
      };

      instrumentStdioTransport(fakeTransport as unknown as StdioClientTransport, {
        onPid: (pid) => capturedPids.push(pid),
        onStderrLine: (line) => stderrLines.push(line),
      });

      const startPromise = fakeTransport.start();
      // PID captured synchronously before start() resolves
      assert.deepEqual(capturedPids, [4242]);

      resolveStart();
      await startPromise;
      assert.deepEqual(capturedPids, [4242, 4242]);

      // Memoized close()
      const close1 = fakeTransport.close();
      const close2 = fakeTransport.close();
      assert.equal(close1, close2);
      await Promise.all([close1, close2]);
      assert.equal(closeCallCount, 1);

      // Stderr line splitting and idempotent flush across end + close
      stderrStream.emit("data", Buffer.from("warn 1\nwarn ", "utf8"));
      stderrStream.emit("data", Buffer.from("2", "utf8"));
      stderrStream.emit("end");
      stderrStream.emit("close");
      assert.deepEqual(stderrLines, ["warn 1", "warn 2"]);
    });

    it("falls back to transport.pid when _process.pid is unavailable", async () => {
      const capturedPids: number[] = [];
      const fakeTransport = {
        pid: 7777,
        stderr: null,
        start(): Promise<void> {
          return Promise.resolve();
        },
        close(): Promise<void> {
          return Promise.resolve();
        },
      } as unknown as StdioClientTransport;

      instrumentStdioTransport(fakeTransport, {
        onPid: (pid) => capturedPids.push(pid),
        onStderrLine: () => {},
      });

      await fakeTransport.start();
      assert.deepEqual(capturedPids, [7777]);
    });

    it("flushes a buffered partial stderr line when close() settles without the stream ending (#206)", async () => {
      const stderrStream = new EventEmitter();
      const lines: string[] = [];
      const fakeTransport = {
        pid: 5050,
        stderr: stderrStream,
        start(): Promise<void> {
          return Promise.resolve();
        },
        close(): Promise<void> {
          return Promise.resolve();
        },
      } as unknown as StdioClientTransport;

      instrumentStdioTransport(fakeTransport, {
        onPid: () => {},
        onStderrLine: (line) => lines.push(line),
      });
      await fakeTransport.start();

      // A line with no trailing newline stays buffered; nothing ends the stream here because
      // the SDK's PassThrough is only ended by the child's own stderr reaching EOF.
      stderrStream.emit("data", Buffer.from("FATAL: Missing API_KEY", "utf8"));
      assert.deepEqual(lines, []);

      await fakeTransport.close();
      assert.deepEqual(lines, ["FATAL: Missing API_KEY"]);
      assert.equal(stderrStream.listenerCount("end"), 1, "close() must not re-wire the stream");
    });

    it("still flushes the partial stderr line when close() rejects (#206)", async () => {
      const stderrStream = new EventEmitter();
      const lines: string[] = [];
      const closeFailure = new Error("close failed");
      const fakeTransport = {
        pid: 5051,
        stderr: stderrStream,
        start(): Promise<void> {
          return Promise.resolve();
        },
        close(): Promise<void> {
          return Promise.reject(closeFailure);
        },
      } as unknown as StdioClientTransport;

      instrumentStdioTransport(fakeTransport, {
        onPid: () => {},
        onStderrLine: (line) => lines.push(line),
      });
      await fakeTransport.start();
      stderrStream.emit("data", Buffer.from("FATAL: crash during close", "utf8"));

      await assert.rejects(() => fakeTransport.close(), closeFailure);
      assert.deepEqual(lines, ["FATAL: crash during close"]);
    });

    it("keeps splitting chunks that arrive after the close-triggered flush (#206)", async () => {
      const stderrStream = new EventEmitter();
      const lines: string[] = [];
      const fakeTransport = {
        pid: 5052,
        stderr: stderrStream,
        start(): Promise<void> {
          return Promise.resolve();
        },
        close(): Promise<void> {
          return Promise.resolve();
        },
      } as unknown as StdioClientTransport;

      instrumentStdioTransport(fakeTransport, {
        onPid: () => {},
        onStderrLine: (line) => lines.push(line),
      });
      await fakeTransport.start();

      stderrStream.emit("data", Buffer.from("first partial", "utf8"));
      await fakeTransport.close();
      assert.deepEqual(lines, ["first partial"]);

      // Bytes that were still in flight when close() settled must not be lost, and must not be
      // re-emitted as part of the already-flushed line.
      stderrStream.emit("data", Buffer.from("second line\nthird partial", "utf8"));
      stderrStream.emit("end");
      assert.deepEqual(lines, ["first partial", "second line", "third partial"]);
    });

    it("does not corrupt a UTF-8 character split across the close boundary (#206)", async () => {
      const stderrStream = new EventEmitter();
      const lines: string[] = [];
      const fakeTransport = {
        pid: 5053,
        stderr: stderrStream,
        start(): Promise<void> {
          return Promise.resolve();
        },
        close(): Promise<void> {
          return Promise.resolve();
        },
      } as unknown as StdioClientTransport;

      instrumentStdioTransport(fakeTransport, {
        onPid: () => {},
        onStderrLine: (line) => lines.push(line),
      });
      await fakeTransport.start();

      const payload = Buffer.from("fatal 🚀\n", "utf8");
      stderrStream.emit("data", payload.subarray(0, 8)); // ends inside the emoji
      await fakeTransport.close();
      // The close-time flush must be provisional: finalising the decoder here would replace the
      // half-decoded character with U+FFFD and corrupt the line.
      assert.deepEqual(lines, ["fatal "]);

      stderrStream.emit("data", payload.subarray(8));
      stderrStream.emit("end");
      assert.deepEqual(lines, ["fatal ", "🚀"]);
      assert.ok(
        lines.every((line) => !line.includes("\uFFFD")),
        `expected no replacement characters, got ${JSON.stringify(lines)}`,
      );
    });

    it("flushes the partial stderr line on close when a grandchild keeps the pipe open (#206)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-stderr-flush-"));
      const pidFile = join(dir, "grandchild.pid");
      const wrapperScript = join(dir, "wrapper.mjs");

      await writeFile(
        wrapperScript,
        `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

process.stderr.write("FATAL: Missing API_KEY (no newline)");
// A wrapper such as npx / uvx: the MCP server is a grandchild that inherits the wrapper's
// stderr write end, so the wrapper's own 'close' event never fires while the grandchild lives
// and the SDK never ends its stderr PassThrough.
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: ["ignore", "ignore", "inherit"],
  detached: true,
});
child.unref();
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`,
      );

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [wrapperScript],
        stderr: "pipe",
      });
      const lines: string[] = [];
      instrumentStdioTransport(transport, {
        onPid: () => {},
        onStderrLine: (line) => lines.push(line),
      });

      let grandchildPid: number | undefined;
      try {
        await transport.start();
        for (let i = 0; i < 100 && !existsSync(pidFile); i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(existsSync(pidFile), `Expected the grandchild PID file at ${pidFile}`);
        grandchildPid = Number(await readFile(pidFile, "utf8"));
        assert.ok(grandchildPid > 0, "Expected a grandchild PID");

        // No 'end'/'close' will ever fire: the grandchild holds the pipe. Only close() can
        // release the buffered line.
        await transport.close();
        assert.deepEqual(lines, ["FATAL: Missing API_KEY (no newline)"]);
      } finally {
        if (grandchildPid) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // WHY: The grandchild may already be gone (killed with the wrapper on some platforms).
          }
        }
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("isPidAlive & ensurePidTerminated", () => {
    it("isPidAlive returns true on signal 0 success or EPERM, and false on ESRCH", () => {
      assert.equal(
        isPidAlive(100, {
          kill: () => true,
        }),
        true,
      );
      assert.equal(
        isPidAlive(100, {
          kill: () => {
            throw createEpermError();
          },
        }),
        true,
      );
      assert.equal(
        isPidAlive(100, {
          kill: () => {
            throw createEsrchError();
          },
        }),
        false,
      );
    });

    it("is a no-op when pid is null, undefined, 0, or already dead", async () => {
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      const deps: StdioProcessDeps = {
        kill: (_pid, signal) => {
          signals.push(signal);
          throw createEsrchError();
        },
        sleep: async () => {
          throw new Error("sleep should not be called");
        },
        now: () => 0,
        listDescendantPids: async () => [],
      };

      await ensurePidTerminated(null, deps);
      await ensurePidTerminated(undefined, deps);
      await ensurePidTerminated(0, deps);
      assert.deepEqual(signals, []);

      await ensurePidTerminated(1234, deps);
      assert.deepEqual(signals, [0]);
    });

    it("stops waiting as soon as process exits after SIGTERM", async () => {
      let currentNow = 1_000;
      let aliveChecksAfterTerm = 0;
      let alive = true;
      const calls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
      const sleeps: number[] = [];

      const deps: StdioProcessDeps = {
        kill: (pid, signal) => {
          calls.push({ pid, signal });
          if (signal === 0) {
            if (!alive) {
              throw createEsrchError();
            }
            if (calls.some((c) => c.signal === "SIGTERM")) {
              aliveChecksAfterTerm += 1;
              if (aliveChecksAfterTerm >= 3) {
                alive = false;
                throw createEsrchError();
              }
            }
            return true;
          }
          return true;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
          currentNow += ms;
        },
        now: () => currentNow,
        listDescendantPids: async () => [],
      };

      await ensurePidTerminated(5555, deps);

      assert.ok(calls.some((c) => c.signal === "SIGTERM"));
      assert.ok(!calls.some((c) => c.signal === "SIGKILL"));
      assert.deepEqual(sleeps, [25, 25]);
    });

    it("escalates SIGTERM → bounded wait → SIGKILL when process ignores SIGTERM", async () => {
      let currentNow = 10_000;
      let killedWithSigkill = false;
      let postKillPolls = 0;
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      const sleeps: number[] = [];

      const deps: StdioProcessDeps = {
        kill: (_pid, signal) => {
          signals.push(signal);
          if (signal === 0) {
            if (killedWithSigkill) {
              postKillPolls += 1;
              if (postKillPolls >= 2) {
                throw createEsrchError();
              }
            }
            return true;
          }
          if (signal === "SIGKILL") {
            killedWithSigkill = true;
          }
          return true;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
          currentNow += ms;
        },
        now: () => currentNow,
        listDescendantPids: async () => [],
      };

      await ensurePidTerminated(9999, deps);

      const nonZeroSignals = signals.filter((s) => s !== 0);
      assert.deepEqual(nonZeroSignals, ["SIGTERM", "SIGKILL"]);
      // 500ms SIGTERM window in 25ms increments (20 sleeps) + 1 sleep after SIGKILL before 2nd poll sees ESRCH
      assert.equal(sleeps.length, 21);
      assert.ok(sleeps.every((ms) => ms === 25));
    });

    it("handles ESRCH thrown directly by kill(SIGTERM) or kill(SIGKILL)", async () => {
      let currentNow = 0;
      const depsTermRace: StdioProcessDeps = {
        kill: (_pid, signal) => {
          if (signal === "SIGTERM") {
            throw createEsrchError();
          }
          return true;
        },
        sleep: async () => {
          throw new Error("should not sleep when SIGTERM sees ESRCH");
        },
        now: () => currentNow,
        listDescendantPids: async () => [],
      };
      await ensurePidTerminated(1111, depsTermRace);

      const signalsKillRace: Array<NodeJS.Signals | number | undefined> = [];
      const depsKillRace: StdioProcessDeps = {
        kill: (_pid, signal) => {
          signalsKillRace.push(signal);
          if (signal === "SIGKILL") {
            throw createEsrchError();
          }
          return true;
        },
        sleep: async (ms) => {
          currentNow += ms;
        },
        now: () => currentNow,
        listDescendantPids: async () => [],
      };
      await ensurePidTerminated(2222, depsKillRace);
      assert.deepEqual(
        signalsKillRace.filter((s) => s !== 0),
        ["SIGTERM", "SIGKILL"],
      );
    });
  });

  describe("descendant process tree (Issue #205)", () => {
    /** Run `run` with `process.platform` overridden, then restore the real platform. */
    async function withPlatform(platform: NodeJS.Platform, run: () => Promise<void>): Promise<void> {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      // WHY: Descendant discovery dispatches on process.platform; redefining it is the only
      // way to exercise the macOS/Windows branches from the Linux runner that measures coverage.
      Object.defineProperty(process, "platform", {
        configurable: true,
        enumerable: true,
        value: platform,
      });
      try {
        await run();
      } finally {
        if (descriptor) Object.defineProperty(process, "platform", descriptor);
      }
    }

    async function spawnHangingChild(): Promise<{ pid: number; kill(): void }> {
      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        stdio: "ignore",
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      assert.ok(child.pid, "expected a spawned child PID");
      return { pid: child.pid, kill: () => void child.kill("SIGKILL") };
    }

    it("signals descendants deepest-first before the wrapper and escalates SIGKILL to survivors", async () => {
      let currentNow = 0;
      const calls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
      const alive = new Set<number>([1000, 1001, 1002]);

      const deps: StdioProcessDeps = {
        kill: (pid, signal) => {
          calls.push({ pid, signal });
          if (signal === 0) {
            if (!alive.has(pid)) throw createEsrchError();
            return true;
          }
          // The wrapper ignores SIGTERM; its descendants honour it.
          if (signal === "SIGTERM" && pid !== 1000) alive.delete(pid);
          if (signal === "SIGKILL") alive.delete(pid);
          return true;
        },
        sleep: async (ms) => {
          currentNow += ms;
        },
        now: () => currentNow,
        listDescendantPids: async () => [1002, 1001],
      };

      await ensurePidTerminated(1000, deps);

      assert.deepEqual(
        calls.filter((c) => c.signal === "SIGTERM").map((c) => c.pid),
        [1002, 1001, 1000],
      );
      // Only the wrapper survives SIGTERM, so escalation must not signal the reaped children.
      assert.deepEqual(
        calls.filter((c) => c.signal === "SIGKILL").map((c) => c.pid),
        [1000],
      );
      assert.deepEqual([...alive], []);
    });

    it("re-snapshots on escalation so children spawned during the SIGTERM window are killed too", async () => {
      let currentNow = 0;
      const sigkills: number[] = [];
      const alive = new Set<number>([2000, 2001, 2002]);
      let scans = 0;

      const deps: StdioProcessDeps = {
        kill: (pid, signal) => {
          if (signal === 0) {
            if (!alive.has(pid)) throw createEsrchError();
            return true;
          }
          // Everything ignores SIGTERM; only the SIGKILL escalation ends the tree.
          if (signal === "SIGKILL") {
            sigkills.push(pid);
            alive.delete(pid);
          }
          return true;
        },
        sleep: async (ms) => {
          currentNow += ms;
        },
        now: () => currentNow,
        listDescendantPids: async () => {
          scans += 1;
          return scans === 1 ? [2001] : [2001, 2002];
        },
      };

      await ensurePidTerminated(2000, deps);

      assert.equal(scans, 2);
      assert.deepEqual(sigkills.sort((a, b) => a - b), [2000, 2001, 2002]);
    });

    it("walks descendants of the calling process deepest-first through /proc or ps", {
      // WHY: Windows has no /proc or ps, so discovery is intentionally reported as empty there.
      skip: process.platform === "win32" && "Windows has no portable process-tree enumeration",
    }, async () => {
      const child = await spawnHangingChild();
      try {
        const descendants = await listDescendantPids(process.pid);
        assert.ok(
          descendants.includes(child.pid),
          `expected ${child.pid} among [${descendants.join(", ")}]`,
        );
        // WHY: no ordering assertion here — on macOS discovery shells out to `ps`, which is
        // itself a short-lived child of this process and lands in the snapshot too. Ordering
        // is covered deterministically by the injected-tree test above.
      } finally {
        child.kill();
      }
    });

    it("falls back to the ps process table on non-Linux POSIX platforms", {
      // WHY: the `ps` fallback is unreachable on Windows, which never shells out to ps.
      skip: process.platform === "win32" && "ps is a POSIX tool",
    }, async () => {
      const child = await spawnHangingChild();
      try {
        await withPlatform("darwin", async () => {
          const descendants = await listDescendantPids(process.pid);
          assert.ok(
            descendants.includes(child.pid),
            `expected ${child.pid} among [${descendants.join(", ")}]`,
          );
        });
      } finally {
        child.kill();
      }
    });

    it("reports no descendants on win32, where only the root PID can be signalled", async () => {
      await withPlatform("win32", async () => {
        assert.deepEqual(await listDescendantPids(process.pid), []);
      });
    });

    it("stops walking a tree that loops back on itself", async () => {
      const tree = new Map<number, number[]>([
        [1, [2]],
        [2, [1, 2, 3]],
        [3, []],
      ]);
      assert.deepEqual(await listDescendantPids(1, async (pid) => tree.get(pid) ?? []), [3, 2]);
    });

    it("reports no descendants when discovery is unavailable", async () => {
      const failure: NodeJS.ErrnoException = new Error("spawn ps ENOENT");
      failure.code = "ENOENT";
      assert.deepEqual(
        await listDescendantPids(1, async () => {
          throw failure;
        }),
        [],
      );
    });
  });

  describe("indexProcessTable", () => {
    it("indexes ps output by parent PID and ignores malformed rows", () => {
      const table = indexProcessTable("  1     0\n   42   1\n\n 43 1 \nnot a row\n");
      assert.deepEqual(table.get(0), [1]);
      assert.deepEqual(table.get(1), [42, 43]);
      assert.equal(table.get(999), undefined);
    });
  });

  describe("destroyStdioStreams", () => {
    it("destroys the recorded child pipes exactly once and ignores un-instrumented transports", async () => {
      const destroyed: string[] = [];
      const fakeChild = {
        pid: 31337,
        stdin: { destroy: () => destroyed.push("stdin") },
        stdout: { destroy: () => destroyed.push("stdout") },
        stderr: { destroy: () => destroyed.push("stderr") },
      };
      const fakeTransport = {
        _process: fakeChild as unknown,
        pid: fakeChild.pid,
        stderr: null,
        start(): Promise<void> {
          return Promise.resolve();
        },
        close(): Promise<void> {
          return Promise.resolve();
        },
      };

      instrumentStdioTransport(fakeTransport as unknown as StdioClientTransport, {
        onPid: () => {},
        onStderrLine: () => {},
      });
      await fakeTransport.start();

      destroyStdioStreams(fakeTransport);
      // stdin is our write end; the SDK still ends it as part of its own close sequence.
      assert.deepEqual(destroyed, ["stdout", "stderr"]);

      destroyStdioStreams(fakeTransport);
      destroyStdioStreams({});
      destroyStdioStreams(undefined);
      assert.deepEqual(destroyed, ["stdout", "stderr"]);
    });

    it("flushes the buffered partial stderr line before destroying the pipes", async () => {
      const stderrStream = new EventEmitter();
      const lines: string[] = [];
      const destroyed: string[] = [];
      const fakeTransport = {
        _process: {
          pid: 4242,
          stdout: { destroy: () => destroyed.push("stdout") },
          stderr: { destroy: () => destroyed.push("stderr") },
        },
        pid: 4242,
        stderr: stderrStream,
        start(): Promise<void> {
          return Promise.resolve();
        },
        close(): Promise<void> {
          return Promise.resolve();
        },
      };

      instrumentStdioTransport(fakeTransport as unknown as StdioClientTransport, {
        onPid: () => {},
        onStderrLine: (line) => lines.push(line),
      });
      await fakeTransport.start();

      // A line with no trailing newline stays buffered until something ends the stream;
      // destroying the pipe would otherwise drop the server's last words.
      stderrStream.emit("data", Buffer.from("no trailing newline", "utf8"));
      assert.deepEqual(lines, []);

      destroyStdioStreams(fakeTransport);
      assert.deepEqual(lines, ["no trailing newline"]);
      assert.deepEqual(destroyed, ["stdout", "stderr"]);
    });

    it("waitForChildClose resolves immediately on close and times out when a survivor holds pipes open", async () => {
      await waitForChildClose(null);
      await waitForChildClose({});

      const childProc = Object.assign(new EventEmitter(), { pid: 5150 });
      const fakeTransport = {
        _process: childProc as unknown,
        pid: 5150,
        stderr: null,
        start(): Promise<void> {
          return Promise.resolve();
        },
        close(): Promise<void> {
          return Promise.resolve();
        },
      };

      instrumentStdioTransport(fakeTransport as unknown as StdioClientTransport, {
        onPid: () => {},
        onStderrLine: () => {},
      });
      await fakeTransport.start();

      // Bounded timeout when the child has not emitted 'close' yet
      await waitForChildClose(fakeTransport, 10);

      // Immediate resolution once 'close' fires
      setImmediate(() => childProc.emit("close", 0, null));
      await waitForChildClose(fakeTransport, 500);

      // Subsequent calls return immediately because record.closed is true
      await waitForChildClose(fakeTransport, 500);
    });
  });
});

