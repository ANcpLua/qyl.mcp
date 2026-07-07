import { useEffect, useState } from "react";
import type { ResourceState } from "./types";

const STREAM_URL = "/runner/resources/stream";

export type ConnectionState = "connecting" | "open" | "closed";

// Subscribes to the runner's SSE state stream. The server replays a snapshot on connect and then pushes
// each change; we key resources by name (last-write-wins), matching the server's idempotent contract.
export function useResources(): { resources: ResourceState[]; connection: ConnectionState } {
  const [byName, setByName] = useState<Map<string, ResourceState>>(() => new Map());
  const [connection, setConnection] = useState<ConnectionState>("connecting");

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (cancelled) return;
      setConnection("connecting");
      source = new EventSource(STREAM_URL);

      source.onopen = () => { if (!cancelled) setConnection("open"); };

      source.onmessage = (event) => {
        if (cancelled) return;
        try {
          const state = JSON.parse(event.data) as ResourceState;
          setByName((prev) => new Map(prev).set(state.name, state));
        } catch {
          // ignore a malformed frame
        }
      };

      source.onerror = () => {
        source?.close();
        if (cancelled) return;
        setConnection("closed");
        retry = setTimeout(connect, 1500);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, []);

  const resources = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { resources, connection };
}
