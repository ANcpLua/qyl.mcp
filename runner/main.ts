import {
  closeDefaultNativeExecutionRuntime,
  createServer,
} from "qyl-mcp-server";
import { RunnerApi } from "./src/runner-api.js";

const api = new RunnerApi([{
  name: "qyl-telemetry",
  serverFactory: () => createServer({ transport: "inproc" }),
}]);

try {
  await api.listen();
  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.error(`${signal} received — stopping runner`);
      void api.close().then(resolve);
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });
} finally {
  await closeDefaultNativeExecutionRuntime();
}
