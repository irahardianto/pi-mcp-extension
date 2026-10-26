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

/** Dialog context: a `select`-capable UI with optional input/notify surfaces. */
type OAuthDialogContext = {
  hasUI: boolean;
  ui: Pick<ExtensionUIContext, "select"> & Partial<Pick<ExtensionUIContext, "input" | "notify">>;
};

async function handlePasteChoice(
  serverName: string,
  callbackResultPromise: Promise<OAuthCallbackResult | OAuthCallbackErrorResult>,
  context: OAuthDialogContext,
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

/** Outcome of one dialog iteration: a resolved code, a browser retry, or loop again. */
type DialogStep =
  | { kind: "code"; code: string }
  | { kind: "retry" }
  | { kind: "continue" };

/** Prompt for the retry/paste/cancel choice, abortable by the caller. */
function promptForDialogChoice(
  serverName: string,
  ui: Pick<ExtensionUIContext, "select">,
  abortController: AbortController,
): Promise<OAuthWaitResult> {
  return ui
    .select(
      `OAuth pending for ${serverName}`,
      [authRetryOption, authPasteOption, authCancelOption],
      { signal: abortController.signal },
    )
    .then((choice): OAuthUserChoiceResult => ({ type: "choice", choice }))
    .catch((error): OAuthDialogAbortedResult => {
      if (abortController.signal.aborted) {
        return { type: "dialogAborted" };
      }
      throw error;
    });
}

/**
 * Run the paste-back branch of a dialog step: the user chose "Paste redirect
 * URL", so resolve the code (or loop again when the paste was empty/invalid).
 */
async function resolvePasteStep(
  serverName: string,
  callbackResultPromise: Promise<OAuthCallbackResult | OAuthCallbackErrorResult>,
  context: OAuthDialogContext,
  pasteOptions: OAuthPasteOptions | undefined,
  dialogAbortController: AbortController,
): Promise<DialogStep> {
  const pastedCode = await handlePasteChoice(serverName, callbackResultPromise, context, pasteOptions);
  if (pastedCode === undefined) return { kind: "continue" };
  dialogAbortController.abort();
  return { kind: "code", code: pastedCode };
}

/**
 * One iteration of the wait loop: race the loopback callback against the dialog
 * choice and fold whichever answered first into a {@link DialogStep}.
 */
async function runDialogStep(
  serverName: string,
  callbackResultPromise: Promise<OAuthCallbackResult | OAuthCallbackErrorResult>,
  context: OAuthDialogContext,
  pasteOptions?: OAuthPasteOptions,
): Promise<DialogStep> {
  const dialogAbortController = new AbortController();
  const choicePromise = promptForDialogChoice(serverName, context.ui, dialogAbortController);
  const result = await Promise.race([callbackResultPromise, choicePromise]);

  if (result.type === "callbackError") {
    dialogAbortController.abort();
    throw result.error;
  }

  if (result.type === "callback") {
    dialogAbortController.abort();
    return { kind: "code", code: result.code };
  }

  if (result.type === "choice" && result.choice === authPasteOption) {
    return resolvePasteStep(
      serverName,
      callbackResultPromise,
      context,
      pasteOptions,
      dialogAbortController,
    );
  }

  if (result.type === "choice" && result.choice === authRetryOption) {
    return { kind: "retry" };
  }

  if (result.type === "dialogAborted") {
    return { kind: "continue" };
  }

  dialogAbortController.abort();
  throw new AuthCancelledError(serverName);
}

export async function waitForOAuthCallback(
  serverName: string,
  callbackPromise: Promise<string>,
  reopenBrowser: () => void | Promise<void>,
  context: OAuthDialogContext,
  pasteOptions?: OAuthPasteOptions,
): Promise<string> {
  if (!context.hasUI) {
    throw new Error(`Authorization for ${serverName} requires an interactive Pi session`);
  }

  const callbackResultPromise: Promise<OAuthCallbackResult | OAuthCallbackErrorResult> = callbackPromise
    .then((code): OAuthCallbackResult => ({ type: "callback", code }))
    .catch((error): OAuthCallbackErrorResult => ({ type: "callbackError", error }));

  while (true) {
    const step = await runDialogStep(serverName, callbackResultPromise, context, pasteOptions);
    if (step.kind === "code") return step.code;
    if (step.kind === "retry") await reopenBrowser();
  }
}
