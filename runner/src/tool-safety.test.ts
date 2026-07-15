import assert from "node:assert/strict";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { classifyToolSafety } from "./tool-safety.js";

function fixtureTool(annotations?: Tool["annotations"]): Tool {
    const tool: Tool = {
        name: "probe",
        inputSchema: { type: "object" },
    };
    if (annotations !== undefined) tool.annotations = annotations;
    return tool;
}

test("only an explicitly read-only, non-destructive, closed-world tool skips confirmation", () => {
    assert.deepEqual(
        classifyToolSafety(fixtureTool({
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
        })),
        {
            classification: "explicitly_read_only",
            requiresConfirmation: false,
            reasons: [],
        },
    );
});

test("unknown and incomplete tool annotations require confirmation", () => {
    assert.deepEqual(classifyToolSafety(fixtureTool()), {
        classification: "unknown",
        requiresConfirmation: true,
        reasons: ["missing_annotations"],
    });

    assert.deepEqual(
        classifyToolSafety(fixtureTool({ readOnlyHint: true })),
        {
            classification: "unknown",
            requiresConfirmation: true,
            reasons: [
                "destructive_not_explicitly_false",
                "open_world_not_explicitly_false",
            ],
        },
    );
});

test("mutating, destructive, and open-world declarations require confirmation", () => {
    const cases: readonly [Tool["annotations"], string][] = [
        [
            { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
            "mutating",
        ],
        [
            { readOnlyHint: true, destructiveHint: true, openWorldHint: false },
            "destructive",
        ],
        [
            { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
            "open_world",
        ],
    ];

    for (const [annotations, classification] of cases) {
        const decision = classifyToolSafety(fixtureTool(annotations));
        assert.equal(decision.classification, classification);
        assert.equal(decision.requiresConfirmation, true);
    }
});
