import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import test from "node:test";
import express from "express";
import { loopbackRequestGuard, WorkbenchAllowedOrigins } from "./http-security.js";

interface TestResponse {
    status: number;
    contentType?: string;
    body: string;
}

async function listen(): Promise<{ server: Server; port: number }> {
    const app = express();
    app.use(loopbackRequestGuard(WorkbenchAllowedOrigins));
    app.get("/probe", (_request, response) => response.status(204).end());
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");
    return { server, port: address.port };
}

function get(
    port: number,
    headers: Readonly<Record<string, string>> = {},
    setHost = true,
): Promise<TestResponse> {
    return new Promise((resolvePromise, reject) => {
        const outgoing = request(
            {
                hostname: "127.0.0.1",
                port,
                path: "/probe",
                method: "GET",
                headers,
                setHost,
            },
            (response) => {
                response.setEncoding("utf8");
                let body = "";
                response.on("data", (chunk) => (body += chunk));
                response.on("end", () =>
                    resolvePromise({
                        status: response.statusCode ?? 0,
                        contentType: response.headers["content-type"],
                        body,
                    }),
                );
            },
        );
        outgoing.on("error", reject);
        outgoing.end();
    });
}

test("loopback guard accepts local hosts and the dashboard origins", async (context) => {
    const { server, port } = await listen();
    context.after(() => server.close());

    assert.equal((await get(port)).status, 204);
    assert.equal(
        (await get(port, { origin: "http://127.0.0.1:18888" })).status,
        204,
    );
    assert.equal(
        (await get(port, { host: `localhost:${port}`, origin: "http://localhost:5173" })).status,
        204,
    );
});

test("loopback guard rejects missing or rebound Host headers", async (context) => {
    const { server, port } = await listen();
    context.after(() => server.close());

    // Node itself may reject an HTTP/1.1 request without Host before Express
    // sees it; either way, it must never reach the route.
    assert.notEqual((await get(port, {}, false)).status, 204);

    const response = await get(port, { host: `attacker.example:${port}` });
    assert.equal(response.status, 403);
    assert.match(response.contentType ?? "", /^application\/problem\+json/);
    assert.deepEqual(JSON.parse(response.body), {
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "Requests must use a loopback Host header.",
    });
});

test("loopback guard rejects untrusted browser origins", async (context) => {
    const { server, port } = await listen();
    context.after(() => server.close());

    for (const origin of ["https://attacker.example", "null", "http://localhost:9999"]) {
        const response = await get(port, { origin });
        assert.equal(response.status, 403);
        assert.equal(JSON.parse(response.body).detail, "The request Origin is not allowed.");
    }
});
