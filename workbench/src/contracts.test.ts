import qylOpenApi from "@ancplua/qyl-api-schema/openapi" with { type: "json" };
import assert from "node:assert/strict";
import test from "node:test";

const HTTP_METHODS = new Set(["delete", "get", "patch", "post", "put"]);

test("every published workbench operation declares generated forbidden Problem Details", () => {
    const operations: Array<{ method: string; path: string; operation: unknown }> = [];

    for (const [path, pathItem] of Object.entries(qylOpenApi.paths)) {
        if (!path.startsWith("/workbench/")) continue;
        for (const [method, operation] of Object.entries(pathItem)) {
            if (HTTP_METHODS.has(method)) operations.push({ method, path, operation });
        }
    }

    assert.ok(operations.length > 0, "published Qyl OpenAPI contains no workbench operations");
    for (const { method, path, operation } of operations) {
        assert.equal(typeof operation, "object", `${method.toUpperCase()} ${path} is not an operation`);
        const forbidden = (operation as {
            responses?: Record<string, {
                content?: Record<string, { schema?: { $ref?: string } }>;
            }>;
        }).responses?.["403"];
        assert.equal(
            forbidden?.content?.["application/problem+json"]?.schema?.$ref,
            "#/components/schemas/Common.Errors.ForbiddenError",
            `${method.toUpperCase()} ${path} must declare generated 403 Problem Details`,
        );
    }
});
