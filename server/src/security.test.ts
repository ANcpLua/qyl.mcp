import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { CollectorError, collectorPost } from "./collector.js";
import { collectorUrl } from "./config.js";
import { toolError } from "./request-scope.js";

test("collector URL rejects embedded credentials and query secrets", () => {
  const previous = process.env.QYL_COLLECTOR_URL;
  try {
    process.env.QYL_COLLECTOR_URL = "https://user:password@example.test/api?token=secret";
    assert.throws(collectorUrl, /credential-free/u);
  } finally {
    restoreEnvironment("QYL_COLLECTOR_URL", previous);
  }
});

test("tool errors expose only controlled collector failures", () => {
  assert.deepEqual(toolError(new CollectorError("collector unavailable", true)), {
    content: [{ type: "text", text: "collector unavailable" }],
    structuredContent: {
      error: { code: "collector_unreachable", message: "collector unavailable", retryable: true },
    },
    isError: true,
  });
  assert.deepEqual(toolError(new Error("Authorization: Bearer should-never-escape")), {
    content: [{ type: "text", text: "Telemetry request failed." }],
    structuredContent: {
      error: { code: "internal", message: "Telemetry request failed.", retryable: false },
    },
    isError: true,
  });
});

test("collector Problem Details cannot inject remote detail into tool-facing errors", async () => {
  const listener = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/problem+json" });
    response.end(JSON.stringify({
      type: "https://qyl.at/problems/service-unavailable",
      code: "service_unavailable",
      title: "Unavailable",
      status: 503,
      detail: "Authorization: Bearer remote-secret",
    }));
  });
  await listen(listener);
  const address = listener.address();
  assert(address && typeof address === "object");
  const previous = process.env.QYL_COLLECTOR_URL;
  process.env.QYL_COLLECTOR_URL = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(
      collectorPost("/failure", {}),
      (error: unknown) => error instanceof CollectorError
        && error.status === 503
        && !error.message.includes("remote-secret"),
    );
  } finally {
    restoreEnvironment("QYL_COLLECTOR_URL", previous);
    await close(listener);
  }
});

test("transient answers without a contract body keep their retryable status code", async () => {
  const cases = [
    { status: 502, type: "text/html", body: "<html>bad gateway</html>", code: "collector_error", retryable: true },
    { status: 429, type: undefined, body: "", code: "collector_rate_limited", retryable: true },
    { status: 400, type: "text/plain", body: "nope", code: "contract_mismatch", retryable: false },
  ];
  for (const expected of cases) {
    const listener = createServer((_request, response) => {
      response.writeHead(expected.status, expected.type === undefined ? {} : { "content-type": expected.type });
      response.end(expected.body);
    });
    await listen(listener);
    const address = listener.address();
    assert(address && typeof address === "object");
    const previous = process.env.QYL_COLLECTOR_URL;
    process.env.QYL_COLLECTOR_URL = `http://127.0.0.1:${address.port}`;
    try {
      await assert.rejects(collectorPost("/failure", {}), (error: unknown) => {
        assert(error instanceof CollectorError);
        assert.equal(error.code, expected.code, `status ${expected.status}`);
        const structured = toolError(error).structuredContent as { error: { retryable: boolean } };
        assert.equal(structured.error.retryable, expected.retryable, `status ${expected.status}`);
        return true;
      });
    } finally {
      restoreEnvironment("QYL_COLLECTOR_URL", previous);
      await close(listener);
    }
  }
});

test("collector requests fail closed on the configured timeout", async () => {
  const listener = createServer((_request, response) => {
    setTimeout(() => {
      if (!response.destroyed) response.end("{}");
    }, 100);
  });
  await listen(listener);
  const address = listener.address();
  assert(address && typeof address === "object");
  const previous = process.env.QYL_COLLECTOR_URL;
  process.env.QYL_COLLECTOR_URL = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(
      collectorPost("/slow", {}, { timeoutMs: 20 }),
      (error: unknown) => error instanceof CollectorError
        && error.connectionError
        && error.message === "collector timed out for /slow",
    );
  } finally {
    restoreEnvironment("QYL_COLLECTOR_URL", previous);
    await close(listener);
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
