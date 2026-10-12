/** CI evidence is computed by the Collector from recorded pipeline tasks. */
import type { McpServer } from "@modelcontextprotocol/server";
import { compactOutputSchema, contractSchema } from "./contract-validation.js";
import { queryAnalysis } from "./analysis-client.js";
import { runTool } from "./request-scope.js";
import { READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS, TELEMETRY_TOOL_AUTH_META } from "./tools.js";
/** Query all matching CI telemetry before pagination. */
export function registerCiTools(server: McpServer): void {
  server.registerTool(
    "ci_log",
    {
      title: "CI Log",
      description: "List or compare CI runs and phase failures when investigating a build or test regression.",
      inputSchema: contractSchema("Mcp.Tools.CiLogInput"),
      outputSchema: compactOutputSchema(contractSchema("Mcp.Tools.CiLogOutput")),
      annotations: READ_ONLY_TELEMETRY_TOOL_ANNOTATIONS,
      _meta: TELEMETRY_TOOL_AUTH_META,
    },
    (args, ctx) => runTool(ctx, 1, async (scope) =>
      queryAnalysis("ci_log", args, contractSchema("Mcp.Tools.CiLogOutput"), scope)),
  );
}
