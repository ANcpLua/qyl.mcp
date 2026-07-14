// Double-iframe MCP App sandbox backed by the runner's REST passthrough.
import { useEffect, useRef } from "react";
import {
  AppBridge,
  PostMessageTransport,
  buildAllowAttribute,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
  type McpUiSandboxProxyReadyNotification,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RunnerClientAdapter, log, newAppBridge, readAppResource, type UiResourceData } from "./bridge";

const SANDBOX_PROXY_BASE_URL = "http://127.0.0.1:18889/sandbox.html";

function loadSandboxProxy(
  iframe: HTMLIFrameElement,
  csp?: McpUiResourceCsp,
  permissions?: McpUiResourcePermissions,
): Promise<boolean> {
  if (iframe.src) return Promise.resolve(false);

  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");

  const allowAttribute = buildAllowAttribute(permissions);
  if (allowAttribute) {
    iframe.setAttribute("allow", allowAttribute);
  }

  const readyNotification: McpUiSandboxProxyReadyNotification["method"] =
    "ui/notifications/sandbox-proxy-ready";

  const readyPromise = new Promise<boolean>((resolve) => {
    const listener = ({ source, data }: MessageEvent) => {
      if (source === iframe.contentWindow && (data as { method?: string })?.method === readyNotification) {
        log.info("Sandbox proxy loaded");
        window.removeEventListener("message", listener);
        resolve(true);
      }
    };
    window.addEventListener("message", listener);
  });

  const sandboxUrl = new URL(SANDBOX_PROXY_BASE_URL);
  if (csp) {
    sandboxUrl.searchParams.set("csp", JSON.stringify(csp));
  }

  log.info("Loading sandbox proxy...", csp ? `(CSP: ${JSON.stringify(csp)})` : "");
  iframe.src = sandboxUrl.href;

  return readyPromise;
}

async function initializeApp(
  iframe: HTMLIFrameElement,
  appBridge: AppBridge,
  { html, csp, permissions }: UiResourceData,
  input: Record<string, unknown>,
  resultPromise: Promise<CallToolResult>,
): Promise<void> {
  const appInitializedPromise = hookInitializedCallback(appBridge);

  // Confining both bridge directions to this contentWindow prevents cross-frame messages.
  await appBridge.connect(
    new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!),
  );

  log.info("Sending UI resource HTML to MCP App", csp ? `(CSP: ${JSON.stringify(csp)})` : "");
  await appBridge.sendSandboxResourceReady({ html, csp, permissions });

  log.info("Waiting for MCP App to initialize...");
  await appInitializedPromise;
  log.info("MCP App initialized");

  log.info("Sending tool call input to MCP App");
  appBridge.sendToolInput({ arguments: input });

  resultPromise.then(
    (result) => {
      log.info("Sending tool call result to MCP App");
      appBridge.sendToolResult(result);
    },
    (error: unknown) => {
      log.error("Tool call failed; sending cancellation to MCP App");
      appBridge.sendToolCancelled({
        reason: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

/**
 * Hooks into `AppBridge.oninitialized` and returns a Promise that resolves when
 * the MCP App is initialized (i.e., when the inner iframe is ready).
 */
function hookInitializedCallback(appBridge: AppBridge): Promise<void> {
  const oninitialized = appBridge.oninitialized;
  return new Promise<void>((resolve) => {
    appBridge.oninitialized = (...args) => {
      resolve();
      appBridge.oninitialized = oninitialized;
      appBridge.oninitialized?.(...args);
    };
  });
}

export interface AppFrameProps {
  resource: string;
  resourceUri: string;
  input: Record<string, unknown>;
  resultPromise: Promise<CallToolResult>;
  isDestroying?: boolean;
  onTeardownComplete?: () => void;
  onError: (message: string) => void;
}

export function AppFrame({
  resource,
  resourceUri,
  input,
  resultPromise,
  isDestroying,
  onTeardownComplete,
  onError,
}: AppFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const appBridgeRef = useRef<AppBridge | null>(null);

  useEffect(() => {
    const iframe = iframeRef.current!;

    readAppResource(resource, resourceUri)
      .then((resourceData) =>
        loadSandboxProxy(iframe, resourceData.csp, resourceData.permissions).then((firstTime) => {
          if (!firstTime) return;
          const appBridge = newAppBridge(new RunnerClientAdapter(resource), iframe);
          appBridgeRef.current = appBridge;
          return initializeApp(iframe, appBridge, resourceData, input, resultPromise);
        }),
      )
      .catch((err: unknown) => {
        onError(err instanceof Error ? err.message : String(err));
      });
  }, [resource, resourceUri, input, resultPromise, onError]);

  // Graceful teardown: wait for the guest to respond before unmounting.
  // Per spec: "Host SHOULD wait for a response before tearing down the
  // resource (to prevent data loss)."
  useEffect(() => {
    if (!isDestroying) return;

    const appBridge = appBridgeRef.current;
    if (!appBridge) {
      onTeardownComplete?.();
      return;
    }

    log.info("Sending teardown notification to MCP App");
    appBridge
      .teardownResource({})
      .catch((err: unknown) => {
        log.warn("Teardown request failed (app may have already closed):", err);
      })
      .finally(() => {
        void appBridge.close();
        onTeardownComplete?.();
      });
  }, [isDestroying, onTeardownComplete]);

  return <iframe ref={iframeRef} className="app-frame" title="MCP App" />;
}
