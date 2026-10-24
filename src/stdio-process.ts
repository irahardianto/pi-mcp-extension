/**
 * Stdio child-process supervision and stderr line decoding.
 *
 * Provides pure StringDecoder-based line splitting across chunk boundaries,
 * StdioClientTransport instrumentation (early PID capture, memoized close,
 * stderr wiring), and deterministic SIGTERM → bounded wait → SIGKILL cleanup
 * with injectable process/timer dependencies.
 */

import { StringDecoder } from "node:string_decoder";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ─── Line Splitting ───────────────────────────────────────────────────────────

export interface LineSplitter {
  write(chunk: Buffer): void;
  end(): void;
}

/**
 * Create a pure UTF-8 `StringDecoder`-based line splitter with idempotent `end()`.
 */
export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  const decoder = new StringDecoder("utf8");
  let remainder = "";
  let flushed = false;

  return {
    write(chunk: Buffer): void {
      remainder += decoder.write(chunk);
      const lines = remainder.split("\n");
      remainder = lines.pop() ?? "";
      for (const rawLine of lines) {
        onLine(rawLine);
      }
    },
    end(): void {
      if (flushed) return;
      flushed = true;
      remainder += decoder.end();
      if (remainder) {
        const trailing = remainder;
        remainder = "";
        onLine(trailing);
      }
    },
  };
}

// ─── Transport Instrumentation ────────────────────────────────────────────────

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
  const origStart = transport.start.bind(transport);
  transport.start = async () => {
    const startPromise = origStart();
    const earlyProc = (transport as unknown as { _process?: { pid?: number } })._process;
    if (earlyProc?.pid) {
      onPid(earlyProc.pid);
    }
    await startPromise;
    const proc = (transport as unknown as { _process?: { pid?: number } })._process;
    if (proc?.pid) {
      onPid(proc.pid);
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

  if (transport.stderr) {
    const splitter = createLineSplitter(onStderrLine);
    transport.stderr.on("data", (chunk: Buffer) => {
      splitter.write(chunk);
    });
    const flushStderr = (): void => {
      splitter.end();
    };
    transport.stderr.on("end", flushStderr);
    transport.stderr.on("close", flushStderr);
  }
}

// ─── Process Supervision ──────────────────────────────────────────────────────

export interface StdioProcessDeps {
  kill(pid: number, signal?: NodeJS.Signals | number): void | boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const defaultDeps: StdioProcessDeps = {
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

function resolveDeps(deps?: Partial<StdioProcessDeps>): StdioProcessDeps {
  if (!deps) return defaultDeps;
  return {
    kill: deps.kill ?? defaultDeps.kill,
    sleep: deps.sleep ?? defaultDeps.sleep,
    now: deps.now ?? defaultDeps.now,
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

async function signalAndWaitForExit(
  pid: number,
  signal: NodeJS.Signals,
  timeoutMs: number,
  d: StdioProcessDeps,
): Promise<boolean> {
  try {
    d.kill(pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return true;
    }
  }

  const deadline = d.now() + timeoutMs;
  while (d.now() < deadline) {
    if (!isPidAlive(pid, d)) {
      return true;
    }
    await d.sleep(25);
  }

  return !isPidAlive(pid, d);
}

export async function ensurePidTerminated(
  pid: number | null | undefined,
  deps?: Partial<StdioProcessDeps>,
): Promise<void> {
  const d = resolveDeps(deps);
  if (!pid || !isPidAlive(pid, d)) {
    return;
  }

  if (await signalAndWaitForExit(pid, "SIGTERM", 500, d)) {
    return;
  }

  await signalAndWaitForExit(pid, "SIGKILL", 200, d);
}

