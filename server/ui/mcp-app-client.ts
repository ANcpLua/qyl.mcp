import {
  Protocol,
  type BaseContext,
  type CallToolResult,
  type JSONRPCMessage,
  type RequestOptions,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/client";
import {
  CallToolResultSchema,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/core";
import { z } from "zod/v4";

const APP_PROTOCOL_VERSION = "2026-01-26";

type Theme = "light" | "dark";
type DisplayMode = "inline" | "fullscreen" | "pip";

export interface McpUiHostContext {
  theme?: Theme | undefined;
  displayMode?: DisplayMode | undefined;
  availableDisplayModes?: DisplayMode[] | undefined;
  styles?: {
    variables?: Record<string, string | undefined> | undefined;
    css?: { fonts?: string | undefined } | undefined;
  } | undefined;
  safeAreaInsets?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  } | undefined;
  [key: string]: unknown;
}

interface AppInfo {
  name: string;
  version: string;
}

interface ToolInput {
  arguments?: Record<string, unknown> | undefined;
}

interface ToolCancelled {
  reason?: string | undefined;
}

interface AppCapabilities {
  availableDisplayModes?: DisplayMode[] | undefined;
  [key: string]: unknown;
}

const EmptyParamsSchema = z.object({}).passthrough();
const ToolInputSchema = z.object({
  arguments: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const ToolCancelledSchema = z.object({
  reason: z.string().optional(),
}).passthrough();
const HostContextSchema = z.object({
  theme: z.enum(["light", "dark"]).optional(),
  displayMode: z.enum(["inline", "fullscreen", "pip"]).optional(),
  availableDisplayModes: z.array(z.enum(["inline", "fullscreen", "pip"])).optional(),
  styles: z.object({
    variables: z.record(
      z.string(),
      z.union([z.string(), z.undefined()]),
    ).optional(),
    css: z.object({ fonts: z.string().optional() }).passthrough().optional(),
  }).passthrough().optional(),
  safeAreaInsets: z.object({
    top: z.number(),
    right: z.number(),
    bottom: z.number(),
    left: z.number(),
  }).optional(),
}).passthrough();
const InitializeResultSchema = z.object({
  protocolVersion: z.string(),
  hostInfo: z.object({
    name: z.string(),
    version: z.string(),
  }).passthrough(),
  hostCapabilities: z.record(z.string(), z.unknown()),
  hostContext: HostContextSchema,
}).passthrough();
const DisplayModeResultSchema = z.object({
  mode: z.enum(["inline", "fullscreen", "pip"]),
}).passthrough();
const TeardownResultSchema = z.object({}).passthrough();

export class PostMessageTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;
  setSupportedProtocolVersions?: (versions: string[]) => void;

  private started = false;
  private readonly messageListener = (event: MessageEvent): void => {
    if (event.source !== this.eventSource) return;
    const parsed = JSONRPCMessageSchema.safeParse(event.data);
    if (parsed.success) {
      this.onmessage?.(parsed.data);
      return;
    }
    if (event.data?.jsonrpc === "2.0") {
      this.onerror?.(new Error("Invalid JSON-RPC message received from the MCP App host."));
    }
  };

  constructor(
    private readonly eventTarget: Window = window.parent,
    private readonly eventSource: MessageEventSource = window.parent,
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("PostMessageTransport is already started.");
    this.started = true;
    window.addEventListener("message", this.messageListener);
  }

  async send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    this.eventTarget.postMessage(message, "*");
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    window.removeEventListener("message", this.messageListener);
    this.onclose?.();
  }
}

export class App extends Protocol<BaseContext> {
  ontoolinput?: (params: ToolInput) => void;
  ontoolresult?: (result: CallToolResult) => void;
  ontoolcancelled?: (params: ToolCancelled) => void;
  onhostcontextchanged?: (context: McpUiHostContext) => void;
  onteardown?: (
    params: Record<string, unknown>,
    context: BaseContext,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;

  private hostContext: McpUiHostContext | undefined;
  private hostCapabilities: Record<string, unknown> | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private resizeFrame: number | undefined;
  private lastWidth = 0;
  private lastHeight = 0;

  constructor(
    private readonly appInfo: AppInfo,
    private readonly capabilities: AppCapabilities = {},
  ) {
    super();
    this.setRequestHandler(
      "ping",
      { params: EmptyParamsSchema, result: TeardownResultSchema },
      () => ({}),
    );
    this.setNotificationHandler(
      "ui/notifications/tool-input",
      { params: ToolInputSchema },
      (params) => this.ontoolinput?.(params),
    );
    this.setNotificationHandler(
      "ui/notifications/tool-result",
      { params: CallToolResultSchema },
      (params) => this.ontoolresult?.(params),
    );
    this.setNotificationHandler(
      "ui/notifications/tool-cancelled",
      { params: ToolCancelledSchema },
      (params) => this.ontoolcancelled?.(params),
    );
    this.setNotificationHandler(
      "ui/notifications/host-context-changed",
      { params: HostContextSchema },
      (params) => {
        this.hostContext = { ...this.hostContext, ...params };
        this.onhostcontextchanged?.(params);
      },
    );
    this.setRequestHandler(
      "ui/resource-teardown",
      { params: EmptyParamsSchema, result: TeardownResultSchema },
      (params, context) => this.onteardown?.(params, context) ?? {},
    );
  }

  protected buildContext(context: BaseContext): BaseContext {
    return context;
  }

  protected assertCapabilityForMethod(_method: string): void {}

  protected assertNotificationCapability(_method: string): void {}

  protected assertRequestHandlerCapability(_method: string): void {}

  getHostContext(): McpUiHostContext | undefined {
    return this.hostContext;
  }

  getHostCapabilities(): Record<string, unknown> | undefined {
    return this.hostCapabilities;
  }

  async callServerTool(
    input: { name: string; arguments?: Record<string, unknown> },
    options?: RequestOptions,
  ): Promise<CallToolResult> {
    return this.request(
      { method: "tools/call", params: input },
      CallToolResultSchema,
      { onprogress: () => {}, resetTimeoutOnProgress: true, ...options },
    );
  }

  async requestDisplayMode(
    input: { mode: DisplayMode },
    options?: RequestOptions,
  ): Promise<{ mode: DisplayMode }> {
    return this.request(
      { method: "ui/request-display-mode", params: input },
      DisplayModeResultSchema,
      options,
    );
  }

  override async connect(
    transport: Transport = new PostMessageTransport(),
    options?: RequestOptions,
  ): Promise<void> {
    await super.connect(transport);
    try {
      const initialized = await this.request(
        {
          method: "ui/initialize",
          params: {
            appCapabilities: this.capabilities,
            appInfo: this.appInfo,
            protocolVersion: APP_PROTOCOL_VERSION,
          },
        },
        InitializeResultSchema,
        options,
      );
      this.hostCapabilities = initialized.hostCapabilities;
      this.hostContext = initialized.hostContext;
      await this.notification({ method: "ui/notifications/initialized" });
      this.startAutoResize();
    } catch (error) {
      try {
        await this.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "MCP App initialization and cleanup failed.",
        );
      }
      throw error;
    }
  }

  override async close(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    if (this.resizeFrame !== undefined) cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = undefined;
    this.lastWidth = 0;
    this.lastHeight = 0;
    await super.close();
  }

  private startAutoResize(): void {
    if (typeof ResizeObserver === "undefined") return;
    const notify = (): void => {
      if (this.resizeFrame !== undefined) return;
      this.resizeFrame = requestAnimationFrame(() => {
        this.resizeFrame = undefined;
        const root = document.documentElement;
        const previousHeight = root.style.height;
        root.style.height = "max-content";
        const width = Math.ceil(window.innerWidth);
        const height = Math.ceil(root.getBoundingClientRect().height);
        root.style.height = previousHeight;
        if (width === this.lastWidth && height === this.lastHeight) return;
        this.lastWidth = width;
        this.lastHeight = height;
        void this.notification({
          method: "ui/notifications/size-changed",
          params: { width, height },
        }).catch((error: unknown) => {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        });
      });
    };
    this.resizeObserver = new ResizeObserver(notify);
    this.resizeObserver.observe(document.documentElement);
    this.resizeObserver.observe(document.body);
    notify();
  }
}

export function applyDocumentTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function applyHostStyleVariables(
  variables: Record<string, string | undefined>,
  root: HTMLElement = document.documentElement,
): void {
  for (const [name, value] of Object.entries(variables)) {
    if (name.startsWith("--") && value !== undefined) {
      root.style.setProperty(name, value);
    }
  }
}

export function applyHostFonts(fontCss: string): void {
  if (document.getElementById("__mcp-host-fonts")) return;
  const style = document.createElement("style");
  style.id = "__mcp-host-fonts";
  style.textContent = fontCss;
  document.head.appendChild(style);
}
