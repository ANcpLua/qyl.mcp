import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

// This repository owns only the qyl-mcp service. The qyl-collector service and
// its volume are owned by ANcpLua/qyl, so each repo manages a named partial of
// the shared "qyl" project instead of one whole-project file.
export const partial = "qyl-mcp";

export default defineRailway(() => {
  // MCP Events subscriptions must survive restarts and redeploys (ChatGPT MCP
  // Events); the store is one small JSON file.
  const dataVolume = volume("qyl-mcp-volume", {
    region: "europe-west4-drams3a",
    sizeMB: 1000,
    allowOnlineResize: true,
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
  });

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
    volumeMounts: { "/data": dataVolume },
    // Values stay in Railway; the file only declares which variables exist.
    env: {
      MCP_ALLOWED_HOSTS: preserve(),
      MCP_ALLOWED_ORIGIN_HOSTS: preserve(),
      MCP_AUTH_EXTENSIONS: preserve(),
      MCP_BIND_HOST: preserve(),
      // Not a secret, and tied to the mount above, so the value lives here.
      MCP_EVENTS_STORE: "/data/mcp-events.json",
      MCP_PUBLIC_URL: preserve(),
      NODE_ENV: preserve(),
      // The OpenAI plugin portal's domain-verification token, set when the portal shows it.
      OPENAI_APPS_CHALLENGE: preserve(),
      QYL_API_KEY: preserve(),
      QYL_COLLECTOR_URL: preserve(),
    },
  });

  return project("qyl", { resources: [mcp] });
});
