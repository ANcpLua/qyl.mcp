import {
  closeDefaultNativeExecutionRuntime,
  createServer,
} from "qyl-mcp-server";
import { WorkbenchHost } from "./src/workbench-host.js";

const workbenchHost = new WorkbenchHost([{
  name: "qyl-telemetry",
  serverFactory: () => createServer({ transport: "inproc" }),
}]);

try {
  await workbenchHost.listen();
  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.error(`${signal} received — stopping workbench`);
      void workbenchHost.close().then(resolve);
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });
} finally {
  await closeDefaultNativeExecutionRuntime();
}
