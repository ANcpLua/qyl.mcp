import { useEffect, useState } from "react";
import { ToolSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { RunnerMcpToolsResponseSchema } from "./contracts";
import { responseErrorDetail } from "./bridge";

export interface ToolsState {
  tools: Tool[];
  loading: boolean;
  error: string | null;
}

const EMPTY: ToolsState = { tools: [], loading: false, error: null };

// Fetches the tool list for a resource via the runner's MCP passthrough once
// the resource is ready. Refetches whenever the resource flips back to ready
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
          throw new Error(await responseErrorDetail(res));
        }
        return RunnerMcpToolsResponseSchema.parse(await res.json());
      })
      .then(({ tools }) => {
        const protocolTools = tools.map((tool) => ToolSchema.parse(tool));
        setState({ tools: protocolTools, loading: false, error: null });
      })
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
