import type { Tool } from "@modelcontextprotocol/server";

export type ToolSafetyClassification =
    | "explicitly_read_only"
    | "unknown"
    | "mutating"
    | "destructive"
    | "open_world";

export type ToolConfirmationReason =
    | "missing_annotations"
    | "not_explicitly_read_only"
    | "destructive_not_explicitly_false"
    | "destructive"
    | "open_world_not_explicitly_false"
    | "open_world";

export interface ToolSafetyDecision {
    classification: ToolSafetyClassification;
    requiresConfirmation: boolean;
    reasons: readonly ToolConfirmationReason[];
}

/**
 * Treat MCP annotations as untrusted hints. A call avoids confirmation only
 * when the server explicitly declares all three conservative conditions:
 * read-only, non-destructive, and closed-world.
 */
export function classifyToolSafety(tool: Tool): ToolSafetyDecision {
    const annotations = tool.annotations;
    if (annotations === undefined) {
        return {
            classification: "unknown",
            requiresConfirmation: true,
            reasons: ["missing_annotations"],
        };
    }

    const reasons: ToolConfirmationReason[] = [];
    if (annotations.readOnlyHint !== true) reasons.push("not_explicitly_read_only");
    if (annotations.destructiveHint === true) {
        reasons.push("destructive");
    } else if (annotations.destructiveHint !== false) {
        reasons.push("destructive_not_explicitly_false");
    }
    if (annotations.openWorldHint === true) {
        reasons.push("open_world");
    } else if (annotations.openWorldHint !== false) {
        reasons.push("open_world_not_explicitly_false");
    }

    if (reasons.length === 0) {
        return {
            classification: "explicitly_read_only",
            requiresConfirmation: false,
            reasons,
        };
    }

    const classification: ToolSafetyClassification = annotations.destructiveHint === true
        ? "destructive"
        : annotations.openWorldHint === true
          ? "open_world"
          : annotations.readOnlyHint === false
            ? "mutating"
            : "unknown";

    return { classification, requiresConfirmation: true, reasons };
}
