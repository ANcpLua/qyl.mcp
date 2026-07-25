import { once } from "node:events";
import { startFixtureStdioServer } from "../dist/src/fixture-stdio.js";

const marker = "QYL_CHATTY_STDERR_MUST_NOT_PERSIST";
const chunk = `${marker}:${"x".repeat(16 * 1024)}\n`;
let written = 0;
while (written < 4 * 1024 * 1024) {
  written += Buffer.byteLength(chunk);
  if (!process.stderr.write(chunk)) await once(process.stderr, "drain");
}

const running = await startFixtureStdioServer();
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  await running.close();
}

process.once("SIGINT", () => {
  void stop().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void stop().finally(() => process.exit(0));
});
