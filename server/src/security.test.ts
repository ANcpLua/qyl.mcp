import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { CollectorError, collectorGet } from "./collector.js";
import { collectorUrl } from "./config.js";
import { toolError } from "./tools.js";

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
  assert.deepEqual(toolError(new CollectorError("collector unavailable")), {
    content: [{ type: "text", text: "collector unavailable" }],
    isError: true,
  });
  assert.deepEqual(toolError(new Error("Authorization: Bearer should-never-escape")), {
    content: [{ type: "text", text: "Telemetry request failed." }],
    isError: true,
  });
});

test("collector Problem Details cannot inject remote detail into tool-facing errors", async () => {
  const listener = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/problem+json" });
    response.end(JSON.stringify({
      type: "about:blank",
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
      collectorGet("/failure"),
      (error: unknown) => error instanceof CollectorError
        && error.status === 503
        && !error.message.includes("remote-secret"),
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
