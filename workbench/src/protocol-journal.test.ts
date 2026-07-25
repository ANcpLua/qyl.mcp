import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { Transport, JSONRPCMessage } from "@modelcontextprotocol/server";
import {
    JournaledTransport,
    ProtocolJournal,
    type CompletedProtocolOperation,
    type ProtocolMessageEntry,
} from "./protocol-journal.js";
import { SecretRedactor } from "./secret-redactor.js";

test("protocol journal is metadata-only by default for arbitrary tool-defined content", () => {
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
            arguments: {
                arbitraryHeaderName: "Mcp-Param-Innocent",
                arbitraryEncodedValue: "c2Vuc2l0aXZlLXRvb2wtYXJndW1lbnQ=",
            },
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
            content: [{ type: "text", text: "sensitive-tool-result" }],
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
    assert.equal(serialized.includes("Mcp-Param-Innocent"), false);
    assert.equal(serialized.includes("c2Vuc2l0aXZlLXRvb2wtYXJndW1lbnQ="), false);
    assert.equal(serialized.includes("sensitive-tool-result"), false);
    assert.match(serialized, /"toolName":"probe"/u);
});

test("protocol journal captures bounded redacted content only after explicit opt-in", () => {
    const journal = new ProtocolJournal({
        captureContent: true,
        redactor: new SecretRedactor({ secretValues: ["known-secret"] }),
    });
    journal.recordMessage("outbound", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
            name: "probe",
            arguments: { query: "known-secret" },
        },
    });

    const serialized = JSON.stringify(journal.snapshot());
    assert.equal(serialized.includes("known-secret"), false);
    assert.match(serialized, /\[REDACTED\]/u);
});

test("protocol journal preserves an id-less JSON-RPC error without fabricating a request id", () => {
    const journal = new ProtocolJournal();
    const entry = journal.recordMessage("inbound", {
        jsonrpc: "2.0",
        error: { code: -32600, message: "invalid request" },
    });

    assert.equal(entry?.messageKind, "error_response");
    assert.equal(entry?.requestId, undefined);
    assert.deepEqual(entry?.payload, {
        jsonrpc: "2.0",
        error: { code: -32600 },
    });
});

test("protocol operations distinguish server processing, errors, and notifications", () => {
    let now = 2_000;
    const operations: CompletedProtocolOperation[] = [];
    const journal = new ProtocolJournal({
        now: () => now,
        onOperation: (operation) => operations.push(operation),
    });
    const remoteParent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    journal.recordMessage("inbound", {
        jsonrpc: "2.0",
        id: "prompt-1",
        method: "prompts/get",
        params: { name: "release", _meta: { traceparent: remoteParent } },
    });
    now = 2_050;
    journal.recordMessage("outbound", {
        jsonrpc: "2.0",
        id: "prompt-1",
        error: { code: -32602, message: "invalid" },
    });
    now = 2_060;
    const notification: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri: "fixture://item/1" },
    };
    const notificationEntry = journal.recordMessage("outbound", notification);
    assert.equal(operations.length, 1, "notification is not complete before its ack");
    now = 2_075;
    journal.completeNotification("outbound", notification, notificationEntry!.timestampMs);

    assert.deepEqual(operations, [
        {
            role: "server",
            direction: "inbound",
            method: "prompts/get",
            requestId: "prompt-1",
            startTimeMs: 2_000,
            endTimeMs: 2_050,
            promptName: "release",
            remotePropagation: { traceparent: remoteParent },
            errorType: "-32602",
            rpcResponseStatusCode: "-32602",
        },
        {
            role: "client",
            direction: "outbound",
            method: "notifications/resources/updated",
            startTimeMs: 2_060,
            endTimeMs: 2_075,
            resourceUri: "fixture://item/1",
        },
    ]);
});

test("protocol journal is bounded, validates messages, and bounds opted-in sanitized payloads", () => {
    const journal = new ProtocolJournal({
        maxEntries: 2,
        maxPayloadCharacters: 80,
        captureContent: true,
    });
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

test("pending-map eviction completes an operation without a live span observer", () => {
    const operations: CompletedProtocolOperation[] = [];
    const journal = new ProtocolJournal({
        maxEntries: 1,
        onOperation: (operation) => operations.push(operation),
    });
    journal.recordMessage("outbound", {
        jsonrpc: "2.0",
        id: "oldest",
        method: "resources/list",
    });
    journal.recordMessage("outbound", {
        jsonrpc: "2.0",
        id: "newest",
        method: "tools/list",
    });
    assert.equal(operations.length, 1);
    assert.equal(operations[0]?.requestId, "oldest");
    assert.equal(operations[0]?.errorType, "pending_operation_evicted");
});

test("journaled transport transparently records SDK messages and close", async () => {
    const [inner, peer] = InMemoryTransport.createLinkedPair();
    const journal = new ProtocolJournal();
    const transport = new JournaledTransport(inner, journal, {
        correlation: () => ({ executionId: "execution-transport" }),
        propagation: () => ({
            traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            tracestate: "qyl=transport",
            baggage: "tenant=fixture",
        }),
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
        params: { _meta: { existing: "preserved" } },
    };
    await transport.send(request);
    const sent = await outbound;
    assert.deepEqual((sent as { params?: { _meta?: Record<string, unknown> } }).params?._meta, {
        existing: "preserved",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "qyl=transport",
        baggage: "tenant=fixture",
    });
    assert.deepEqual((request as { params?: { _meta?: Record<string, unknown> } }).params?._meta, {
        existing: "preserved",
    }, "caller-owned message is not mutated");

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

test("journaled transport preserves per-request stream cancellation", () => {
    const inner: Transport = {
        hasPerRequestStream: true,
        async start() {},
        async send() {},
        async close() {},
    };
    const transport = new JournaledTransport(inner, new ProtocolJournal());
    assert.equal(transport.hasPerRequestStream, true);
});

test("live operation starts before send and injects bounded metadata without mutating input", async () => {
    const events: string[] = [];
    const completed: CompletedProtocolOperation[] = [];
    let sent: JSONRPCMessage | undefined;
    const inner: Transport = {
        async start() {},
        async send(message) {
            events.push("wire");
            sent = structuredClone(message);
        },
        async close() {},
    };
    const journal = new ProtocolJournal({
        now: () => 50_000,
        onOperationStart: (operation) => {
            events.push(`start:${operation.method}`);
            return {
                startTimeMs: operation.startTimeMs,
                propagation: {
                    traceparent: "00-22222222222222222222222222222222-bbbbbbbbbbbbbbbb-01",
                    tracestate: "qyl=active",
                    baggage: "tenant=active",
                },
                run: (dispatch) => dispatch(),
                complete: (finished) => {
                    events.push(`complete:${finished.method}`);
                    completed.push(finished);
                },
            };
        },
    });
    const transport = new JournaledTransport(inner, journal, {
        propagation: () => ({
            traceparent: "00-11111111111111111111111111111111-aaaaaaaaaaaaaaaa-01",
        }),
    });
    transport.onmessage = () => {};
    await transport.start();
    const request: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: "live-request",
        method: "tools/call",
        params: {
            name: "probe",
            arguments: {},
            _meta: { existing: "preserved" },
        },
    };

    await transport.send(request);
    assert.deepEqual(events, ["start:tools/call", "wire"]);
    assert.deepEqual(
        (sent as { params?: { _meta?: Record<string, unknown> } }).params?._meta,
        {
            existing: "preserved",
            traceparent: "00-22222222222222222222222222222222-bbbbbbbbbbbbbbbb-01",
            tracestate: "qyl=active",
            baggage: "tenant=active",
        },
    );
    assert.deepEqual(
        (request as { params?: { _meta?: Record<string, unknown> } }).params?._meta,
        { existing: "preserved" },
    );

    inner.onmessage?.({ jsonrpc: "2.0", id: "live-request", result: {} });
    assert.deepEqual(events, ["start:tools/call", "wire", "complete:tools/call"]);
    assert.equal(completed.length, 1);
    await transport.close();
    assert.equal(completed.length, 1, "completed request is not ended again on close");
});

test("live inbound operation wraps dispatch and completes on response or handler failure", async () => {
    const events: string[] = [];
    const completed: CompletedProtocolOperation[] = [];
    let responseSend: Promise<void> | undefined;
    const inner: Transport = {
        async start() {},
        async send() {
            events.push("wire:response");
        },
        async close() {},
    };
    const journal = new ProtocolJournal({
        now: () => 60_000,
        onOperationStart: (operation) => {
            events.push(`start:${operation.method}`);
            return {
                startTimeMs: operation.startTimeMs,
                run: (dispatch) => {
                    events.push("run:enter");
                    try {
                        return dispatch();
                    } finally {
                        events.push("run:exit");
                    }
                },
                complete: (finished) => {
                    events.push(`complete:${finished.errorType ?? "ok"}`);
                    completed.push(finished);
                },
            };
        },
    });
    const transport = new JournaledTransport(inner, journal);
    transport.onmessage = (message) => {
        events.push("handler");
        if ("method" in message && message.method === "notifications/message") {
            throw new Error("handler failed");
        }
        if ("id" in message && "method" in message) {
            responseSend = transport.send({ jsonrpc: "2.0", id: message.id, result: {} });
        }
    };
    await transport.start();

    inner.onmessage?.({
        jsonrpc: "2.0",
        id: 61,
        method: "prompts/get",
        params: {
            name: "release",
            _meta: {
                traceparent: "00-33333333333333333333333333333333-cccccccccccccccc-01",
                tracestate: "qyl=inbound",
                baggage: "tenant=inbound",
            },
        },
    });
    await responseSend;
    assert.deepEqual(events, [
        "start:prompts/get",
        "run:enter",
        "handler",
        "wire:response",
        "run:exit",
        "complete:ok",
    ]);
    assert.deepEqual(completed[0]?.remotePropagation, {
        traceparent: "00-33333333333333333333333333333333-cccccccccccccccc-01",
        tracestate: "qyl=inbound",
        baggage: "tenant=inbound",
    });

    assert.throws(() => inner.onmessage?.({
        jsonrpc: "2.0",
        method: "notifications/message",
    }), /handler failed/u);
    assert.equal(completed.length, 2);
    assert.equal(completed[1]?.errorType, "transport_error");
    await transport.close();
    assert.equal(completed.length, 2);
});

test("live operations end exactly once on send failure, reused ids, and close", async () => {
    const completed = new Map<string, CompletedProtocolOperation[]>();
    const inner: Transport = {
        async start() {},
        async send(message) {
            if ("method" in message && message.method === "notifications/progress") {
                throw new Error("notification wire failed");
            }
        },
        async close() {},
    };
    const journal = new ProtocolJournal({
        now: () => 70_000,
        onOperationStart: (operation) => ({
            startTimeMs: operation.startTimeMs,
            run: (dispatch) => dispatch(),
            complete: (finished) => {
                const values = completed.get(finished.method) ?? [];
                values.push(finished);
                completed.set(finished.method, values);
            },
        }),
    });
    const transport = new JournaledTransport(inner, journal);
    await transport.start();

    await assert.rejects(
        transport.send({ jsonrpc: "2.0", method: "notifications/progress" }),
        /notification wire failed/u,
    );
    await transport.send({ jsonrpc: "2.0", id: "same-id", method: "resources/list" });
    await transport.send({ jsonrpc: "2.0", id: "same-id", method: "tools/list" });
    await transport.close();

    assert.deepEqual(
        completed.get("notifications/progress")?.map(({ errorType }) => errorType),
        ["transport_error"],
    );
    assert.deepEqual(
        completed.get("resources/list")?.map(({ errorType }) => errorType),
        ["request_id_reused"],
    );
    assert.deepEqual(
        completed.get("tools/list")?.map(({ errorType }) => errorType),
        ["connection_closed"],
    );
});

test("journaled transport completes a server response only after send succeeds", async () => {
    let now = 30_000;
    const operations: CompletedProtocolOperation[] = [];
    const requestCorrelation = { executionId: "server-request" };
    let currentCorrelation = requestCorrelation;
    const journal = new ProtocolJournal({
        now: () => now,
        onOperation: (operation) => operations.push(operation),
    });
    const inner: Transport = {
        async start() {},
        async send() {
            now = 30_025;
            assert.equal(operations.length, 0, "response is not complete while its send is pending");
            await Promise.resolve();
            assert.equal(operations.length, 0, "response is not complete before send resolves");
            now = 30_050;
        },
        async close() {},
    };
    const transport = new JournaledTransport(inner, journal, {
        correlation: () => currentCorrelation,
    });
    await transport.start();

    inner.onmessage?.({
        jsonrpc: "2.0",
        id: "prompt-response",
        method: "prompts/get",
        params: { name: "release" },
    });
    currentCorrelation = { executionId: "response-send" };
    await transport.send({
        jsonrpc: "2.0",
        id: "prompt-response",
        result: { description: "Release prompt", messages: [] },
    });

    assert.deepEqual(operations, [{
        role: "server",
        direction: "inbound",
        method: "prompts/get",
        requestId: "prompt-response",
        correlation: requestCorrelation,
        startTimeMs: 30_000,
        endTimeMs: 30_050,
        promptName: "release",
    }]);
    const responseEntry = journal.snapshot().find(
        (entry): entry is ProtocolMessageEntry => entry.kind === "message"
            && entry.messageKind === "response",
    );
    assert.equal(responseEntry?.timestampMs, 30_050);
    assert.equal(responseEntry?.durationMs, 50);
    assert.deepEqual(responseEntry?.correlation, requestCorrelation);
});

test("journaled transport completes a failed server response send exactly once", async () => {
    let now = 40_000;
    const operations: CompletedProtocolOperation[] = [];
    const requestCorrelation = { executionId: "failed-server-request" };
    const journal = new ProtocolJournal({
        now: () => now,
        onOperation: (operation) => operations.push(operation),
    });
    const inner: Transport = {
        async start() {},
        async send() {
            now = 40_075;
            assert.equal(operations.length, 0, "response is not complete before a failed send settles");
            throw new Error("response wire failed");
        },
        async close() {},
    };
    const transport = new JournaledTransport(inner, journal, {
        correlation: () => requestCorrelation,
    });
    await transport.start();

    inner.onmessage?.({
        jsonrpc: "2.0",
        id: 41,
        method: "tools/call",
        params: { name: "probe", arguments: {} },
    });
    await assert.rejects(
        transport.send({
            jsonrpc: "2.0",
            id: 41,
            result: {
                content: [{ type: "text", text: "tool-level failure" }],
                isError: true,
            },
        }),
        /response wire failed/u,
    );

    assert.deepEqual(operations, [{
        role: "server",
        direction: "inbound",
        method: "tools/call",
        requestId: 41,
        correlation: requestCorrelation,
        startTimeMs: 40_000,
        endTimeMs: 40_075,
        toolName: "probe",
        errorType: "transport_error",
    }]);
    const responseEntries = journal.snapshot().filter(
        (entry): entry is ProtocolMessageEntry => entry.kind === "message"
            && entry.messageKind === "response",
    );
    assert.equal(responseEntries.length, 1);
    assert.equal(responseEntries[0]?.durationMs, 75);
    assert.equal(journal.snapshot().filter((entry) => entry.kind === "transport_error").length, 1);
});

test("journaled transport records sanitized transport failures", async () => {
    let now = 10_000;
    const operations: CompletedProtocolOperation[] = [];
    const failingTransport: Transport = {
        async start() {},
        async send() {
            now += 25;
            throw new Error("Authorization: Bearer transport-secret");
        },
        async close() {},
    };
    const journal = new ProtocolJournal({
        now: () => now,
        onOperation: (operation) => operations.push(operation),
    });
    const transport = new JournaledTransport(failingTransport, journal);
    await transport.start();

    await assert.rejects(
        transport.send({ jsonrpc: "2.0", method: "notifications/probe" }),
        /transport-secret/u,
    );
    await assert.rejects(
        transport.send({ jsonrpc: "2.0", id: "failed-request", method: "resources/list" }),
        /transport-secret/u,
    );

    const errorEntry = journal.snapshot().find((entry) => entry.kind === "transport_error");
    assert(errorEntry?.kind === "transport_error");
    assert.equal(errorEntry.message.includes("transport-secret"), false);
    assert.match(errorEntry.message, /\[REDACTED\]/u);
    assert.deepEqual(operations, [
        {
            role: "client",
            direction: "outbound",
            method: "notifications/probe",
            startTimeMs: 10_000,
            endTimeMs: 10_025,
            errorType: "transport_error",
        },
        {
            role: "client",
            direction: "outbound",
            method: "resources/list",
            requestId: "failed-request",
            startTimeMs: 10_025,
            endTimeMs: 10_050,
            errorType: "transport_error",
        },
    ]);
});

test("journaled transport times notification send and receive acknowledgements", async () => {
    let now = 20_000;
    const operations: CompletedProtocolOperation[] = [];
    const [inner, peer] = InMemoryTransport.createLinkedPair();
    const journal = new ProtocolJournal({
        now: () => now,
        onOperation: (operation) => operations.push(operation),
    });
    const transport = new JournaledTransport(inner, journal);
    transport.onmessage = () => {
        now = 20_040;
    };
    peer.onmessage = () => {
        now = 20_090;
    };
    await Promise.all([transport.start(), peer.start()]);

    await peer.send({ jsonrpc: "2.0", method: "notifications/message" });
    now = 20_050;
    await transport.send({ jsonrpc: "2.0", method: "notifications/progress" });

    assert.deepEqual(operations, [
        {
            role: "server",
            direction: "inbound",
            method: "notifications/message",
            startTimeMs: 20_000,
            endTimeMs: 20_040,
        },
        {
            role: "client",
            direction: "outbound",
            method: "notifications/progress",
            startTimeMs: 20_050,
            endTimeMs: 20_090,
        },
    ]);

    await transport.close();
    await peer.close();
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
