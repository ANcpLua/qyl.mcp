/**
 * Central policy for direct MCP exposure — qyl's answer to Sentry MCP's
 * tools/surfaces.ts. Tool modules define behavior; this file decides what is
 * exposed through tools/list and enforces the tool-slot budget IN CODE:
 * createServer() throws at construction when the registered surface drifts
 * from this policy, so a tools/list explosion cannot ship by accident.
 */

/** Catalog infrastructure: the two tools that reach everything else. */
export const CATALOG_INFRASTRUCTURE_TOOL_NAMES = [
  "search_qyl_tools",
  "execute_qyl_tool",
] as const;

/** Model-visible top-level tools — the entire curated tools/list surface. */
export const TOP_LEVEL_TOOL_NAMES = [
  "display_traces",
  "display_mcp_dashboard",
  ...CATALOG_INFRASTRUCTURE_TOOL_NAMES,
] as const;

/**
 * App-only tools: registered (viewer iframes call them) but hidden from the
 * model via `_meta.ui.visibility: ["app"]`; they occupy no model tool slot.
 */
export const APP_ONLY_TOOL_NAMES = ["fetch_telemetry"] as const;

/**
 * Hard budget for model-visible tools. Sentry caps at 25 with ~9 exposed;
 * qyl's whole point is a lean surface — 8 leaves room to grow (root-cause
 * tool, NL→query agent) without renegotiating the policy.
 */
export const MODEL_VISIBLE_TOOL_BUDGET = 8;

/**
 * Throws unless the registered model-visible surface is exactly the curated
 * top-level set and within budget. Called by createServer() after
 * registration — the budget is enforced by construction, not convention.
 */
export function assertToolSurface(modelVisibleToolNames: readonly string[]): void {
  if (modelVisibleToolNames.length > MODEL_VISIBLE_TOOL_BUDGET) {
    throw new Error(
      `Tool budget exceeded: ${modelVisibleToolNames.length} model-visible tools ` +
        `registered, budget is ${MODEL_VISIBLE_TOOL_BUDGET}. Move tools into the ` +
        `catalog (src/tools.ts) instead of exposing them top-level.`,
    );
  }
  const expected = [...TOP_LEVEL_TOOL_NAMES].sort();
  const actual = [...modelVisibleToolNames].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(
      `Registered model-visible tools [${actual.join(", ")}] do not match the ` +
        `curated top-level set in surfaces.ts [${expected.join(", ")}]. ` +
        `Update TOP_LEVEL_TOOL_NAMES deliberately or move the tool into the catalog.`,
    );
  }
}
