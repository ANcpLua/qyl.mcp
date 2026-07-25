import assert from "node:assert/strict";
import test from "node:test";
import {
    SecretRedactor,
    isCredentialKey,
    validateEnvironmentVariableName,
} from "./secret-redactor.js";

test("secret redactor removes deep credential fields while preserving protocol counters", () => {
    const redactor = new SecretRedactor({
        environment: {
            MCP_API_KEY: "environment-secret",
            PATH: "/safe/bin",
            ORDINARY_VALUE: "ordinary-visible",
        },
        secretValues: ["manual-secret"],
    });

    const redacted = redactor.redact({
        apiKey: "object-secret",
        nested: {
            password: "short",
            headers: {
                Authorization: "Bearer header-secret",
                Cookie: "session=cookie-secret",
            },
            progressToken: "progress-17",
            inputTokens: 42,
        },
        diagnostics: [
            "authorization: Bearer inline-secret",
            "api_key=inline-api-secret; operation continued",
            "Bearer standalone-secret",
            "environment-secret manual-secret ordinary-visible /safe/bin",
        ],
        resourceUri: "/resource/item?token=relative-secret#fragment-secret",
    }) as Record<string, unknown>;

    const serialized = JSON.stringify(redacted);
    for (const secret of [
        "object-secret",
        "short",
        "header-secret",
        "cookie-secret",
        "inline-secret",
        "inline-api-secret",
        "standalone-secret",
        "environment-secret",
        "manual-secret",
        "relative-secret",
    ]) {
        assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
    }
    assert.match(serialized, /ordinary-visible/u);
    assert.match(serialized, /\/safe\/bin/u);

    const nested = redacted.nested as Record<string, unknown>;
    assert.equal(nested.progressToken, "progress-17");
    assert.equal(nested.inputTokens, 42);
    assert.equal(redacted.apiKey, "[REDACTED]");
});

test("secret redactor strips URI userinfo, query, and fragment in URI values and prose", () => {
    const redactor = new SecretRedactor();

    assert.equal(
        redactor.redactUri("https://user:password@example.test/mcp?api_key=query-secret#fragment-secret"),
        "https://example.test/mcp",
    );

    const text = redactor.redactText(
        "connect https://user:password@example.test/mcp?api_key=query-secret#fragment-secret now",
    );
    assert.equal(text, "connect https://example.test/mcp now");

    assert.equal(
        redactor.redactUri("//user:password@example.test/mcp?api_key=query-secret#fragment-secret"),
        "//example.test/mcp",
    );
    assert.equal(
        redactor.redactText("connect //user:password@example.test/mcp?secret=yes now"),
        "connect //example.test/mcp now",
    );
});

test("explicit short credential values are redacted without treating ambient short values as global secrets", () => {
    const redactor = new SecretRedactor({
        environment: { MCP_TOKEN: "xyz" },
        secretValues: ["abc"],
    });
    assert.equal(redactor.redactText("failure echoed abc"), "failure echoed [REDACTED]");
    assert.equal(redactor.redactText("ordinary xyz"), "ordinary xyz");
});

test("secret redactor accepts process-local credentials resolved after construction", () => {
    const redactor = new SecretRedactor();
    assert.equal(redactor.redactText("echo arbitrary-env-value"), "echo arbitrary-env-value");

    redactor.registerSecretValues(["arbitrary-env-value", "xy"]);

    assert.equal(redactor.redactText("echo arbitrary-env-value"), "echo [REDACTED]");
    assert.equal(redactor.redactText("short xy"), "short [REDACTED]");
});

test("secret redactor covers semantic attribute pairs and textual credential assignments", () => {
    const redactor = new SecretRedactor();

    assert.deepEqual(redactor.redact({
        attributes: [
            { key: "authorization", value: "Bearer arbitrary-value" },
            { name: "client_secret", value: { string_value: "nested-value" } },
            { header: "X-Api-Key", value: "header-value" },
            { key: "input_tokens", value: 42 },
        ],
    }), {
        attributes: [
            { key: "authorization", value: "[REDACTED]" },
            { name: "client_secret", value: "[REDACTED]" },
            { header: "X-Api-Key", value: "[REDACTED]" },
            { key: "input_tokens", value: 42 },
        ],
    });

    const text = redactor.redactText(
        "token=alpha password: 'bravo' {\"client_secret\":\"charlie\"} input_tokens=42",
    );
    assert.doesNotMatch(text, /alpha|bravo|charlie/u);
    assert.match(text, /input_tokens=42/u);
});

test("secret redactor bounds strings, cycles, and excessive nesting", () => {
    const redactor = new SecretRedactor({ maxDepth: 2, maxStringLength: 8 });
    const cyclic: { self?: unknown; nested: unknown; text: string } = {
        nested: { deeper: { value: true } },
        text: "1234567890",
    };
    cyclic.self = cyclic;

    assert.deepEqual(redactor.redact(cyclic), {
        nested: { deeper: "[MAX_DEPTH]" },
        text: "1234567…",
        self: "[CIRCULAR]",
    });
});

test("credential key and environment-name classification is conservative", () => {
    assert.equal(isCredentialKey("MCP_TOKEN"), true);
    assert.equal(isCredentialKey("client-secret"), true);
    assert.equal(isCredentialKey("progressToken"), false);
    assert.equal(isCredentialKey("output_tokens"), false);
    assert.equal(isCredentialKey("monkey"), false);

    assert.doesNotThrow(() => validateEnvironmentVariableName("MCP_API_KEY_2"));
    assert.throws(
        () => validateEnvironmentVariableName("MCP-API-KEY"),
        /Invalid environment variable name/u,
    );
});
