// Sandboxed MCP App frame — the double-iframe pattern from ext-apps basic-host
// (loadSandboxProxy + initializeApp + AppIFramePanel), backed by the runner's
// REST passthrough instead of a direct SDK Client.
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

// The runner serves the built dist-sandbox/sandbox.html from a separate origin
// (Ports.Sandbox) so the sandbox proxy can never be same-origin with the host.
const SANDBOX_PROXY_BASE_URL = "http://127.0.0.1:18889/sandbox.html";

function loadSandboxProxy(
  iframe: HTMLIFrameElement,
  csp?: McpUiResourceCsp,
  permissions?: McpUiResourcePermissions,
): Promise<boolean> {
  // Prevent reload (also guards React Strict Mode's double effect invocation)
  if (iframe.src) return Promise.resolve(false);

  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");

  // Set Permission Policy allow attribute based on requested permissions
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

  // Build sandbox URL with CSP query param for HTTP header-based CSP
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

  // Connect app bridge (triggers MCP initialization handshake)
  //
  // IMPORTANT: Pass `iframe.contentWindow` as BOTH target and source to ensure
  // this proxy only responds to messages from its specific iframe.
  await appBridge.connect(
    new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!),
  );

  // Load inner iframe HTML with CSP and permissions metadata
  log.info("Sending UI resource HTML to MCP App", csp ? `(CSP: ${JSON.stringify(csp)})` : "");
  await appBridge.sendSandboxResourceReady({ html, csp, permissions });

  // Wait for inner iframe to be ready
  log.info("Waiting for MCP App to initialize...");
  await appInitializedPromise;
  log.info("MCP App initialized");

  // Send tool call input to iframe
  log.info("Sending tool call input to MCP App");
  appBridge.sendToolInput({ arguments: input });

  // Schedule tool call result (or cancellation) to be sent to the MCP App
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

    // First get CSP and permissions from the resource, then load the sandbox.
    // CSP is enforced via HTTP headers on :18889, permissions via the iframe
    // allow attribute.
    readAppResource(resource, resourceUri)
      .then((resourceData) =>
        loadSandboxProxy(iframe, resourceData.csp, resourceData.permissions).then((firstTime) => {
          // `firstTime` guards against React Strict Mode's double invocation;
          // outside Strict Mode this effect runs once per tool call entry.
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
      // Bridge not ready yet (e.g., user closed before the iframe loaded)
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
