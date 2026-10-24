/**
 * Connection and authentication coordination for MCP servers.
 *
 * Owns the concurrency-sensitive state machine governing in-flight connect
 * attempts, authQueue serialization, startup authorization prompts, and session
 * teardown.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpConfig, ServerConfig } from "./config.js";
import type { ServerManager } from "./server-manager.js";
import type { ToolBridge } from "./tool-bridge.js";
import { McpError, AuthCancelledError } from "./errors.js";
import { AuthRequiredError } from "./oauth-provider.js";
import {
  formatErrorMessage,
  promptStartupAuth,
  startupAuthNowOption,
  waitForQueueTurn,
} from "./startup-auth.js";

export { formatErrorMessage, startupAuthLaterOption, startupAuthNowOption } from "./startup-auth.js";

export interface ConnectionCoordinatorDeps {
  manager: ServerManager;
  bridge: ToolBridge;
  getConfig: () => McpConfig;
  authorize: (serverName: string, ctx: ExtensionContext, signal: AbortSignal, reset: boolean) => Promise<void>;
  stopCallbackServer: () => Promise<void> | Promise<unknown>;
}

export interface ConnectOptions {
  signal?: AbortSignal | undefined;
  reset?: boolean | undefined;
  alreadyQueued?: boolean | undefined;
}

export class ConnectionCoordinator {
  private readonly deps: ConnectionCoordinatorDeps;
  private readonly connectAttempts = new Map<
    string,
    { promise: Promise<void>; controller: AbortController; reset: boolean; waiters: number }
  >();
  private readonly declinedStartupAuth = new Set<string>();
  private readonly startupPromptControllers = new Map<string, AbortController>();
  private authQueue: Promise<void> = Promise.resolve();
  private activeStartupTurn: { serverName: string; handoffPromise?: Promise<void> } | null = null;
  private activeCtx: ExtensionContext | undefined;

  constructor(deps: ConnectionCoordinatorDeps) {
    this.deps = deps;
  }

  setActiveContext(ctx: ExtensionContext | undefined): void {
    this.activeCtx = ctx;
  }

  hasConnectAttempt(serverName: string): boolean {
    return this.connectAttempts.has(serverName);
  }

  isStartupAuthDeclined(serverName: string): boolean {
    return this.declinedStartupAuth.has(serverName);
  }

  get inFlightAttemptCount(): number {
    return this.connectAttempts.size;
  }

  private async runSerializedAuth(
    serverName: string,
    signal: AbortSignal,
    fn: () => Promise<void>,
  ): Promise<void> {
    const previous = this.authQueue;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.authQueue = previous.then(() => gate);
    try {
      await waitForQueueTurn(previous, signal, serverName);
      await fn();
    } finally {
      release();
    }
  }

  syncStatus(ctx: ExtensionContext | undefined = this.activeCtx): void {
    for (const declinedName of Array.from(this.declinedStartupAuth)) {
      const server = this.deps.manager.getServer(declinedName);
      if (!server || server.state === "ready") {
        this.declinedStartupAuth.delete(declinedName);
      }
    }
    if (!ctx) return;
    if (this.declinedStartupAuth.size === 0) {
      ctx.ui.setStatus?.("pi-mcp", undefined);
      return;
    }
    // WHY: Display the most recent remaining server that still needs authorization so resolving
    // one server does not clear the footer hint while other declined servers are still pending.
    const remaining = Array.from(this.declinedStartupAuth);
    const displayServer = remaining[remaining.length - 1]!;
    ctx.ui.setStatus?.("pi-mcp", `run /mcp:auth ${displayServer}`);
  }

  markAuthRequired(serverName: string, ctx: ExtensionContext | undefined = this.activeCtx): void {
    this.declinedStartupAuth.add(serverName);
    this.syncStatus(ctx);
  }

  handleRecoveryFailed(serverName: string, error: unknown): void {
    if (error instanceof AuthRequiredError) {
      this.declinedStartupAuth.add(serverName);
      this.activeCtx?.ui.notify(
        `pi-mcp: ${serverName} requires re-authorization — run /mcp:auth ${serverName}`,
        "warning",
      );
      this.syncStatus(this.activeCtx);
    } else {
      this.activeCtx?.ui.notify(
        `pi-mcp: Lost connection to ${serverName} — ${formatErrorMessage(error)}`,
        "error",
      );
    }
  }

  cancelServer(serverName: string): void {
    this.declinedStartupAuth.delete(serverName);
    this.startupPromptControllers.get(serverName)?.abort();
    this.startupPromptControllers.delete(serverName);
    this.connectAttempts.get(serverName)?.controller.abort();
  }

  async teardown(ctx?: ExtensionContext, options?: { removeServers?: boolean }): Promise<void> {
    const removeServers = options?.removeServers ?? true;
    const targetCtx = ctx ?? this.activeCtx;
    this.declinedStartupAuth.clear();
    targetCtx?.ui.setStatus?.("pi-mcp", undefined);
    for (const controller of this.startupPromptControllers.values()) {
      controller.abort();
    }
    this.startupPromptControllers.clear();
    const inFlightPromises = Array.from(this.connectAttempts.values(), (attempt) => attempt.promise);
    for (const attempt of this.connectAttempts.values()) {
      attempt.controller.abort();
    }
    this.connectAttempts.clear();
    if (inFlightPromises.length > 0) {
      await Promise.allSettled(inFlightPromises);
    }
    await this.deps.stopCallbackServer().catch(() => {
      // WHY: Ignore callback server shutdown errors during session teardown.
    });
    for (const server of this.deps.manager.getAllServers()) {
      if (removeServers) {
        this.deps.bridge.removeServer(server.name);
      } else {
        this.deps.bridge.deactivateServer(server.name);
      }
    }
    await this.deps.manager.shutdownAll();
  }

  enqueueStartupAuthPrompt(name: string, ctx: ExtensionContext): void {
    // WHY: Deduplicate startup prompts when session_start fires multiple times or while a prompt
    // for the same server is already queued or active.
    if (this.startupPromptControllers.has(name)) {
      return;
    }
    const promptController = new AbortController();
    // WHY: Register the AbortController immediately when queued (before awaiting authQueue) so
    // /mcp:stop, /mcp:auth, or session teardown can cancel prompts that are still waiting in line.
    this.startupPromptControllers.set(name, promptController);

    const previous = this.authQueue;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.authQueue = previous.then(() => gate);

    void (async () => {
      let currentTurn: { serverName: string; handoffPromise?: Promise<void> } | null = null;
      try {
        await waitForQueueTurn(previous, promptController.signal, name);
        if (
          promptController.signal.aborted ||
          this.declinedStartupAuth.has(name) ||
          this.deps.manager.getServer(name)?.state === "ready" ||
          this.connectAttempts.has(name)
        ) {
          return;
        }
        currentTurn = { serverName: name };
        this.activeStartupTurn = currentTurn;
        let choice: string | undefined;
        try {
          choice = await promptStartupAuth(name, ctx, promptController.signal);
        } finally {
          if (this.startupPromptControllers.get(name) === promptController) {
            this.startupPromptControllers.delete(name);
          }
        }
        if (currentTurn.handoffPromise) {
          // WHY: An explicit connectRequested (/mcp:auth, /mcp:start, or mcp_connect) superseded
          // this server's startup prompt while it held the active queue turn. Hold the queue slot
          // until that connection/auth finishes before letting the next server's prompt appear.
          await currentTurn.handoffPromise.catch(() => {
            // WHY: Errors from an explicit connectRequested handoff are surfaced to its own caller.
          });
          return;
        }
        if (
          promptController.signal.aborted ||
          this.deps.manager.getServer(name)?.state === "ready" ||
          this.connectAttempts.has(name)
        ) {
          return;
        }
        if (choice === startupAuthNowOption) {
          try {
            await this.connect(name, ctx, { alreadyQueued: true });
          } catch (err) {
            if (!(err instanceof AuthCancelledError)) {
              const msg = formatErrorMessage(err);
              ctx.ui.notify(`pi-mcp: Failed to start ${name} — ${msg}`, "error");
            }
          }
        } else {
          this.declinedStartupAuth.add(name);
          this.syncStatus(ctx);
        }
      } catch (err) {
        if (!(err instanceof AuthCancelledError)) {
          const msg = formatErrorMessage(err);
          ctx.ui.notify(`pi-mcp: Failed to start ${name} — ${msg}`, "error");
        }
      } finally {
        if (this.startupPromptControllers.get(name) === promptController) {
          this.startupPromptControllers.delete(name);
        }
        if (currentTurn && this.activeStartupTurn === currentTurn) {
          if (currentTurn.handoffPromise) {
            await currentTurn.handoffPromise.catch(() => {
              // WHY: Suppress rejection here because connectRequested caller handles it.
            });
          }
          this.activeStartupTurn = null;
        }
        release();
      }
    })();
  }

  async startEagerServers(
    serversToStart: Array<[string, ServerConfig]>,
    ctx: ExtensionContext,
  ): Promise<void> {
    this.activeCtx = ctx;
    const authRequiredServers = new Set<string>();

    // Start all eager servers concurrently
    await Promise.allSettled(
      serversToStart.map(async ([name, cfg]) => {
        try {
          await this.deps.manager.startServer(name, ctx.cwd);
        } catch (err) {
          if (err instanceof AuthRequiredError && cfg.auth && ctx.hasUI) {
            authRequiredServers.add(name);
            return;
          }
          const msg = formatErrorMessage(err);
          ctx.ui.notify(`pi-mcp: Failed to start ${name} — ${msg}`, "error");
        }
      }),
    );

    for (const [name] of serversToStart) {
      if (!authRequiredServers.has(name)) continue;
      if (this.declinedStartupAuth.has(name)) {
        this.syncStatus(ctx);
        continue;
      }
      this.enqueueStartupAuthPrompt(name, ctx);
    }

    for (let i = 0; i < 4 * authRequiredServers.size; i++) {
      await Promise.resolve();
    }
  }

  async connect(
    serverName: string,
    ctx: ExtensionContext,
    options?: ConnectOptions,
  ): Promise<void> {
    const signal = options?.signal;
    const reset = options?.reset ?? false;
    const alreadyQueued = options?.alreadyQueued ?? false;

    this.activeCtx = ctx;
    const server = this.deps.manager.getServer(serverName);
    if (!server) throw new McpError(`Unknown server "${serverName}"`, serverName, "config");
    if (signal?.aborted) throw new AuthCancelledError(serverName);
    if (reset && !server.config.auth) throw new McpError(`Server "${serverName}" has no OAuth configuration`, serverName, "config");
    if (reset && !ctx.hasUI) throw new AuthRequiredError(serverName);

    const inheritedStartupTurn =
      !alreadyQueued && this.activeStartupTurn?.serverName === serverName ? this.activeStartupTurn : null;

    const waitForAttempt = async (entry: { promise: Promise<void>; controller: AbortController; reset: boolean; waiters: number }): Promise<void> => {
      entry.waiters++;
      let released = false;
      const releaseWaiter = () => {
        if (!released) {
          released = true;
          entry.waiters--;
        }
      };
      if (!signal) {
        try {
          return await entry.promise;
        } finally {
          releaseWaiter();
        }
      }
      let stopPromise: Promise<unknown> | undefined;
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          releaseWaiter();
          if (entry.waiters === 0) {
            if (this.connectAttempts.get(serverName) === entry) {
              this.connectAttempts.delete(serverName);
            }
            entry.controller.abort();
            stopPromise = this.deps.manager.stopServer(serverName);
            void stopPromise.finally(() => reject(new AuthCancelledError(serverName)));
          } else {
            reject(new AuthCancelledError(serverName));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([entry.promise, aborted]);
      } finally {
        signal.removeEventListener("abort", onAbort);
        releaseWaiter();
        await stopPromise;
      }
    };

    const existing = this.connectAttempts.get(serverName);
    // All requests join an in-flight reset. A reset supersedes a normal connect.
    if (existing && !existing.controller.signal.aborted && (!reset || existing.reset)) {
      return await waitForAttempt(existing);
    }

    const controller = new AbortController();
    if (existing) {
      existing.controller.abort();
      void this.deps.manager.stopServer(serverName);
    }
    let entry!: { promise: Promise<void>; controller: AbortController; reset: boolean; waiters: number };
    const task = (async () => {
      // Wait for a superseded connect to release its callback listener and auth lock.
      if (existing) {
        await existing.promise.catch(() => {
          // WHY: Ignore errors from the superseded connect attempt while waiting for cleanup.
        });
      }
      if (controller.signal.aborted) throw new AuthCancelledError(serverName);
      if (reset) {
        this.deps.bridge.deactivateServer(serverName);
        await this.deps.manager.stopServer(serverName);
        if (controller.signal.aborted) throw new AuthCancelledError(serverName);
      }
      try {
        if (!reset) await this.deps.manager.startServer(serverName, ctx.cwd);
        else throw new AuthRequiredError(serverName);
        if (controller.signal.aborted) { await this.deps.manager.stopServer(serverName); throw new AuthCancelledError(serverName); }
        this.declinedStartupAuth.delete(serverName);
        this.syncStatus(ctx);
        return;
      } catch (err) {
        if (!(err instanceof AuthRequiredError) || !server.config.auth) throw err;
      }
      if (!ctx.hasUI) throw new AuthRequiredError(serverName);
      const runInteractiveAuth = async (): Promise<void> => {
        if (controller.signal.aborted) throw new AuthCancelledError(serverName);
        await this.deps.authorize(serverName, ctx, controller.signal, reset);
        if (controller.signal.aborted) throw new AuthCancelledError(serverName);
        await this.deps.manager.startServer(serverName, ctx.cwd);
        if (controller.signal.aborted) { await this.deps.manager.stopServer(serverName); throw new AuthCancelledError(serverName); }
      };
      if (alreadyQueued || inheritedStartupTurn) {
        await runInteractiveAuth();
      } else {
        await this.runSerializedAuth(serverName, controller.signal, runInteractiveAuth);
      }
      this.declinedStartupAuth.delete(serverName);
      this.syncStatus(ctx);
    })().catch((err: unknown) => {
      if (controller.signal.aborted) throw new AuthCancelledError(serverName);
      throw err;
    }).finally(() => {
      if (this.connectAttempts.get(serverName) === entry) this.connectAttempts.delete(serverName);
    });
    void task.catch(() => {
      // WHY: Prevent unhandled rejection when task settles after an aborted waiter detaches.
    });
    if (inheritedStartupTurn) {
      // WHY: Attach handoffPromise before aborting the active startup prompt so the prompt turn
      // stays held for this server's interactive auth instead of advancing authQueue to the next server.
      inheritedStartupTurn.handoffPromise = task;
    }
    if (!alreadyQueued) {
      this.startupPromptControllers.get(serverName)?.abort();
      this.startupPromptControllers.delete(serverName);
    }
    entry = { promise: task, controller, reset, waiters: 0 };
    this.connectAttempts.set(serverName, entry);
    return await waitForAttempt(entry);
  }
}
