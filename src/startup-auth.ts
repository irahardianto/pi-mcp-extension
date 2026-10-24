/**
 * Startup authorization and auth-queue coordination helpers.
 *
 * Owns startup auth dialog options (startupAuthNowOption, startupAuthLaterOption),
 * abort-aware auth-queue turn waiting (waitForQueueTurn), abort-aware startup
 * authorization prompt selection (promptStartupAuth), and user-facing error formatting
 * (formatErrorMessage).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { McpError, AuthCancelledError } from "./errors.js";
import { sanitizeTerminalText } from "./terminal-text.js";

export const startupAuthNowOption = "Authorize now";
export const startupAuthLaterOption = "Not now";

export function formatErrorMessage(err: unknown): string {
  const msg = err instanceof McpError ? err.userMessage : err instanceof Error ? err.message : String(err);
  return sanitizeTerminalText(msg.replace(/^AuthRequiredError:\s*/, ""));
}

// WHY: Allow an aborted waiter on authQueue to wake up and reject immediately without breaking
// the sequential promise chain for subsequent non-aborted waiters.
export function waitForQueueTurn(previous: Promise<void>, signal: AbortSignal, serverName: string): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new AuthCancelledError(serverName));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      reject(new AuthCancelledError(serverName));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(new AuthCancelledError(serverName));
        } else {
          resolve();
        }
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export function promptStartupAuth(
  name: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve, reject) => {
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    ctx.ui
      .select(
        `${name} needs authorization`,
        [startupAuthNowOption, startupAuthLaterOption],
        { signal },
      )
      .then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err: unknown) => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) resolve(undefined);
          else reject(err);
        },
      );
  });
}
