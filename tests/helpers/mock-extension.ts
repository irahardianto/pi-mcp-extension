import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  ExtensionUIContext,
  RegisteredMcpServer,
  ToolDefinition,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

export interface MockTool {
  name: string;
  label?: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: unknown;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    update?: unknown,
    ctx?: ExtensionToolContext,
  ) => Promise<{
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
    details?: unknown;
    isError?: boolean;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface MockCommand {
  name?: string;
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  [key: string]: unknown;
}

export type MockEventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

export interface MockExtension {
  api: ExtensionAPI;
  tools: Map<string, MockTool>;
  commands: Map<string, MockCommand>;
  events: Map<string, MockEventHandler>;
  activeTools: string[];
  mcpServers: RegisteredMcpServer[];
}

export function createMockExtension(options?: {
  mcpServers?: RegisteredMcpServer[];
  activeTools?: string[];
}): MockExtension {
  const tools = new Map<string, MockTool>();
  const commands = new Map<string, MockCommand>();
  const events = new Map<string, MockEventHandler>();
  let active = options?.activeTools ?? [];
  const mcpServers = options?.mcpServers ?? [];

  const api = {
    registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = unknown>(
      tool: ToolDefinition<TParams, TDetails, TState>,
    ): void {
      tools.set(tool.name, tool as unknown as MockTool);
    },
    registerCommand(name: string, cmd: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
      commands.set(name, cmd);
    },
    on(event: string, handler: unknown): () => void {
      events.set(event, handler as MockEventHandler);
      return () => {
        events.delete(event);
      };
    },
    getActiveTools(): string[] {
      return active;
    },
    setActiveTools(names: string[]): void {
      active = names;
    },
    registerShortcut(): void {},
    registerFlag(): void {},
    getFlag(): undefined {
      return undefined;
    },
    registerMessageRenderer(): void {},
    registerMarkdownTransformer(): void {},
    registerEntryRenderer(): void {},
    registerToolRenderer(): void {},
    sendMessage(): void {},
    sendUserMessage(): void {},
    appendEntry(): void {},
    setSessionName(): void {},
    getSessionName(): undefined {
      return undefined;
    },
    setLabel(): void {},
    async exec(): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
    getAllTools(): [] {
      return [];
    },
    getSettings(): {
      defaultTools: [];
      toolRestrictions: [];
      autoCompact: false;
      maxCompactTokens: 0;
    } {
      return {
        defaultTools: [],
        toolRestrictions: [],
        autoCompact: false,
        maxCompactTokens: 0,
      };
    },
    getCommands(): [] {
      return [];
    },
    async setModel(): Promise<boolean> {
      return true;
    },
    getThinkingLevel(): "off" {
      return "off";
    },
    setThinkingLevel(): void {},
    registerProvider(): void {},
    unregisterProvider(): void {},
    registerMcpServer(): void {},
    unregisterMcpServer(): void {},
    getMcpServers: () => mcpServers,
  } as unknown as ExtensionAPI;

  return {
    api,
    tools,
    commands,
    events,
    get activeTools() {
      return active;
    },
    set activeTools(names: string[]) {
      active = names;
    },
    mcpServers,
  };
}

export interface MockContextOptions {
  cwd?: string;
  hasUI?: boolean;
  mode?: ExtensionContext["mode"];
  isProjectTrusted?: boolean | (() => boolean);
  signal?: AbortSignal;
  ui?: Partial<ExtensionUIContext>;
}

export function createMockContext(
  options?: MockContextOptions,
): ExtensionCommandContext & ExtensionToolContext {
  const hasUI = options?.hasUI ?? false;
  const cwd = options?.cwd ?? process.cwd();
  const isProjectTrustedOpt = options?.isProjectTrusted;
  const isProjectTrustedFn: () => boolean =
    typeof isProjectTrustedOpt === "function"
      ? isProjectTrustedOpt
      : () => isProjectTrustedOpt ?? true;

  const ui: ExtensionUIContext = {
    notify: () => {},
    select: async () => undefined,
    confirm: async () => true,
    input: async () => undefined,
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined as unknown as never,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: {
      name: "default",
      colors: {},
    } as unknown as ExtensionUIContext["theme"],
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: true }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
    ...options?.ui,
  };

  const ctx = {
    ui,
    mode: options?.mode ?? (hasUI ? "tui" : "print"),
    hasUI,
    cwd,
    sessionManager: {
      getEntries: () => [],
      getEntry: () => undefined,
      getHead: () => undefined,
    } as unknown as ExtensionContext["sessionManager"],
    modelRegistry: {} as unknown as ExtensionContext["modelRegistry"],
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: isProjectTrustedFn,
    signal: options?.signal,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({} as unknown as ReturnType<ExtensionCommandContext["getSystemPromptOptions"]>),
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    tools: [] as ExtensionToolContext["tools"],
    executeTool: async () => ({} as unknown as Awaited<ReturnType<ExtensionToolContext["executeTool"]>>),
  } as unknown as ExtensionCommandContext & ExtensionToolContext;

  return ctx;
}
