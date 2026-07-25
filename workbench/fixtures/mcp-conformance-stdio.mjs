import { startFixtureStdioServer } from "../dist/src/fixture-stdio.js";

const running = await startFixtureStdioServer();
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
