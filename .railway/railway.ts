import { defineRailway, github, preserve, project, service } from "railway/iac";

// This repository owns only the qyl-mcp service. The qyl-collector service and
// its volume are owned by ANcpLua/qyl, so each repo manages a named partial of
// the shared "qyl" project instead of one whole-project file.
export const partial = "qyl-mcp";

export default defineRailway(() => {
  const mcp = service("qyl-mcp", {
    source: github("ANcpLua/qyl.mcp", { checkSuites: true }),
    build: {
      builder: "RAILPACK",
      buildCommand: "bun run --cwd server build",
    },
    deploy: {
      startCommand: "bun server/dist/main.js",
      healthcheckPath: "/healthz",
      healthcheckTimeout: 30,
    },
    replicas: { "europe-west4-drams3a": 1 },
    domains: ["mcp.qyl.at"],
    // Values stay in Railway; the file only declares which variables exist.
    env: {
      MCP_ALLOWED_HOSTS: preserve(),
      MCP_ALLOWED_ORIGIN_HOSTS: preserve(),
      MCP_BIND_HOST: preserve(),
      MCP_OAUTH_ISSUER: preserve(),
      MCP_PUBLIC_URL: preserve(),
      NODE_ENV: preserve(),
      QYL_API_KEY: preserve(),
      QYL_COLLECTOR_URL: preserve(),
    },
  });

  return project("qyl", { resources: [mcp] });
});
