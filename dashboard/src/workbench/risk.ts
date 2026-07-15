import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export type ToolRiskCategory = "read-only" | "mutating" | "destructive" | "open-world" | "unknown";

export interface ToolRiskDecision {
  category: ToolRiskCategory;
  label: string;
  tone: "neutral" | "info" | "warning" | "danger";
  requiresConfirmation: boolean;
  openWorld: boolean;
  idempotent: boolean;
  explanation: string;
}

export interface ToolConfirmationCopy {
  title: string;
  body: string;
  confirmLabel: string;
}

/**
 * Treats MCP annotations as untrusted hints. Missing hints never downgrade a
 * tool to read-only, and contradictory hints require confirmation.
 */
export function assessToolRisk(
  annotations?: ToolAnnotations | null,
): ToolRiskDecision {
  if (!annotations) {
    return {
      category: "unknown",
      label: "Unknown impact",
      tone: "warning",
      requiresConfirmation: true,
      openWorld: true,
      idempotent: false,
      explanation: "The server supplied no safety annotations. Treat this tool as consequential.",
    };
  }

  const openWorld = annotations.openWorldHint !== false;
  const idempotent = annotations.idempotentHint === true;

  if (annotations.readOnlyHint === true && annotations.destructiveHint === false && annotations.openWorldHint === false) {
    return {
      category: "read-only",
      label: "Explicitly read-only",
      tone: "info",
      requiresConfirmation: false,
      openWorld: false,
      idempotent,
      explanation: "The server explicitly reports read-only, non-destructive, closed-world behavior.",
    };
  }

  if (annotations.destructiveHint === true) {
    const conflict = annotations.readOnlyHint === true;
    return {
      category: "destructive",
      label: conflict ? "Conflicting · destructive" : "Potentially destructive",
      tone: "danger",
      requiresConfirmation: true,
      openWorld,
      idempotent,
      explanation: conflict
        ? "The server marked this tool both read-only and destructive. Treat the destructive hint as authoritative for confirmation."
        : "The server reports that this tool may perform destructive updates.",
    };
  }

  if (annotations.openWorldHint === true) {
    return {
      category: "open-world",
      label: "Open-world operation",
      tone: "warning",
      requiresConfirmation: true,
      openWorld: true,
      idempotent,
      explanation: "The server reports interaction with external systems. Review the exact data and target before continuing.",
    };
  }

  if (annotations.readOnlyHint === false) {
    return {
      category: "mutating",
      label: idempotent ? "Mutating · idempotent" : "Mutating",
      tone: "warning",
      requiresConfirmation: true,
      openWorld,
      idempotent,
      explanation: "The server does not report read-only behavior, so this operation may change state.",
    };
  }

  return {
    category: "unknown",
    label: "Incomplete safety hints",
    tone: "warning",
    requiresConfirmation: true,
    openWorld,
    idempotent,
    explanation: "The server did not explicitly guarantee read-only, non-destructive, closed-world behavior. Treat this tool as consequential.",
  };
}

export function confirmationCopyForTool(
  toolName: string,
  annotations?: ToolAnnotations | null,
): ToolConfirmationCopy {
  const risk = assessToolRisk(annotations);
  const quotedName = `“${toolName}”`;
  if (risk.category === "read-only") {
    return {
      title: `Review ${quotedName}`,
      body: `${risk.explanation} MCP annotations are hints, not a guarantee of behavior.`,
      confirmLabel: "Run tool",
    };
  }
  if (risk.category === "destructive") {
    return {
      title: `Confirm potentially destructive tool ${quotedName}`,
      body: `${risk.explanation} Review the exact arguments and target before continuing.`,
      confirmLabel: "Confirm and run",
    };
  }
  if (risk.category === "mutating") {
    return {
      title: `Confirm changes from ${quotedName}`,
      body: `${risk.explanation} Review the exact arguments before continuing.`,
      confirmLabel: "Confirm and run",
    };
  }
  if (risk.category === "open-world") {
    return {
      title: `Confirm external interaction from ${quotedName}`,
      body: `${risk.explanation} MCP annotations are hints, not a guarantee of behavior.`,
      confirmLabel: "Confirm and run",
    };
  }
  return {
    title: `Confirm tool ${quotedName}`,
    body: `${risk.explanation} Review the exact arguments and assume it may change external state.`,
    confirmLabel: "Confirm and run",
  };
}
