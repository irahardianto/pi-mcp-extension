/**
 * Interactive OAuth callback dialog options and waiter.
 *
 * Prompts the user with Retry / Paste redirect URL / Cancel dialog choices
 * while awaiting loopback OAuth callback resolution or manual URL paste-back.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  CallbackUrlValidationError,
  parseCallbackUrl,
} from "./callback-url.js";
import { AuthCancelledError } from "./errors.js";
import { sanitizeTerminalText } from "./terminal-text.js";

export const authRetryOption = "Retry: open browser again";
export const authPasteOption = "Paste redirect URL";
export const authCancelOption = "Cancel authentication";

interface OAuthCallbackResult {
  type: "callback";
  code: string;
}

interface OAuthCallbackErrorResult {
  type: "callbackError";
  error: unknown;
}

interface OAuthUserChoiceResult {
  type: "choice";
  choice: string | undefined;
}

interface OAuthDialogAbortedResult {
  type: "dialogAborted";
}

interface OAuthUserInputResult {
  type: "input";
  value: string | undefined;
}

type OAuthWaitResult = OAuthCallbackResult | OAuthCallbackErrorResult | OAuthUserChoiceResult | OAuthDialogAbortedResult;
type OAuthInputWaitResult = OAuthCallbackResult | OAuthCallbackErrorResult | OAuthUserInputResult | OAuthDialogAbortedResult;

export interface OAuthPasteOptions {
  redirectUrl?: string | URL | undefined;
  expectedState?: string | undefined;
  onPasteResolved?: (() => void) | undefined;
}

function parsePastedUrl(
  rawValue: string,
  _serverName: string,
  context: { ui: Partial<Pick<ExtensionUIContext, "notify">> },
  pasteOptions?: OAuthPasteOptions,
): string | undefined {
  if (!rawValue.trim()) return undefined;
  let parsed: ReturnType<typeof parseCallbackUrl>;
  try {
    parsed = parseCallbackUrl(rawValue, {
      redirectUrl: pasteOptions?.redirectUrl,
      expectedState: pasteOptions?.expectedState,
    });
  } catch (err) {
    if (err instanceof CallbackUrlValidationError) {
      context.ui.notify?.(`pi-mcp: Invalid redirect URL — ${sanitizeTerminalText(err.message)}`, "error");
      return undefined;
    }
    throw err;
  }

  pasteOptions?.onPasteResolved?.();
  if ("error" in parsed) {
    throw new Error(parsed.error);
  }
  return parsed.code;
}

function promptUserForPaste(
  serverName: string,
  inputFn: NonNullable<ExtensionUIContext["input"]>,
  abortController: AbortController,
): Promise<OAuthInputWaitResult> {
  return inputFn(
    `Paste redirect URL for ${serverName}`,
    "http://127.0.0.1:19876/callback?code=...&state=...",
    { signal: abortController.signal },
  )
    .then((value): OAuthUserInputResult => ({ type: "input", value }))
    .catch((error): OAuthDialogAbortedResult => {
      if (abortController.signal.aborted) {
        return { type: "dialogAborted" };
      }
      throw error;
    });
}

async function handlePasteChoice(
  serverName: string,
  callbackResultPromise: Promise<OAuthCallbackResult | OAuthCallbackErrorResult>,
  context: {
    hasUI: boolean;
    ui: Pick<ExtensionUIContext, "select"> & Partial<Pick<ExtensionUIContext, "input" | "notify">>;
  },
  pasteOptions?: OAuthPasteOptions,
): Promise<string | undefined> {
  if (!context.ui.input) return undefined;
  const inputAbortController = new AbortController();
  const inputPromise = promptUserForPaste(serverName, context.ui.input, inputAbortController);
  const inputResult = await Promise.race([callbackResultPromise, inputPromise]);

  if (inputResult.type === "callback") {
    inputAbortController.abort();
    return inputResult.code;
  }

  if (inputResult.type === "callbackError") {
    inputAbortController.abort();
    throw inputResult.error;
  }

  if (inputResult.type === "dialogAborted" || !inputResult.value) {
    return undefined;
  }

  return parsePastedUrl(inputResult.value, serverName, context, pasteOptions);
}

export async function waitForOAuthCallback(
  serverName: string,
  callbackPromise: Promise<string>,
  reopenBrowser: () => void | Promise<void>,
  context: {
    hasUI: boolean;
    ui: Pick<ExtensionUIContext, "select"> & Partial<Pick<ExtensionUIContext, "input" | "notify">>;
  },
  pasteOptions?: OAuthPasteOptions,
): Promise<string> {
  if (!context.hasUI) {
    throw new Error(`Authorization for ${serverName} requires an interactive Pi session`);
  }

  const callbackResultPromise: Promise<OAuthCallbackResult | OAuthCallbackErrorResult> = callbackPromise
    .then((code): OAuthCallbackResult => ({ type: "callback", code }))
    .catch((error): OAuthCallbackErrorResult => ({ type: "callbackError", error }));

  while (true) {
    const dialogAbortController = new AbortController();
    const choicePromise: Promise<OAuthWaitResult> = context.ui
      .select(
        `OAuth pending for ${serverName}`,
        [authRetryOption, authPasteOption, authCancelOption],
        { signal: dialogAbortController.signal },
      )
      .then((choice): OAuthUserChoiceResult => ({ type: "choice", choice }))
      .catch((error): OAuthDialogAbortedResult => {
        if (dialogAbortController.signal.aborted) {
          return { type: "dialogAborted" };
        }
        throw error;
      });

    const result = await Promise.race([callbackResultPromise, choicePromise]);

    if (result.type === "callback") {
      dialogAbortController.abort();
      return result.code;
    }

    if (result.type === "callbackError") {
      dialogAbortController.abort();
      throw result.error;
    }

    if (result.type === "dialogAborted") {
      continue;
    }

    if (result.choice === authRetryOption) {
      await reopenBrowser();
      continue;
    }

    if (result.choice === authPasteOption) {
      const pastedCode = await handlePasteChoice(serverName, callbackResultPromise, context, pasteOptions);
      if (pastedCode !== undefined) {
        dialogAbortController.abort();
        return pastedCode;
      }
      continue;
    }

    dialogAbortController.abort();
    throw new AuthCancelledError(serverName);
  }
}
