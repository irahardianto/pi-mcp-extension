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

export interface StrictMap<K, V> extends Map<K, V> {
  get(key: K): V;
}

export function createStrictMap<K, V>(): StrictMap<K, V> {
  return new Map<K, V>() as StrictMap<K, V>;
}

export interface MockContentBlock {
  type: string;
  text: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface MockToolResult {
  content: [MockContentBlock, ...MockContentBlock[]];
  details?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface MockTool {
  name: string;
  label?: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: unknown;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    update?: unknown,
    ctx?: unknown,
  ) => Promise<MockToolResult>;
  [key: string]: unknown;
}

export interface MockCommand {
  name?: string;
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  [key: string]: unknown;
}

export type MockEventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

export interface MockExtension {
  api: ExtensionAPI;
  tools: StrictMap<string, MockTool>;
  commands: StrictMap<string, MockCommand>;
  events: StrictMap<string, MockEventHandler>;
  activeTools: string[];
  mcpServers: RegisteredMcpServer[];
}

export interface PartialMockApi {
  registerTool?: (tool: MockTool) => unknown;
  registerCommand?: (name: string, cmd: MockCommand) => unknown;
  on?: (event: string, handler: MockEventHandler) => unknown;
  getActiveTools?: () => string[];
  setActiveTools?: (names: string[]) => void;
  getMcpServers?: () => Array<{ name: string; config: Record<string, unknown>; extensionPath: string }>;
}

export function asExtensionAPI(partial: PartialMockApi): ExtensionAPI {
  return {
    registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = unknown>(
      tool: ToolDefinition<TParams, TDetails, TState>,
    ): void {
      partial.registerTool?.(tool as unknown as MockTool);
    },
    registerCommand(name: string, cmd: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
      partial.registerCommand?.(name, cmd);
    },
    on(event: string, handler: unknown): () => void {
      partial.on?.(event, handler as MockEventHandler);
      return () => {};
    },
    getActiveTools(): string[] {
      return partial.getActiveTools ? partial.getActiveTools() : [];
    },
    setActiveTools(names: string[]): void {
      partial.setActiveTools?.(names);
    },
    getMcpServers(): RegisteredMcpServer[] {
      return (partial.getMcpServers ? partial.getMcpServers() : []) as unknown as RegisteredMcpServer[];
    },
  } as unknown as ExtensionAPI;
}

export function createMockExtension(options?: {
  mcpServers?: RegisteredMcpServer[];
  activeTools?: string[];
}): MockExtension {
  const tools = createStrictMap<string, MockTool>();
  const commands = createStrictMap<string, MockCommand>();
  const events = createStrictMap<string, MockEventHandler>();
  let active = options?.activeTools ?? [];
  const mcpServers = options?.mcpServers ?? [];

  const api = asExtensionAPI({
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, cmd) => commands.set(name, cmd),
    on: (event, handler) => events.set(event, handler),
    getActiveTools: () => active,
    setActiveTools: (names) => {
      active = names;
    },
    getMcpServers: () => mcpServers as unknown as Array<{ name: string; config: Record<string, unknown>; extensionPath: string }>,
  });

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
