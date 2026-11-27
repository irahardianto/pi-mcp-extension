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
  getStdioSpawnError,
  indexProcessTable,
  instrumentStdioTransport,
  isPidAlive,
  listDescendantPids,
  POST_CLOSE_FLUSH_DELAY_MS,
  resolveTransportPid,
  terminateStdioTree,
  waitForChildClose,
  type StdioProcessDeps,
} from "../src/stdio-process.js";
import {
  StdioExitGuard,
  countPassiveSigintListeners,
  listDescendantPidsSync,
  terminatePidTreeSync,
  type SignalExitProcess,
} from "../src/stdio-exit-guard.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      // re-emitted as part of the already-flushed line. Nothing ends the stream here — the SDK
      // never does when a descendant holds the pipe — so the post-close remainder is released
      // once the stream goes quiet.
      stderrStream.emit("data", Buffer.from("second line\nthird partial", "utf8"));
      await sleep(POST_CLOSE_FLUSH_DELAY_MS * 2);
      assert.deepEqual(lines, ["first partial", "second line", "third partial"]);

      stderrStream.emit("end");
      assert.deepEqual(lines, ["first partial", "second line", "third partial"]);
    });

    it("keeps a post-close line whole when its chunks arrive in different ticks (#206)", async () => {
      const stderrStream = new EventEmitter();
      const lines: string[] = [];
      const fakeTransport = {
        pid: 5054,
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
      await fakeTransport.close();

      // A chunk boundary must not become a line boundary: one line, two ticks.
      stderrStream.emit("data", Buffer.from("hel", "utf8"));
      await new Promise((resolve) => setImmediate(resolve));
      stderrStream.emit("data", Buffer.from("lo\n", "utf8"));
      await sleep(POST_CLOSE_FLUSH_DELAY_MS * 2);

      assert.deepEqual(lines, ["hello"]);
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

      const payload = Buffer.from("fatal 🚀", "utf8");
      stderrStream.emit("data", payload.subarray(0, 8)); // ends inside the emoji
      await fakeTransport.close();
      // The close-time flush must be provisional: finalising the decoder here would replace the
      // half-decoded character with U+FFFD and corrupt the line.
      assert.deepEqual(lines, ["fatal "]);

      // The completing bytes arrive after close with no trailing newline and the stream never
      // ends: the post-close quiet-window flush must release them intact without U+FFFD.
      stderrStream.emit("data", payload.subarray(8));
      await sleep(POST_CLOSE_FLUSH_DELAY_MS * 2);
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

    it("captures non-retryable spawn errnos even on pid-less processes and deduplicates listeners", async () => {
      assert.equal(getStdioSpawnError(null), undefined);
      assert.equal(getStdioSpawnError(undefined), undefined);

      const procWithoutPid = new EventEmitter() as EventEmitter & { pid?: number };
      const fakeTransport = {
        _process: undefined as (EventEmitter & { pid?: number }) | undefined,
        pid: null,
        stderr: null,
        start(): Promise<void> {
          fakeTransport._process = procWithoutPid;
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

      // Even without a pid, the error listener was attached exactly once.
      assert.equal(procWithoutPid.listenerCount("error"), 1);
      const enoent = Object.assign(new Error("spawn uvx ENOENT"), { code: "ENOENT" });
      procWithoutPid.emit("error", enoent);
      assert.equal(getStdioSpawnError(fakeTransport), enoent);

      // Non-spawn errors (e.g. generic runtime errors) are not captured as spawn failures.
      const procWithPid = new EventEmitter() as EventEmitter & { pid?: number };
      procWithPid.pid = 8181;
      const otherTransport = {
        _process: procWithPid,
        pid: 8181,
        stderr: null,
        start(): Promise<void> {
          return Promise.resolve();
        },
        close(): Promise<void> {
          return Promise.resolve();
        },
      };
      instrumentStdioTransport(otherTransport as unknown as StdioClientTransport, {
        onPid: () => {},
        onStderrLine: () => {},
      });
      await otherTransport.start();
      assert.equal(procWithPid.listenerCount("error"), 1);
      procWithPid.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
      assert.equal(getStdioSpawnError(otherTransport), undefined);
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

    it("returns immediately when the PID is not ours to signal (EPERM on kill 0)", async () => {
      const calls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
      let scans = 0;
      const deps: StdioProcessDeps = {
        kill: (pid, signal) => {
          calls.push({ pid, signal });
          throw createEpermError();
        },
        sleep: async () => {
          throw new Error("must not poll a PID the caller cannot signal (Issue #203)");
        },
        now: () => 0,
        listDescendantPids: async () => {
          scans += 1;
          return [];
        },
      };

      await ensurePidTerminated(12345, deps);

      // Only the liveness probe: no SIGTERM/SIGKILL against a PID we do not own.
      assert.deepEqual(calls, [{ pid: 12345, signal: 0 }]);
      // The snapshot still runs — an out-of-reach root can own descendants that are ours.
      assert.equal(scans, 1);
    });

    it("signals the reachable descendants of a root nobody can signal", async () => {
      const calls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
      let descendantAlive = true;
      const deps: StdioProcessDeps = {
        kill: (pid, signal) => {
          calls.push({ pid, signal });
          // A privileged wrapper: alive, but out of reach for every signal including 0.
          if (pid === 5000) {
            throw createEpermError();
          }
          if (signal === "SIGTERM") {
            descendantAlive = false;
          }
          if (signal === 0 && !descendantAlive) {
            throw createEsrchError();
          }
        },
        sleep: async () => {
          throw new Error("the reachable descendant exits without a wait window");
        },
        now: () => 0,
        listDescendantPids: async () => [6000],
      };

      await ensurePidTerminated(5000, deps);

      // The wrapper is never signalled, but its descendant — which we can reach — still is.
      assert.deepEqual(
        calls.filter((c) => c.signal !== 0).map((c) => [c.pid, c.signal]),
        [[6000, "SIGTERM"]],
      );
    });

    it("escalates to SIGKILL when only SIGTERM is refused (policy-mediated permissions)", async () => {
      let currentNow = 0;
      let dead = false;
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      const sleeps: number[] = [];

      const deps: StdioProcessDeps = {
        kill: (_pid, signal) => {
          signals.push(signal);
          if (signal === 0 && dead) {
            throw createEsrchError();
          }
          // SELinux keeps separate sigterm/sigkill permissions, AppArmor matches a signal set,
          // and a seccomp filter can match the signal argument: SIGTERM can be refused while
          // SIGKILL is allowed.
          if (signal === "SIGTERM") {
            throw createEpermError();
          }
          if (signal === "SIGKILL") {
            dead = true;
          }
        },
        sleep: async (ms) => {
          sleeps.push(ms);
          currentNow += ms;
        },
        now: () => currentNow,
        listDescendantPids: async () => [],
      };

      await ensurePidTerminated(7777, deps);

      // The refusal must not be read as "already gone": the child is still signalable, so the
      // escalation that ends it has to run — and immediately, since SIGTERM delivered nothing.
      assert.deepEqual(
        signals.filter((s) => s !== 0),
        ["SIGTERM", "SIGKILL"],
      );
      assert.deepEqual(sleeps, []);
    });

    it("waits only for the targets that accepted the signal, then escalates the refused root", async () => {
      let currentNow = 0;
      let descendantDead = false;
      const polls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
      const sleeps: number[] = [];

      const deps: StdioProcessDeps = {
        kill: (pid, signal) => {
          polls.push({ pid, signal });
          if (pid === 1000 && signal !== 0) {
            throw createEpermError();
          }
          if (pid === 1001 && signal === 0 && descendantDead) {
            throw createEsrchError();
          }
        },
        sleep: async (ms) => {
          sleeps.push(ms);
          currentNow += ms;
          // The descendant honours SIGTERM and is gone once 50ms of the window have elapsed.
          // Time-based on purpose: the probe count is an implementation detail this test must
          // not depend on.
          if (currentNow >= 50) {
            descendantDead = true;
          }
        },
        now: () => currentNow,
        listDescendantPids: async () => [1001],
      };

      await ensurePidTerminated(1000, deps);

      // The wrapper refuses SIGTERM; the descendant honours it, so only the descendant's exit is
      // polled — and the wrapper, still signalable, is then escalated to SIGKILL instead of
      // being left running or waited on for a window it can never end.
      assert.deepEqual(sleeps, [25, 25]);
      assert.deepEqual(
        polls.filter((c) => c.signal === "SIGKILL").map((c) => c.pid),
        [1000],
      );
      assert.ok(!polls.some((c) => c.pid === 1001 && c.signal === "SIGKILL"));
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

      await fakeTransport.close();
      assert.deepEqual(lines, ["no trailing newline"]);

      // A post-close chunk schedules the quiet-window timer; destroyStdioStreams must flush it
      // immediately and cancel the pending timer before destroying the pipes.
      stderrStream.emit("data", Buffer.from("post-close trailing", "utf8"));
      assert.deepEqual(lines, ["no trailing newline"]);

      destroyStdioStreams(fakeTransport);
      assert.deepEqual(lines, ["no trailing newline", "post-close trailing"]);
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


describe("resolveTransportPid", () => {
  interface FakePipes {
    destroyed: boolean;
    destroy(): void;
  }

  function createPipes(): FakePipes {
    return {
      destroyed: false,
      destroy(): void {
        this.destroyed = true;
      },
    };
  }

  function createChild(pid: number): EventEmitter & {
    pid: number;
    stdout: FakePipes;
    stderr: FakePipes;
  } {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: FakePipes;
      stderr: FakePipes;
    };
    child.pid = pid;
    child.stdout = createPipes();
    child.stderr = createPipes();
    return child;
  }

  /**
   * A transport shaped like the SDK's: `pid` is a getter over `_process`, so both disappear
   * together when `close()` clears `_process` — only the instrumented record survives.
   */
  function createInstrumentedTransport(child: EventEmitter & { pid: number }): object {
    return {
      _process: child,
      get pid(): number | undefined {
        return (this as { _process?: { pid?: number } })._process?.pid;
      },
      stderr: null,
      start(): Promise<void> {
        return Promise.resolve();
      },
      close(): Promise<void> {
        return Promise.resolve();
      },
    };
  }

  it("prefers the recorded child PID over every transport source", () => {
    assert.equal(resolveTransportPid(1234, { pid: 999 }), 1234);
  });

  it("keeps the spawned PID reachable after the SDK clears _process", async () => {
    const child = createChild(4242);
    const transport = createInstrumentedTransport(child);
    instrumentStdioTransport(transport as unknown as StdioClientTransport, {
      onPid: () => {},
      onStderrLine: () => {},
    });
    await (transport as { start(): Promise<void> }).start();

    // WHY: StdioClientTransport.close() clears `_process` synchronously, which also empties
    // the `pid` getter; only the instrumented record still knows the PID at teardown time.
    delete (transport as { _process?: unknown })._process;
    assert.equal((transport as { pid?: number }).pid, undefined);
    assert.equal(resolveTransportPid(null, transport), 4242);
  });

  it("ignores every PID source once the child has closed, including the recorded one", async () => {
    const child = createChild(6161);
    const transport = createInstrumentedTransport(child);
    instrumentStdioTransport(transport as unknown as StdioClientTransport, {
      onPid: () => {},
      onStderrLine: () => {},
    });
    await (transport as { start(): Promise<void> }).start();

    child.emit("close", 0, null);
    delete (transport as { _process?: unknown })._process;
    // WHY: `server.childPid` is never cleared when the child exits by itself, so the crash →
    // onclose → _recover → _shutdown path hands the stale PID in as `recordedPid`. A released
    // PID can belong to an unrelated process by then; teardown must not signal it.
    assert.equal(resolveTransportPid(6161, transport), null);
    assert.equal(resolveTransportPid(6161, null), 6161);
  });

  it("falls back to the transport's own _process.pid when it was never instrumented", () => {
    assert.equal(resolveTransportPid(undefined, { _process: { pid: 777 } }), 777);
  });

  it("falls back to the public transport.pid last", () => {
    assert.equal(resolveTransportPid(undefined, { pid: 555 }), 555);
  });

  it("returns null when no source knows a PID", () => {
    assert.equal(resolveTransportPid(null, null), null);
    assert.equal(resolveTransportPid(undefined, undefined), null);
    assert.equal(resolveTransportPid(null, {}), null);
    assert.equal(resolveTransportPid(null, { pid: "not-a-pid" }), null);
  });

  it("rejects zero, negative, NaN, and non-integer PIDs and falls through to valid positive sources", () => {
    // WHY: POSIX kill(0, sig) signals the caller's entire process group and kill(-1, sig)
    // signals every process of the current uid, so non-positive/non-integer candidates must
    // never be returned as teardown targets or mask a valid positive fallback PID.
    assert.equal(resolveTransportPid(0, null), null);
    assert.equal(resolveTransportPid(-1, null), null);
    assert.equal(resolveTransportPid(Number.NaN, null), null);
    assert.equal(resolveTransportPid(12.5, null), null);

    assert.equal(resolveTransportPid(0, { _process: { pid: 777 } }), 777);
    assert.equal(resolveTransportPid(-1, { pid: 555 }), 555);
    assert.equal(resolveTransportPid(Number.NaN, { _process: { pid: 0 }, pid: 888 }), 888);
    assert.equal(resolveTransportPid(null, { _process: { pid: -5 }, pid: 0 }), null);
    assert.equal(resolveTransportPid(null, { pid: 12.5 }), null);
  });
});

describe("terminateStdioTree", () => {
  function createDeps(overrides: Partial<StdioProcessDeps> = {}): {
    deps: StdioProcessDeps;
    killed: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }>;
  } {
    const killed: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    let clock = 0;
    const deps: StdioProcessDeps = {
      kill(pid, signal) {
        killed.push({ pid, signal });
      },
      sleep(ms) {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
      listDescendantPids: () => Promise.resolve([]),
      ...overrides,
    };
    return { deps, killed };
  }

  it("kills the tree through the injected process deps", async () => {
    const { deps, killed } = createDeps();
    await terminateStdioTree(1234, null, deps);
    assert.ok(killed.some((call) => call.signal === "SIGTERM" && call.pid === 1234));
    assert.ok(killed.some((call) => call.signal === "SIGKILL" && call.pid === 1234));
  });

  it("is a no-op for a server with no child process", async () => {
    const { deps, killed } = createDeps();
    await terminateStdioTree(null, null, deps);
    assert.deepEqual(killed, []);
  });

  it("releases the child's pipes after the tree is gone, even when a descendant held them", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 5150,
      stdout: { destroyed: false, destroy(): void { this.destroyed = true; } },
      stderr: { destroyed: false, destroy(): void { this.destroyed = true; } },
    });
    const transport = {
      _process: child,
      pid: 5150,
      stderr: null,
      start(): Promise<void> {
        return Promise.resolve();
      },
      close(): Promise<void> {
        return Promise.resolve();
      },
    };
    instrumentStdioTransport(transport as unknown as StdioClientTransport, {
      onPid: () => {},
      onStderrLine: () => {},
    });
    await transport.start();
    child.emit("close", 0, null);

    const { deps } = createDeps({
      kill() {
        // WHY: the child already exited — teardown must not wait on a PID that is gone.
        throw createEsrchError();
      },
    });
    await terminateStdioTree(5150, transport, deps);

    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
  });
});

describe("StdioExitGuard and sync tree cleanup (#336)", () => {
  function createFakeProcess(pid = 9999): {
    proc: SignalExitProcess & EventEmitter;
    kills: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }>;
    exits: number[];
    setKillThrow(err: Error | null): void;
  } {
    const emitter = new EventEmitter();
    const kills: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    const exits: number[] = [];
    let killError: Error | null = null;
    const proc = Object.assign(emitter, {
      pid,
      kill(targetPid: number, signal?: NodeJS.Signals | number): true {
        kills.push({ pid: targetPid, signal });
        if (killError) throw killError;
        return true;
      },
      exit(code?: number): never {
        exits.push(code ?? 0);
        return undefined as never;
      },
    }) as SignalExitProcess & EventEmitter;
    return {
      proc,
      kills,
      exits,
      setKillThrow: (err) => {
        killError = err;
      },
    };
  }

  it("counts passive signal-exit v3 (process) and v4 (globalThis) SIGINT listeners safely", () => {
    const v4Sym = Symbol.for("signal-exit emitter");
    assert.equal(countPassiveSigintListeners(null), 0);
    assert.equal(countPassiveSigintListeners("not-an-object"), 0);
    assert.equal(countPassiveSigintListeners({}), 0);
    assert.equal(countPassiveSigintListeners({ __signal_exit_emitter__: { count: 0 } }), 0);
    assert.equal(countPassiveSigintListeners({ __signal_exit_emitter__: { count: -1 } }), 0);
    assert.equal(countPassiveSigintListeners({ __signal_exit_emitter__: { count: 1.5 } }), 0);
    assert.equal(countPassiveSigintListeners({ __signal_exit_emitter__: { count: 1 } }), 1);

    // signal-exit v4 stores its emitter on globalThis, never on process.
    assert.equal(countPassiveSigintListeners({ [v4Sym]: { count: 2 } }), 0);
    assert.equal(countPassiveSigintListeners({}, { [v4Sym]: { count: 2 } }), 2);
    assert.equal(countPassiveSigintListeners({}, { [v4Sym]: { count: 0 } }), 0);
    assert.equal(
      countPassiveSigintListeners(
        { __signal_exit_emitter__: { count: 1 } },
        { [v4Sym]: { count: 1 } },
      ),
      2,
    );
  });

  it("attaches SIGINT and exit listeners only while live PIDs are tracked", () => {
    const { proc } = createFakeProcess();
    const guard = new StdioExitGuard({ proc, terminatePidTreeSync: () => {} });

    assert.equal(proc.listenerCount("SIGINT"), 0);
    assert.equal(proc.listenerCount("exit"), 0);

    // Invalid PIDs are ignored.
    guard.track(0);
    guard.track(-5);
    guard.track(Number.NaN);
    guard.track(12.5);
    assert.equal(guard.trackedCount(), 0);
    assert.equal(proc.listenerCount("SIGINT"), 0);

    guard.track(101);
    assert.equal(guard.trackedCount(), 1);
    assert.equal(proc.listenerCount("SIGINT"), 1);
    assert.equal(proc.listenerCount("exit"), 1);

    // Second PID reuses the same listeners.
    guard.track(102);
    guard.track(102);
    assert.equal(guard.trackedCount(), 2);
    assert.equal(proc.listenerCount("SIGINT"), 1);
    assert.equal(proc.listenerCount("exit"), 1);

    // Removing one keeps listeners attached; removing last detaches both.
    guard.untrack(101);
    guard.untrack(null);
    guard.untrack(undefined);
    guard.untrack(999);
    assert.equal(guard.trackedCount(), 1);
    assert.equal(proc.listenerCount("SIGINT"), 1);

    guard.untrack(102);
    assert.equal(guard.trackedCount(), 0);
    assert.equal(proc.listenerCount("SIGINT"), 0);
    assert.equal(proc.listenerCount("exit"), 0);
  });

  it("yields as a no-op on SIGINT when another active listener is attached (TUI Ctrl+Z)", () => {
    const v4Sym = Symbol.for("signal-exit emitter");
    const { proc, kills } = createFakeProcess(5555);
    const terminated: number[] = [];
    const globalScope: Record<symbol, unknown> = { [v4Sym]: { count: 1 } };
    const guard = new StdioExitGuard({
      proc,
      globalScope,
      terminatePidTreeSync: (pid) => terminated.push(pid),
    });

    // Simulate signal-exit v3 + v4 passive listeners + Pi TUI's transient ignoreSigint listener.
    (proc as unknown as { __signal_exit_emitter__?: { count: number } }).__signal_exit_emitter__ = {
      count: 1,
    };
    const passiveSigExitV3 = (): void => {};
    const passiveSigExitV4 = (): void => {};
    const ignoreSigint = (): void => {};
    proc.on("SIGINT", passiveSigExitV3);
    proc.on("SIGINT", passiveSigExitV4);
    proc.on("SIGINT", ignoreSigint);
    guard.track(1001);

    proc.emit("SIGINT");
    assert.deepEqual(terminated, []);
    assert.deepEqual(kills, []);
    assert.equal(guard.trackedCount(), 1);
    assert.equal(proc.listenerCount("SIGINT"), 4);

    // Also verify without signal-exit present (another active host listener alone).
    proc.off("SIGINT", passiveSigExitV3);
    proc.off("SIGINT", passiveSigExitV4);
    delete (proc as unknown as { __signal_exit_emitter__?: unknown }).__signal_exit_emitter__;
    delete globalScope[v4Sym];
    proc.emit("SIGINT");
    assert.deepEqual(terminated, []);
    assert.deepEqual(kills, []);

    guard.dispose();
    assert.equal(guard.trackedCount(), 0);
    assert.equal(proc.listenerCount("SIGINT"), 1);
    assert.equal(proc.listenerCount("exit"), 0);
  });

  it("terminates tracked trees and re-raises SIGINT when sole active listener (with or without signal-exit v3/v4)", () => {
    const v4Sym = Symbol.for("signal-exit emitter");

    // Case 1: no signal-exit
    {
      const { proc, kills } = createFakeProcess(7001);
      const terminated: number[] = [];
      const guard = new StdioExitGuard({
        proc,
        terminatePidTreeSync: (pid) => terminated.push(pid),
      });
      guard.track(2001);
      guard.track(2002);

      proc.emit("SIGINT");
      assert.deepEqual(terminated, [2001, 2002]);
      assert.deepEqual(kills, [{ pid: 7001, signal: "SIGINT" }]);
      assert.equal(guard.trackedCount(), 0);
      assert.equal(proc.listenerCount("SIGINT"), 0);
      assert.equal(proc.listenerCount("exit"), 0);
    }

    // Case 2: signal-exit v3 present on proc (listenerCount=2, count=1 -> otherActiveListeners=0)
    {
      const { proc, kills } = createFakeProcess(7002);
      const terminated: number[] = [];
      const guard = new StdioExitGuard({
        proc,
        terminatePidTreeSync: (pid) => terminated.push(pid),
      });
      (proc as unknown as { __signal_exit_emitter__?: { count: number } }).__signal_exit_emitter__ =
        { count: 1 };
      proc.on("SIGINT", () => {});
      guard.track(2003);

      proc.emit("SIGINT");
      assert.deepEqual(terminated, [2003]);
      assert.deepEqual(kills, [{ pid: 7002, signal: "SIGINT" }]);
      assert.equal(guard.trackedCount(), 0);
      assert.equal(proc.listenerCount("SIGINT"), 1);
      assert.equal(proc.listenerCount("exit"), 0);
    }

    // Case 3: signal-exit v4 present on globalThis (listenerCount=2, count=1 -> otherActiveListeners=0)
    {
      const { proc, kills } = createFakeProcess(7005);
      const terminated: number[] = [];
      const guard = new StdioExitGuard({
        proc,
        globalScope: { [v4Sym]: { count: 1 } },
        terminatePidTreeSync: (pid) => terminated.push(pid),
      });
      proc.on("SIGINT", () => {});
      guard.track(2004);

      proc.emit("SIGINT");
      assert.deepEqual(terminated, [2004]);
      assert.deepEqual(kills, [{ pid: 7005, signal: "SIGINT" }]);
      assert.equal(guard.trackedCount(), 0);
      assert.equal(proc.listenerCount("SIGINT"), 1);
      assert.equal(proc.listenerCount("exit"), 0);
    }
  });

  it("falls back to proc.exit(130) when re-raising SIGINT throws, without double-firing exit", () => {
    const { proc, exits, setKillThrow } = createFakeProcess(7003);
    const terminated: number[] = [];
    const guard = new StdioExitGuard({
      proc,
      terminatePidTreeSync: (pid) => terminated.push(pid),
    });
    setKillThrow(new Error("EPERM"));
    guard.track(3001);

    proc.emit("SIGINT");
    assert.deepEqual(terminated, [3001]);
    assert.deepEqual(exits, [130]);
    assert.equal(proc.listenerCount("exit"), 0);

    // Even if exit were emitted after, tracked trees are not killed a second time.
    proc.emit("exit", 130);
    assert.deepEqual(terminated, [3001]);
  });

  it("terminates all tracked trees on process exit and detaches", () => {
    const { proc } = createFakeProcess(7004);
    const terminated: number[] = [];
    const guard = new StdioExitGuard({
      proc,
      terminatePidTreeSync: (pid) => terminated.push(pid),
    });
    guard.track(4001);
    guard.track(4002);

    proc.emit("exit", 1);
    assert.deepEqual(terminated, [4001, 4002]);
    assert.equal(guard.trackedCount(), 0);
    assert.equal(proc.listenerCount("SIGINT"), 0);
    assert.equal(proc.listenerCount("exit"), 0);
  });

  it("listDescendantPidsSync walks deepest-first, handles cycles, and isolates mid-walk child errors", () => {
    const tree = new Map<number, number[]>([
      [1, [2, 3]],
      [2, [4]],
      [3, [1]],
      [4, []],
    ]);
    assert.deepEqual(
      listDescendantPidsSync(1, (pid) => tree.get(pid) ?? []),
      [4, 3, 2],
    );
    assert.deepEqual(
      listDescendantPidsSync(1, () => {
        throw new Error("ENOENT");
      }),
      [],
    );

    // If child 2 exits mid-walk (throwing ENOENT), sibling 3 and its descendants are still discovered.
    const midWalkTree = new Map<number, number[]>([
      [1, [2, 3]],
      [3, [5]],
      [5, []],
    ]);
    assert.deepEqual(
      listDescendantPidsSync(1, (pid) => {
        if (pid === 2) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return midWalkTree.get(pid) ?? [];
      }),
      [5, 3, 2],
    );
  });

  it("listDescendantPidsSync and terminatePidTreeSync find live children with default args on POSIX (/proc and ps)", {
    skip: process.platform === "win32" && "WHY: Windows has no /proc or ps",
  }, async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    try {
      assert.ok(child.pid);
      const nativeResult = listDescendantPidsSync(process.pid);
      assert.ok(nativeResult.includes(child.pid), `Expected ${child.pid} in ${nativeResult.join(",")}`);

      // Exercise the non-Linux POSIX `ps` snapshot path without mutating process.platform.
      const psResult = listDescendantPidsSync(process.pid, undefined, "darwin");
      assert.ok(psResult.includes(child.pid), `Expected ${child.pid} via ps in ${psResult.join(",")}`);

      // Default terminatePidTreeSync on macOS discovers descendants without a custom parser.
      const signalled: number[] = [];
      terminatePidTreeSync(process.pid, {
        platform: "darwin",
        kill: (target) => {
          signalled.push(target);
        },
      });
      assert.ok(signalled.includes(child.pid), `Expected ${child.pid} signalled via default ps discovery`);
      assert.equal(signalled.at(-1), process.pid);
    } finally {
      const exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
      });
      child.kill("SIGKILL");
      await exited;
    }
  });

  it("terminatePidTreeSync uses SIGTERM deepest-first on POSIX and taskkill with fallback on Windows", () => {
    const posixCalls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    terminatePidTreeSync(100, {
      platform: "linux",
      listDescendantPidsSync: () => [102, 101],
      kill: (pid, signal) => {
        posixCalls.push({ pid, signal });
      },
    });
    assert.deepEqual(posixCalls, [
      { pid: 102, signal: "SIGTERM" },
      { pid: 101, signal: "SIGTERM" },
      { pid: 100, signal: "SIGTERM" },
    ]);

    const winSpawns: Array<{ cmd: string; args: readonly string[]; opts: unknown }> = [];
    const winKills: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    terminatePidTreeSync(200, {
      platform: "win32",
      spawnSync: ((cmd: string, args: readonly string[], opts: unknown) => {
        winSpawns.push({ cmd, args, opts });
        return { error: new Error("taskkill missing") } as never;
      }) as never,
      kill: (pid, signal) => {
        winKills.push({ pid, signal });
      },
    });
    assert.equal(winSpawns.length, 1);
    assert.equal(winSpawns[0]?.cmd, "taskkill");
    assert.deepEqual(winSpawns[0]?.args, ["/pid", "200", "/T", "/F"]);
    assert.deepEqual(winKills, [{ pid: 200, signal: "SIGTERM" }]);
  });

  it("tracks real live ChildProcess instances in instrumentStdioTransport and untracks on exit without touching fake stubs", async () => {
    const { spawn } = await import("node:child_process");
    const baseSigint = process.listenerCount("SIGINT");
    const baseExit = process.listenerCount("exit");

    // Plain and duck-typed EventEmitter fake PID stubs must NEVER attach OS signal listeners.
    const fakeTransport = {
      _process: { pid: 4242 },
      pid: 4242,
      stderr: null,
      start: async () => {},
      close: async () => {},
    } as unknown as StdioClientTransport;
    instrumentStdioTransport(fakeTransport, { onPid: () => {}, onStderrLine: () => {} });
    await fakeTransport.start();
    assert.equal(process.listenerCount("SIGINT"), baseSigint);
    assert.equal(process.listenerCount("exit"), baseExit);

    const duckTypedProc = Object.assign(new EventEmitter(), {
      pid: 4243,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    });
    const duckTypedTransport = {
      _process: duckTypedProc,
      pid: 4243,
      stderr: null,
      start: async () => {},
      close: async () => {},
    } as unknown as StdioClientTransport;
    instrumentStdioTransport(duckTypedTransport, { onPid: () => {}, onStderrLine: () => {} });
    await duckTypedTransport.start();
    assert.equal(process.listenerCount("SIGINT"), baseSigint);
    assert.equal(process.listenerCount("exit"), baseExit);

    // Real live ChildProcess attaches the guard and untracks automatically on exit.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000);"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const realTransport = {
      _process: child,
      get pid() {
        return child.pid;
      },
      stderr: child.stderr,
      start: async () => {},
      close: async () => {
        child.kill("SIGKILL");
      },
    } as unknown as StdioClientTransport;

    instrumentStdioTransport(realTransport, { onPid: () => {}, onStderrLine: () => {} });
    await realTransport.start();
    assert.equal(process.listenerCount("SIGINT"), baseSigint + 1);
    assert.equal(process.listenerCount("exit"), baseExit + 1);

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    assert.equal(process.listenerCount("SIGINT"), baseSigint);
    assert.equal(process.listenerCount("exit"), baseExit);
  });
});
