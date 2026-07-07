import { useEffect, useState } from "react";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ToolsState {
  tools: Tool[];
  loading: boolean;
  error: string | null;
}

const EMPTY: ToolsState = { tools: [], loading: false, error: null };

// Fetches the tool list for a resource via the runner's MCP passthrough once
// the resource is Ready. Refetches whenever the resource flips back to Ready
// (e.g. after a restart).
export function useTools(resource: string | null, ready: boolean): ToolsState {
  const [state, setState] = useState<ToolsState>(EMPTY);

  useEffect(() => {
    if (!resource || !ready) {
      setState(EMPTY);
      return;
    }

    const controller = new AbortController();
    setState({ tools: [], loading: true, error: null });

    fetch(`/runner/mcp/${encodeURIComponent(resource)}/tools`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          let detail = `${res.status} ${res.statusText}`;
          try {
            const payload = (await res.json()) as { error?: string };
            if (payload.error) detail = payload.error;
          } catch {
            // non-JSON error body
          }
          throw new Error(detail);
        }
        return res.json() as Promise<{ tools: Tool[] }>;
      })
      .then(({ tools }) => setState({ tools, loading: false, error: null }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          tools: [],
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return () => controller.abort();
  }, [resource, ready]);

  return state;
}
