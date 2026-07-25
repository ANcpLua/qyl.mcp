import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkbenchServerId,
  WorkbenchTestCaseId,
} from "@ancplua/qyl-api-schema/types";
import {
  WorkbenchApi,
  WorkbenchApiError,
  describeApiError,
} from "./api.js";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

test("API requests retain loopback cookie authentication and validate envelopes", async () => {
  const originalFetch = globalThis.fetch;
  let request: { input: string | URL | Request; init?: RequestInit } | undefined;
  globalThis.fetch = (input, init) => {
    request = { input, init };
    return Promise.resolve(jsonResponse({
      id: "session-1",
      principal: { id: "local", local: true },
      workspace_ids: ["workspace-1"],
      active_workspace_id: "workspace-1",
      created_at: "2026-07-15T10:00:00.000Z",
    }));
  };
  try {
    const session = await new WorkbenchApi("http://127.0.0.1:18888").getSession();
    assert.equal(session.active_workspace_id, "workspace-1");
    assert.equal(String(request?.input), "http://127.0.0.1:18888/workbench/session");
    assert.equal(request?.init?.credentials, "same-origin");
    assert.match(new Headers(request?.init?.headers).get("Accept") ?? "", /application\/problem\+json/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API paths encode workspace identifiers and never synthesize secret values", async () => {
  const originalFetch = globalThis.fetch;
  let request: { input: string | URL | Request; init?: RequestInit } | undefined;
  globalThis.fetch = (input, init) => {
    request = { input, init };
    return Promise.resolve(jsonResponse({
      id: "server-1",
      workspace_id: "workspace/one",
      name: "Remote",
      configuration: {
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/mcp",
        headers: [{ name: "Authorization", secret: { source: "environment", environment_variable: "MCP_TOKEN" }, scheme: "bearer" }],
      },
      connection: { status: "disconnected", changed_at: "2026-07-15T10:00:00.000Z" },
      created_at: "2026-07-15T10:00:00.000Z",
      updated_at: "2026-07-15T10:00:00.000Z",
    }));
  };
  try {
    await new WorkbenchApi().createServer("workspace/one", {
      name: "Remote",
      configuration: {
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/mcp",
        headers: [{ name: "Authorization", secret: { source: "environment", environment_variable: "MCP_TOKEN" }, scheme: "bearer" }],
      },
    });
    assert.equal(String(request?.input), "/workbench/workspaces/workspace%2Fone/servers");
    const body = JSON.parse(String(request?.init?.body)) as Record<string, unknown>;
    assert.doesNotMatch(JSON.stringify(body), /Bearer [A-Za-z0-9]/u);
    assert.match(JSON.stringify(body), /MCP_TOKEN/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PATCH clients validate generated update contracts and response envelopes", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const timestamp = "2026-07-15T10:00:00.000Z";
  const serverId = "server/one" as WorkbenchServerId;
  const testCaseId = "test/one" as WorkbenchTestCaseId;
  globalThis.fetch = (input, init) => {
    requests.push({ input: String(input), init: init ?? {} });
    const path = String(input);
    if (path.endsWith("/workspaces/workspace%2Fone")) {
      return Promise.resolve(jsonResponse({
        id: "workspace/one",
        owner_id: "local",
        name: "Renamed workspace",
        description: "Edited",
        created_at: timestamp,
        updated_at: timestamp,
      }));
    }
    if (path.endsWith("/servers/server%2Fone")) {
      return Promise.resolve(jsonResponse({
        id: "server/one",
        workspace_id: "workspace/one",
        name: "Remote edited",
        configuration: {
          transport: "streamable_http",
          endpoint: "https://mcp.example.test/mcp",
          headers: [{ name: "Authorization", secret: { source: "environment", environment_variable: "MCP_TOKEN" }, scheme: "bearer" }],
        },
        connection: { status: "disconnected", changed_at: timestamp },
        created_at: timestamp,
        updated_at: timestamp,
      }));
    }
    if (path.endsWith("/test-cases/test%2Fone")) {
      return Promise.resolve(jsonResponse({
        id: "test/one",
        workspace_id: "workspace/one",
        server_id: "server/one",
        name: "Echo edited",
        tool_name: "echo",
        arguments: { text: "hello" },
        timeout_ms: 1_000,
        assertions: [{ id: "assertion-1", kind: "status", expected: ["succeeded"] }],
        tags: ["regression"],
        created_at: timestamp,
        updated_at: timestamp,
      }));
    }
    return Promise.resolve(jsonResponse({
      id: "suite/one",
      workspace_id: "workspace/one",
      name: "Suite edited",
      test_case_ids: ["test/one"],
      tags: ["regression"],
      created_at: timestamp,
      updated_at: timestamp,
    }));
  };
  try {
    const api = new WorkbenchApi();
    await api.updateWorkspace("workspace/one", { name: "Renamed workspace", description: "Edited" });
    await api.updateServer("workspace/one", "server/one", {
      name: "Remote edited",
      configuration: {
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/mcp",
        headers: [{ name: "Authorization", secret: { source: "environment", environment_variable: "MCP_TOKEN" }, scheme: "bearer" }],
      },
    });
    await api.updateTestCase("workspace/one", "test/one", {
      name: "Echo edited",
      server_id: serverId,
      tool_name: "echo",
      arguments: { text: "hello" },
      timeout_ms: 1_000,
      assertions: [{ id: "assertion-1", kind: "status", expected: ["succeeded"] }],
      tags: ["regression"],
    });
    await api.updateSuite("workspace/one", "suite/one", {
      name: "Suite edited",
      test_case_ids: [testCaseId],
      tags: ["regression"],
    });

    assert.deepEqual(requests.map((request) => request.init.method), ["PATCH", "PATCH", "PATCH", "PATCH"]);
    assert.deepEqual(requests.map((request) => request.input), [
      "/workbench/workspaces/workspace%2Fone",
      "/workbench/workspaces/workspace%2Fone/servers/server%2Fone",
      "/workbench/workspaces/workspace%2Fone/test-cases/test%2Fone",
      "/workbench/workspaces/workspace%2Fone/suites/suite%2Fone",
    ]);
    assert.match(String(requests[1]?.init.body), /MCP_TOKEN/u);
    assert.doesNotMatch(String(requests[1]?.init.body), /remote-service-token/u);

    const requestCount = requests.length;
    await assert.rejects(
      () => api.updateWorkspace("workspace/one", { name: "" }),
      /Workspace update request violated the published Qyl contract/u,
    );
    assert.equal(requests.length, requestCount, "invalid PATCH body must be rejected before fetch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("problem details and malformed successful payloads stay distinct", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = () => Promise.resolve(jsonResponse({
      type: "about:blank",
      title: "Service Unavailable",
      status: 503,
      detail: "The workbench dependency is unavailable.",
      reason: "dependency_failure",
    }, { status: 503, headers: { "X-Request-Id": "request-7" } }));
    await assert.rejects(
      () => new WorkbenchApi().listWorkspaces(),
      (error: unknown) => {
        assert.ok(error instanceof WorkbenchApiError);
        assert.equal(error.status, 503);
        assert.equal(describeApiError(error), "HTTP 503 · The workbench dependency is unavailable. · request request-7");
        return true;
      },
    );

    globalThis.fetch = () => Promise.resolve(jsonResponse({ workspaces: "not-an-array" }));
    await assert.rejects(
      () => new WorkbenchApi().listWorkspaces(),
      /violated the published Qyl contract.*expected array/u,
    );

    globalThis.fetch = () => Promise.resolve(jsonResponse({
      id: "session-1",
      principal: { id: "local", local: false },
      workspace_ids: ["workspace-1"],
      created_at: "2026-07-15T10:00:00.000Z",
    }));
    await assert.rejects(
      () => new WorkbenchApi().getSession(),
      /violated the published Qyl contract.*principal\.local/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluation requests preserve explicit run-level confirmation", async () => {
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = (_input, init) => {
    requests.push(init ?? {});
    return Promise.resolve(jsonResponse({}, { status: 202 }));
  };
  const confirmation = {
    acknowledged: true as const,
    acknowledgement: "Reviewed persisted targets and approved their external effects",
  };
  try {
    const api = new WorkbenchApi();
    await assert.rejects(
      () => api.runTestCase("workspace-1", "test-1", confirmation),
      /violated the published Qyl contract/u,
    );
    await assert.rejects(
      () => api.runSuite("workspace-1", "suite-1", confirmation),
      /violated the published Qyl contract/u,
    );

    const bodies = requests.map((request) => JSON.parse(String(request.body)) as Record<string, unknown>);
    assert.deepEqual(bodies.map((body) => body.confirmation), [confirmation, confirmation]);
    assert.ok(bodies.every((body) => typeof body.idempotency_key === "string"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
