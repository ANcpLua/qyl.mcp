import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { assessToolRisk } from "./risk.js";

export interface ToolRiskBadgeProps {
  annotations?: ToolAnnotations | null;
  className?: string;
}

export function ToolRiskBadge({ annotations, className }: ToolRiskBadgeProps) {
  const risk = assessToolRisk(annotations);
  return (
    <span
      className={className ?? `tool-risk-badge risk-${risk.category}`}
      data-risk={risk.category}
      data-tone={risk.tone}
      role="status"
      title={risk.explanation}
      aria-label={`${risk.label}. ${risk.explanation}`}
    >
      {risk.label}
    </span>
  );
}
