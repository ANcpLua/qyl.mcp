import assert from "node:assert/strict";
import test from "node:test";
import type {
  RunnerMcpServerId,
  RunnerMcpTestCaseId,
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
      workspaceIds: ["workspace-1"],
      activeWorkspaceId: "workspace-1",
      createdAt: "2026-07-15T10:00:00.000Z",
    }));
  };
  try {
    const session = await new WorkbenchApi("http://127.0.0.1:18888").getSession();
    assert.equal(session.activeWorkspaceId, "workspace-1");
    assert.equal(String(request?.input), "http://127.0.0.1:18888/runner/session");
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
      workspaceId: "workspace/one",
      name: "Remote",
      configuration: {
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/mcp",
        headers: [{ name: "Authorization", secret: { source: "environment", environmentVariable: "MCP_TOKEN" }, scheme: "bearer" }],
      },
      connection: { status: "disconnected", changedAt: "2026-07-15T10:00:00.000Z" },
      createdAt: "2026-07-15T10:00:00.000Z",
      updatedAt: "2026-07-15T10:00:00.000Z",
    }));
  };
  try {
    await new WorkbenchApi().createServer("workspace/one", {
      name: "Remote",
      configuration: {
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/mcp",
        headers: [{ name: "Authorization", secret: { source: "environment", environmentVariable: "MCP_TOKEN" }, scheme: "bearer" }],
      },
    });
    assert.equal(String(request?.input), "/runner/workspaces/workspace%2Fone/servers");
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
  const serverId = "server/one" as RunnerMcpServerId;
  const testCaseId = "test/one" as RunnerMcpTestCaseId;
  globalThis.fetch = (input, init) => {
    requests.push({ input: String(input), init: init ?? {} });
    const path = String(input);
    if (path.endsWith("/workspaces/workspace%2Fone")) {
      return Promise.resolve(jsonResponse({
        id: "workspace/one",
        ownerId: "local",
        name: "Renamed workspace",
        description: "Edited",
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
    }
    if (path.endsWith("/servers/server%2Fone")) {
      return Promise.resolve(jsonResponse({
        id: "server/one",
        workspaceId: "workspace/one",
        name: "Remote edited",
        configuration: {
          transport: "streamable_http",
          endpoint: "https://mcp.example.test/mcp",
          headers: [{ name: "Authorization", secret: { source: "environment", environmentVariable: "MCP_TOKEN" }, scheme: "bearer" }],
        },
        connection: { status: "disconnected", changedAt: timestamp },
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
    }
    if (path.endsWith("/test-cases/test%2Fone")) {
      return Promise.resolve(jsonResponse({
        id: "test/one",
        workspaceId: "workspace/one",
        serverId: "server/one",
        name: "Echo edited",
        toolName: "echo",
        arguments: { text: "hello" },
        timeoutMs: 1_000,
        assertions: [{ id: "assertion-1", kind: "status", expected: ["succeeded"] }],
        tags: ["regression"],
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
    }
    return Promise.resolve(jsonResponse({
      id: "suite/one",
      workspaceId: "workspace/one",
      name: "Suite edited",
      testCaseIds: ["test/one"],
      tags: ["regression"],
      createdAt: timestamp,
      updatedAt: timestamp,
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
        headers: [{ name: "Authorization", secret: { source: "environment", environmentVariable: "MCP_TOKEN" }, scheme: "bearer" }],
      },
    });
    await api.updateTestCase("workspace/one", "test/one", {
      name: "Echo edited",
      serverId,
      toolName: "echo",
      arguments: { text: "hello" },
      timeoutMs: 1_000,
      assertions: [{ id: "assertion-1", kind: "status", expected: ["succeeded"] }],
      tags: ["regression"],
    });
    await api.updateSuite("workspace/one", "suite/one", {
      name: "Suite edited",
      testCaseIds: [testCaseId],
      tags: ["regression"],
    });

    assert.deepEqual(requests.map((request) => request.init.method), ["PATCH", "PATCH", "PATCH", "PATCH"]);
    assert.deepEqual(requests.map((request) => request.input), [
      "/runner/workspaces/workspace%2Fone",
      "/runner/workspaces/workspace%2Fone/servers/server%2Fone",
      "/runner/workspaces/workspace%2Fone/test-cases/test%2Fone",
      "/runner/workspaces/workspace%2Fone/suites/suite%2Fone",
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
      workspaceIds: ["workspace-1"],
      createdAt: "2026-07-15T10:00:00.000Z",
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
    assert.ok(bodies.every((body) => typeof body.idempotencyKey === "string"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
