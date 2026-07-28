import assert from "node:assert/strict";
import test from "node:test";
import { dnsRebindingResponse, isLoopbackBindHost } from "./http-security.js";

interface Envelope {
  jsonrpc: string;
  id: unknown;
  error: { code: number; message: string };
}

function probe(
  headers: Readonly<Record<string, string>>,
  allowedHosts?: readonly string[],
  allowedOrigins?: readonly string[],
): Response | undefined {
  return dnsRebindingResponse(
    new Request("http://127.0.0.1:3001/mcp", { method: "POST", headers }),
    allowedHosts,
    allowedOrigins,
  );
}

async function envelope(response: Response): Promise<Envelope> {
  return await response.json() as Envelope;
}

test("the loopback default accepts loopback Host and local or absent Origin", () => {
  assert.equal(probe({ host: "127.0.0.1:3001" }), undefined);
  assert.equal(probe({ host: `localhost:3001`, origin: "http://localhost:3001" }), undefined);
  assert.equal(probe({ host: "127.0.0.1:9999", origin: "http://localhost:9999" }), undefined);
});

test("the guard rejects a missing and a rebound Host", async () => {
  const missing = probe({});
  assert(missing);
  assert.equal(missing.status, 403);
  assert.equal((await envelope(missing)).error.code, -32000);

  const rebound = probe({ host: "attacker.example:3001" });
  assert(rebound);
  assert.equal(rebound.status, 403);
  assert.equal((await envelope(rebound)).error.code, -32000);
});

test("the guard rejects foreign and opaque Origins", async () => {
  for (const origin of ["https://attacker.example", "null"]) {
    const response = probe({ host: "127.0.0.1:3001", origin });
    assert(response);
    assert.equal(response.status, 403);
    const body = await envelope(response);
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.error.code, -32000);
    assert.match(body.error.message, /^Invalid Origin(?: header)?:/u);
    assert.equal(body.id, null);
  }
});

test("explicit allowlists replace the loopback default", async () => {
  const hosts = ["mcp.qyl.at", "healthcheck.railway.app"];
  assert.equal(probe({ host: "mcp.qyl.at" }, hosts, hosts), undefined);
  assert.equal(probe({ host: "healthcheck.railway.app" }, hosts, hosts), undefined);

  const loopbackNowRejected = probe({ host: "127.0.0.1:3001" }, hosts, hosts);
  assert(loopbackNowRejected);
  assert.equal(loopbackNowRejected.status, 403);
  assert.equal((await envelope(loopbackNowRejected)).error.code, -32000);
});

test("loopback bind hosts are named exactly", () => {
  assert.equal(isLoopbackBindHost("127.0.0.1"), true);
  assert.equal(isLoopbackBindHost("localhost"), true);
  assert.equal(isLoopbackBindHost("::1"), true);
  assert.equal(isLoopbackBindHost("0.0.0.0"), false);
});
