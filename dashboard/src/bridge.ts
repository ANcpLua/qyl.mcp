// The bridge uses the runner's same-origin MCP passthrough instead of a browser-side SDK client.
import {
  AppBridge,
  McpUiResourceMetaSchema,
  RESOURCE_MIME_TYPE,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  RunnerMcpResourceReadResponse,
  RunnerMcpToolCallResponse,
} from "@ancplua/qyl-api-schema/types";
import type { McpUiStyles } from "@modelcontextprotocol/ext-apps";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  type CallToolResult,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import packageMetadata from "../package.json";
import {
  ProblemDetailsSchema,
  RunnerMcpResourceReadRequestSchema,
  RunnerMcpResourceReadResponseSchema,
  RunnerMcpToolCallRequestSchema,
  RunnerMcpToolCallResponseSchema,
} from "qyl-mcp-server/contract-validation";
import { decodeMcpAppHtml } from "./resource-content";
import type { z } from "zod";

const HOST_INFO = { name: "qyl.mcp", version: packageMetadata.version };

export const log = {
  info: console.log.bind(console, "[HOST]"),
  warn: console.warn.bind(console, "[HOST]"),
  error: console.error.bind(console, "[HOST]"),
};


export async function responseErrorDetail(response: Response): Promise<string> {
  const fallback = `${response.status} ${response.statusText}`;
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/problem+json") return fallback;
  try {
    const parsed = ProblemDetailsSchema.safeParse(await response.json());
    return parsed.success ? (parsed.data.detail ?? parsed.data.title) : fallback;
  } catch {
    return fallback;
  }
}

async function runnerPost<T>(
  url: string,
  body: unknown,
  responseSchema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new Error(await responseErrorDetail(res));
  }
  return responseSchema.parse(await res.json());
}

export function callResourceTool(
  resource: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const request = RunnerMcpToolCallRequestSchema.parse({ name, arguments: args });
  return runnerPost<RunnerMcpToolCallResponse>(
    `/runner/mcp/${encodeURIComponent(resource)}/tools/call`,
    request,
    RunnerMcpToolCallResponseSchema,
    signal,
  ).then((result) => CallToolResultSchema.parse(result));
}

export function readResourceUri(
  resource: string,
  uri: string,
  signal?: AbortSignal,
): Promise<RunnerMcpResourceReadResponse> {
  const request = RunnerMcpResourceReadRequestSchema.parse({ uri });
  return runnerPost<RunnerMcpResourceReadResponse>(
    `/runner/mcp/${encodeURIComponent(resource)}/resources/read`,
    request,
    RunnerMcpResourceReadResponseSchema,
    signal,
  );
}

export async function runnerAction(resource: string, action: "restart" | "stop"): Promise<void> {
  const url = `/runner/resources/${encodeURIComponent(resource)}/${action}`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    const detail = await responseErrorDetail(res);
    throw new Error(`${action} '${resource}' failed: ${detail}`);
  }
}

interface SchemaLike {
  parse(value: unknown): unknown;
}

/**
 * REST-backed adapter for the SDK `Client` surface that AppBridge consumes.
 *
 * AppBridge (ext-apps/src/app-bridge.ts, connect()) uses exactly three members
 * of its `client` argument:
 *   - getServerCapabilities() — read once to decide which forwarders to install
 *   - request({ method, params }, resultSchema, { signal }) — for "tools/call"
 *   - setNotificationHandler(schema, handler) — only when the reported
 *     capabilities include listChanged, which this facade never reports
 *
 * This class implements exactly that surface over the runner's REST
 * passthrough; the runner holds the real SDK Client per resource.
 */
export class RunnerClientAdapter {
  constructor(private readonly resource: string) {}

  getServerCapabilities(): ServerCapabilities {
    // Advertise exactly the facade implemented below. Resource loading for the
    // host itself is separate from resources exposed to an embedded app.
    return { tools: {} };
  }

  async request(
    request: { method: string; params?: Record<string, unknown> },
    resultSchema: SchemaLike,
    options?: { signal?: AbortSignal },
  ): Promise<unknown> {
    switch (request.method) {
      case "tools/call":
        return resultSchema.parse(
          await callResourceTool(
            this.resource,
            String(request.params?.name ?? ""),
            (request.params?.arguments ?? {}) as Record<string, unknown>,
            options?.signal,
          ),
        );
      default:
        throw new Error(`RunnerClientAdapter does not proxy '${request.method}'`);
    }
  }

  setNotificationHandler(): never {
    throw new Error(
      "RunnerClientAdapter does not expose notifications; its capabilities report no listChanged support.",
    );
  }
}


export interface UiResourceData {
  html: string;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
}

export async function readAppResource(resource: string, uri: string): Promise<UiResourceData> {
  log.info("Reading UI resource:", uri);
  const result = await readResourceUri(resource, uri);

  if (result.contents.length !== 1) {
    throw new Error(`Unexpected contents count: ${result.contents.length}`);
  }
  const content = result.contents[0];

  // Per the MCP App specification, "text/html;profile=mcp-app" signals this
  // resource is indeed for an MCP App UI.
  if (content.mimeType !== RESOURCE_MIME_TYPE) {
    throw new Error(`Unsupported MIME type: ${content.mimeType}`);
  }

  const html = decodeMcpAppHtml(content);

  // Content-level _meta.ui only — the runner has no resources/list passthrough,
  // so basic-host's listing-level fallback does not apply here.
  const candidate = content._meta?.ui;
  const parsedMeta = candidate === undefined ? undefined : McpUiResourceMetaSchema.safeParse(candidate);
  if (parsedMeta && !parsedMeta.success) {
    throw new Error(`Invalid MCP App resource metadata: ${parsedMeta.error.message}`);
  }
  const uiMeta = parsedMeta?.data;
  return { html, csp: uiMeta?.csp, permissions: uiMeta?.permissions };
}


type Theme = "light" | "dark";

const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");

function getTheme(): Theme {
  return darkMedia.matches ? "dark" : "light";
}

const HOST_STYLE_VARIABLES: McpUiStyles = {
  "--color-background-primary": "light-dark(#ffffff, #11161f)",
  "--color-background-secondary": "light-dark(#f5f5f5, #0b0e14)",
  "--color-background-tertiary": "light-dark(#e5e5e5, #1f2733)",
  "--color-background-inverse": "light-dark(#1a1a1a, #ffffff)",
  "--color-background-ghost": "light-dark(rgba(255,255,255,0), rgba(26,26,26,0))",
  "--color-background-info": "light-dark(#eff6ff, #1e3a5f)",
  "--color-background-danger": "light-dark(#fef2f2, #7f1d1d)",
  "--color-background-success": "light-dark(#f0fdf4, #14532d)",
  "--color-background-warning": "light-dark(#fefce8, #713f12)",
  "--color-background-disabled": "light-dark(rgba(255,255,255,0.5), rgba(26,26,26,0.5))",

  "--color-text-primary": "light-dark(#1f2937, #e6edf3)",
  "--color-text-secondary": "light-dark(#6b7280, #8b98a9)",
  "--color-text-tertiary": "light-dark(#9ca3af, #6b7280)",
  "--color-text-inverse": "light-dark(#f3f4f6, #1f2937)",
  "--color-text-ghost": "light-dark(rgba(107,114,128,0.5), rgba(156,163,175,0.5))",
  "--color-text-info": "light-dark(#1d4ed8, #60a5fa)",
  "--color-text-danger": "light-dark(#b91c1c, #f87171)",
  "--color-text-success": "light-dark(#15803d, #4ade80)",
  "--color-text-warning": "light-dark(#a16207, #fbbf24)",
  "--color-text-disabled": "light-dark(rgba(31,41,55,0.5), rgba(243,244,246,0.5))",

  "--color-border-primary": "light-dark(#e5e7eb, #1f2733)",
  "--color-border-secondary": "light-dark(#d1d5db, #525252)",
  "--color-border-tertiary": "light-dark(#f3f4f6, #374151)",
  "--color-border-inverse": "light-dark(rgba(255,255,255,0.3), rgba(0,0,0,0.3))",
  "--color-border-ghost": "light-dark(rgba(229,231,235,0), rgba(64,64,64,0))",
  "--color-border-info": "light-dark(#93c5fd, #1e40af)",
  "--color-border-danger": "light-dark(#fca5a5, #991b1b)",
  "--color-border-success": "light-dark(#86efac, #166534)",
  "--color-border-warning": "light-dark(#fde047, #854d0e)",
  "--color-border-disabled": "light-dark(rgba(229,231,235,0.5), rgba(64,64,64,0.5))",

  "--color-ring-primary": "light-dark(#3b82f6, #60a5fa)",
  "--color-ring-secondary": "light-dark(#6b7280, #9ca3af)",
  "--color-ring-inverse": "light-dark(#ffffff, #1f2937)",
  "--color-ring-info": "light-dark(#2563eb, #3b82f6)",
  "--color-ring-danger": "light-dark(#dc2626, #ef4444)",
  "--color-ring-success": "light-dark(#16a34a, #22c55e)",
  "--color-ring-warning": "light-dark(#ca8a04, #eab308)",

  "--font-sans": "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  "--font-mono": "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",

  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",

  "--font-text-xs-size": "0.75rem",
  "--font-text-sm-size": "0.875rem",
  "--font-text-md-size": "1rem",
  "--font-text-lg-size": "1.125rem",

  "--font-heading-xs-size": "0.75rem",
  "--font-heading-sm-size": "0.875rem",
  "--font-heading-md-size": "1rem",
  "--font-heading-lg-size": "1.25rem",
  "--font-heading-xl-size": "1.5rem",
  "--font-heading-2xl-size": "1.875rem",
  "--font-heading-3xl-size": "2.25rem",

  "--font-text-xs-line-height": "1.4",
  "--font-text-sm-line-height": "1.4",
  "--font-text-md-line-height": "1.5",
  "--font-text-lg-line-height": "1.5",

  "--font-heading-xs-line-height": "1.4",
  "--font-heading-sm-line-height": "1.4",
  "--font-heading-md-line-height": "1.4",
  "--font-heading-lg-line-height": "1.3",
  "--font-heading-xl-line-height": "1.25",
  "--font-heading-2xl-line-height": "1.2",
  "--font-heading-3xl-line-height": "1.1",

  "--border-radius-xs": "2px",
  "--border-radius-sm": "4px",
  "--border-radius-md": "6px",
  "--border-radius-lg": "8px",
  "--border-radius-xl": "12px",
  "--border-radius-full": "9999px",

  "--border-width-regular": "1px",

  "--shadow-hairline": "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
  "--shadow-sm": "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1)",
  "--shadow-md": "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)",
  "--shadow-lg": "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)",
};


export function newAppBridge(client: RunnerClientAdapter, iframe: HTMLIFrameElement): AppBridge {
  const serverCapabilities = client.getServerCapabilities();

  // The cast is confined to the three client members RunnerClientAdapter implements.
  const appBridge = new AppBridge(
    client as unknown as Client,
    HOST_INFO,
    {
      openLinks: {},
      logging: {},
      serverTools: serverCapabilities.tools,
    },
    {
      hostContext: {
        theme: getTheme(),
        platform: "web",
        styles: { variables: HOST_STYLE_VARIABLES },
        containerDimensions: { maxHeight: 6000 },
        displayMode: "inline",
        availableDisplayModes: ["inline"],
      },
    },
  );

  const onThemeChange = (event: MediaQueryListEvent) => {
    const theme: Theme = event.matches ? "dark" : "light";
    log.info("Theme changed:", theme);
    appBridge.sendHostContextChange({ theme });
  };
  darkMedia.addEventListener("change", onThemeChange);

  const iframeResizeObserver = new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (width > 0) {
      appBridge.sendHostContextChange({
        containerDimensions: { width, maxHeight: 6000 },
      });
    }
  });
  iframeResizeObserver.observe(iframe);

  const prevOnclose = appBridge.onclose;
  appBridge.onclose = () => {
    darkMedia.removeEventListener("change", onThemeChange);
    iframeResizeObserver.disconnect();
    prevOnclose?.();
  };

  // Register handlers before connect so no early request is missed.

  appBridge.onmessage = async () => {
    log.info("Message received from MCP App");
    return {};
  };

  appBridge.onopenlink = async (params) => {
    log.info("Open link request:", params);
    window.open(params.url, "_blank", "noopener,noreferrer");
    return {};
  };

  appBridge.onloggingmessage = (params) => {
    log.info("Log message from MCP App:", params);
  };

  appBridge.onsizechange = ({ width, height }) => {
    // The MCP App has requested a `width` and `height`, but if
    // `box-sizing: border-box` is applied to the outer iframe element, then we
    // must add border thickness to compute the actual necessary size (in order
    // to prevent a resize feedback loop).
    const style = getComputedStyle(iframe);
    const isBorderBox = style.boxSizing === "border-box";

    const from: Keyframe = {};
    const to: Keyframe = {};

    if (width !== undefined) {
      if (isBorderBox) {
        width += parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      }
      from.minWidth = `${iframe.offsetWidth}px`;
      iframe.style.minWidth = to.minWidth = `min(${width}px, 100%)`;
    }
    if (height !== undefined) {
      if (isBorderBox) {
        height += parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      }
      from.height = `${iframe.offsetHeight}px`;
      iframe.style.height = to.height = `${height}px`;
    }

    iframe.animate([from, to], { duration: 300, easing: "ease-out" });
  };

  return appBridge;
}
