/**
 * Protocol-level FIFO turn-ordering and close-draining instrumentation for MCP transports.
 *
 * Preserves wire order across JSON-RPC notifications, responses/requests, and stream closes
 * that share a synchronous read batch, deduplicates `onclose` and concurrent `close()` calls,
 * and isolates deferred handler errors from wedging subsequent turns (#300, #307).
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describeError } from "./debug-log-format.js";
import { reportDiagnostic } from "./debug-log.js";

type TransportMessageHandler = NonNullable<Transport["onmessage"]>;
type TransportCloseHandler = NonNullable<Transport["onclose"]>;

interface NotificationTurnTracker {
  tail: Promise<void> | null;
  reportError: (err: unknown) => void;
}

export function isJsonRpcNotificationMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const record = message as Record<string, unknown>;
  return typeof record["method"] === "string" && !("id" in record);
}

/**
 * Open a synchronous turn hold around an initial notification dispatch.
 *
 * WHY: Installing `tracker.tail` before `handler` runs ensures any re-entrant `onmessage` or
 * `onclose` triggered synchronously inside `handler` queues behind this notification, while
 * resolving `gate` in `finally` schedules the hold release strictly after `Protocol._onnotification`'s
 * internal `Promise.resolve().then(...)` microtask.
 */
function dispatchNotificationWithTurnHold(
  handler: TransportMessageHandler,
  tracker: NotificationTurnTracker,
  message: Parameters<TransportMessageHandler>[0],
  extra: Parameters<TransportMessageHandler>[1],
): void {
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const hold = gate.then(() => {
    if (tracker.tail === hold) {
      tracker.tail = null;
    }
  });
  tracker.tail = hold;
  try {
    handler(message, extra);
  } finally {
    releaseGate();
  }
}

/**
 * Hold the turn queue open for one microtask so `Protocol._onnotification`'s internal
 * `Promise.resolve().then(...)` handler completes before any subsequent non-notification or close.
 */
function enqueueTurnHold(tracker: NotificationTurnTracker): void {
  const base = tracker.tail ?? Promise.resolve();
  const hold = base.then(() => {
    if (tracker.tail === hold) {
      tracker.tail = null;
    }
  });
  tracker.tail = hold;
}

function enqueueTurnStep(tracker: NotificationTurnTracker, step: () => void): void {
  const base = tracker.tail ?? Promise.resolve();
  const next = base.then(() => {
    try {
      step();
    } catch (err) {
      tracker.reportError(err);
    } finally {
      if (tracker.tail === next) {
        tracker.tail = null;
      }
    }
  });
  tracker.tail = next;
}

async function drainTurnQueue(tracker: NotificationTurnTracker): Promise<void> {
  while (tracker.tail !== null) {
    await tracker.tail;
  }
}

function normalizeDeferredError(err: unknown): Error {
  try {
    return err instanceof Error ? err : new Error(String(err));
  } catch {
    // WHY: `String(Object.create(null))` and throwing `toString` getters throw `TypeError`;
    // normalization must never reject `tracker.tail` and wedge subsequent turns.
    return new Error("[unstringifiable value thrown]");
  }
}

function reportDeferredHandlerError(
  serverName: string,
  transport: Transport,
  err: unknown,
): void {
  const normalized = normalizeDeferredError(err);
  try {
    transport.onerror?.(normalized);
  } catch (onErrorErr) {
    // WHY: Never allow a throwing `transport.onerror` listener to reject `tracker.tail`, which
    // would strand remaining frames in the batch and permanently poison future turns.
    const { kind, message } = describeError(onErrorErr);
    reportDiagnostic({
      level: "info",
      event: "transport.onerror_error",
      server: serverName,
      message: `Transport onerror threw while reporting deferred handler error: ${message}`,
      fields: { kind },
    });
  }
}

function wrapOrderedMessageHandler(
  handler: TransportMessageHandler,
  tracker: NotificationTurnTracker,
  isSuperseded: () => boolean,
): TransportMessageHandler {
  return (message, extra) => {
    if (isSuperseded()) {
      handler(message, extra);
      return;
    }
    if (isJsonRpcNotificationMessage(message)) {
      if (tracker.tail === null) {
        dispatchNotificationWithTurnHold(handler, tracker, message, extra);
      } else {
        enqueueTurnStep(tracker, () => {
          handler(message, extra);
        });
        enqueueTurnHold(tracker);
      }
      return;
    }
    if (tracker.tail === null) {
      handler(message, extra);
      return;
    }
    enqueueTurnStep(tracker, () => {
      handler(message, extra);
    });
  };
}

function wrapOrderedCloseHandler(
  handler: TransportCloseHandler,
  tracker: NotificationTurnTracker,
  isSuperseded: () => boolean,
): TransportCloseHandler {
  // WHY: `Protocol._onclose()` clears `client.transport` without clearing `transport.onclose`,
  // while `StreamableHTTPClientTransport.close()` and `SSEClientTransport.close()` invoke
  // `this.onclose?.()`. Latch per top-level handler registration so both same-turn and cross-tick
  // `onclose` + `transport.close()` combinations fire `onclose` at most once.
  let closeDispatched = false;
  return () => {
    if (isSuperseded()) {
      handler();
      return;
    }
    if (closeDispatched) return;
    closeDispatched = true;
    if (tracker.tail === null) {
      handler();
      return;
    }
    enqueueTurnStep(tracker, handler);
  };
}

function bindOrderedHandlerProperty<K extends "onmessage" | "onclose">(
  transport: Transport,
  key: K,
  wrap: (
    handler: NonNullable<Transport[K]>,
    isSuperseded: () => boolean,
  ) => NonNullable<Transport[K]>,
): void {
  let ordered: Transport[K];
  Object.defineProperty(transport, key, {
    configurable: true,
    enumerable: true,
    get: () => ordered,
    set: (next: Transport[K]) => {
      if (!next) {
        ordered = undefined;
        return;
      }
      if (next === ordered) return;
      const wrapped = wrap(next, () => ordered !== wrapped);
      ordered = wrapped;
    },
  });
}

function wrapOrderedTransportClose(
  transport: Transport,
  tracker: NotificationTurnTracker,
): void {
  // WHY: Deferring `Protocol._onclose()` behind an in-flight notification leaves `client.transport`
  // defined until the turn queue drains, so concurrent `client.close()` calls (e.g. `Client.connect`'s
  // `void this.close()` followed by `_cleanupFailedConnect`'s `await client.close()`) both reach
  // `transport.close()`. Memoize the close promise so `origClose()` runs once and every caller
  // awaits the drained queue.
  let closePromise: Promise<void> | null = null;
  const origClose = transport.close.bind(transport);
  transport.close = (): Promise<void> => {
    closePromise ??= (async () => {
      try {
        await origClose();
      } finally {
        await drainTurnQueue(tracker);
      }
    })();
    return closePromise;
  };
}

/**
 * Preserve FIFO wire order when JSON-RPC notifications, responses/requests, and close events
 * share a synchronous read batch (`StdioClientTransport.processReadBuffer()`, SSE chunks, or
 * JSON batch responses), and drain any queued turn steps before `transport.close()` resolves.
 *
 * WHY: `Protocol._onnotification` defers notification dispatch onto `Promise.resolve().then(...)`
 * while `Protocol._onresponse` and `Protocol._onclose` clear `_progressHandlers` synchronously.
 * Without ordering, a trailing `notifications/progress` frame arriving in the same chunk as its
 * `tools/call` result loses the race to `_onresponse` and is dropped as an unknown token (#300).
 */
export function instrumentTransportMessageOrder<T extends Transport>(
  serverName: string,
  transport: T,
): T {
  const tracker: NotificationTurnTracker = {
    tail: null,
    reportError: (err: unknown) => {
      reportDeferredHandlerError(serverName, transport, err);
    },
  };
  bindOrderedHandlerProperty(transport, "onmessage", (next, isSuperseded) =>
    wrapOrderedMessageHandler(next, tracker, isSuperseded),
  );
  bindOrderedHandlerProperty(transport, "onclose", (next, isSuperseded) =>
    wrapOrderedCloseHandler(next, tracker, isSuperseded),
  );
  wrapOrderedTransportClose(transport, tracker);
  return transport;
}
