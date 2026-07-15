import { startFixtureHttpServer } from "../dist/src/fixture-http.js";

const bearerToken = process.env.QYL_MCP_FIXTURE_BEARER;
if (!bearerToken) {
  console.error("QYL_MCP_FIXTURE_BEARER must contain the fixture bearer credential");
  process.exit(1);
}

const configuredPort = process.env.QYL_MCP_FIXTURE_PORT ?? "3334";
const port = Number(configuredPort);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error("QYL_MCP_FIXTURE_PORT must be an integer from 0 through 65535");
  process.exit(1);
}

const running = await startFixtureHttpServer({ bearerToken, port });
console.error(`qyl.mcp conformance fixture listening at ${running.streamableUrl}`);
console.error(`legacy SSE compatibility endpoint at ${running.sseUrl}`);

let stopping = false;
async function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  await running.close();
}

process.once("SIGINT", () => {
  void stop().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void stop().finally(() => process.exit(0));
});
