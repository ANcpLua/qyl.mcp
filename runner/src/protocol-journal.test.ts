import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
    JournaledTransport,
    ProtocolJournal,
    type CompletedProtocolOperation,
    type ProtocolMessageEntry,
} from "./protocol-journal.js";
import { SecretRedactor } from "./secret-redactor.js";

test("protocol journal matches request durations and carries execution correlation", () => {
    let now = 1_000;
    const operations: CompletedProtocolOperation[] = [];
    const journal = new ProtocolJournal({
        now: () => now,
        redactor: new SecretRedactor(),
        onOperation: (operation) => operations.push(operation),
    });
    const correlation = {
        executionId: "execution-1",
        workspaceId: "workspace-1",
        testCaseId: "case-1",
    };

    const request: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 17,
        method: "tools/call",
        params: {
            name: "probe",
            arguments: { apiKey: "request-secret" },
        },
    };
    const requestEntry = journal.recordMessage("outbound", request, correlation);
    assert.equal(requestEntry?.messageKind, "request");
    assert.equal(requestEntry?.method, "tools/call");
    assert.equal(requestEntry?.requestId, 17);

    now = 1_025;
    const response: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 17,
        result: {
            content: [{ type: "text", text: "Bearer response-secret" }],
            isError: true,
        },
    };
    const responseEntry = journal.recordMessage("inbound", response);
    assert.equal(responseEntry?.messageKind, "response");
    assert.equal(responseEntry?.method, "tools/call");
    assert.equal(responseEntry?.requestId, 17);
    assert.equal(responseEntry?.durationMs, 25);
    assert.deepEqual(responseEntry?.correlation, correlation);
    assert.deepEqual(operations, [{
        role: "client",
        direction: "outbound",
        method: "tools/call",
        requestId: 17,
        correlation,
        startTimeMs: 1_000,
        endTimeMs: 1_025,
        toolName: "probe",
        errorType: "tool_error",
    }]);

    const serialized = JSON.stringify(journal.snapshot());
    assert.equal(serialized.includes("request-secret"), false);
    assert.equal(serialized.includes("response-secret"), false);
});

test("protocol operations distinguish server processing, errors, and notifications", () => {
    let now = 2_000;
    const operations: CompletedProtocolOperation[] = [];
    const journal = new ProtocolJournal({
        now: () => now,
        onOperation: (operation) => operations.push(operation),
    });
    journal.recordMessage("inbound", {
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompts/get",
        params: { name: "release" },
    });
    now = 2_050;
    journal.recordMessage("outbound", {
        jsonrpc: "2.0",
        id: "prompt-1",
        error: { code: -32602, message: "invalid" },
    });
    now = 2_060;
    journal.recordMessage("outbound", {
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri: "fixture://item/1" },
    });

    assert.deepEqual(operations, [
        {
            role: "server",
            direction: "inbound",
            method: "prompts/get",
            requestId: "prompt-1",
            startTimeMs: 2_000,
            endTimeMs: 2_050,
            promptName: "release",
            errorType: "-32602",
            rpcResponseStatusCode: "-32602",
        },
        {
            role: "client",
            direction: "outbound",
            method: "notifications/resources/updated",
            startTimeMs: 2_060,
            endTimeMs: 2_060,
            resourceUri: "fixture://item/1",
        },
    ]);
});

test("protocol journal is bounded, validates messages, and bounds sanitized payloads", () => {
    const journal = new ProtocolJournal({ maxEntries: 2, maxPayloadCharacters: 80 });
    journal.recordMessage("inbound", {
        jsonrpc: "2.0",
        method: "notifications/one",
        params: { value: "one" },
    });
    journal.recordMessage("inbound", {
        jsonrpc: "2.0",
        method: "notifications/two",
        params: { value: "two".repeat(100), password: "payload-secret" },
    });
    journal.recordMessage("inbound", {
        jsonrpc: "2.0",
        method: "notifications/three",
    });

    const entries = journal.snapshot();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((entry) => entry.sequence), [2, 3]);
    const truncated = entries[0] as ProtocolMessageEntry;
    assert.deepEqual(
        Object.keys(truncated.payload as Record<string, unknown>).sort(),
        ["originalCharacters", "preview", "truncated"],
    );
    assert.equal(JSON.stringify(truncated.payload).includes("payload-secret"), false);

    const invalid = journal.recordMessage(
        "inbound",
        { jsonrpc: "2.0" } as unknown as JSONRPCMessage,
    );
    assert.equal(invalid, undefined);
    assert.equal(journal.snapshot().at(-1)?.kind, "transport_error");
});

test("journaled transport transparently records SDK messages and close", async () => {
    const [inner, peer] = InMemoryTransport.createLinkedPair();
    const journal = new ProtocolJournal();
    const transport = new JournaledTransport(inner, journal, {
        correlation: () => ({ executionId: "execution-transport" }),
    });

    let resolveOutbound: ((message: JSONRPCMessage) => void) | undefined;
    const outbound = new Promise<JSONRPCMessage>((resolve) => {
        resolveOutbound = resolve;
    });
    peer.onmessage = (message) => resolveOutbound?.(message);

    let resolveInbound: ((message: JSONRPCMessage) => void) | undefined;
    const inbound = new Promise<JSONRPCMessage>((resolve) => {
        resolveInbound = resolve;
    });
    transport.onmessage = (message) => resolveInbound?.(message);

    await Promise.all([transport.start(), peer.start()]);
    const request: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: "request-1",
        method: "ping",
    };
    await transport.send(request);
    assert.deepEqual(await outbound, request);

    const response: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: "request-1",
        result: {},
    };
    await peer.send(response);
    assert.deepEqual(await inbound, response);

    transport.setProtocolVersion("2025-11-25");
    assert.equal(transport.protocolVersion, "2025-11-25");
    await transport.close();
    await transport.close();

    const entries = journal.snapshot();
    assert.deepEqual(
        entries.map((entry) => entry.kind),
        ["message", "message", "transport_close"],
    );
    assert.deepEqual(entries[0]?.correlation, { executionId: "execution-transport" });
});

test("journaled transport records sanitized transport failures", async () => {
    const failingTransport: Transport = {
        async start() {},
        async send() {
            throw new Error("Authorization: Bearer transport-secret");
        },
        async close() {},
    };
    const journal = new ProtocolJournal();
    const transport = new JournaledTransport(failingTransport, journal);
    await transport.start();

    await assert.rejects(
        transport.send({ jsonrpc: "2.0", method: "notifications/probe" }),
        /transport-secret/u,
    );

    const errorEntry = journal.snapshot().find((entry) => entry.kind === "transport_error");
    assert(errorEntry?.kind === "transport_error");
    assert.equal(errorEntry.message.includes("transport-secret"), false);
    assert.match(errorEntry.message, /\[REDACTED\]/u);
});

test("throwing journal observers are recorded without disrupting transport sends", async () => {
    let sent = false;
    const inner: Transport = {
        async start() {},
        async send() {
            sent = true;
        },
        async close() {},
    };
    const journal = new ProtocolJournal();
    journal.subscribe(() => {
        throw new Error("Bearer observer-secret");
    });
    const transport = new JournaledTransport(inner, journal);
    await transport.start();
    await transport.send({ jsonrpc: "2.0", method: "notifications/probe" });

    assert.equal(sent, true);
    const observerError = journal.snapshot().find((entry) => entry.kind === "observer_error");
    assert(observerError?.kind === "observer_error");
    assert.equal(observerError.message.includes("observer-secret"), false);
});

test("a rejected close is an error, not a successful close event", async () => {
    const inner: Transport = {
        async start() {},
        async send() {},
        async close() {
            throw new Error("close failed");
        },
    };
    const journal = new ProtocolJournal();
    const transport = new JournaledTransport(inner, journal);
    await transport.start();
    await assert.rejects(transport.close(), /close failed/u);

    assert.equal(journal.snapshot().some((entry) => entry.kind === "transport_close"), false);
    assert.equal(journal.snapshot().some((entry) => entry.kind === "transport_error"), true);
});
