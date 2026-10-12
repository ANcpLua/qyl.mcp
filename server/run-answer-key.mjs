/** Reproducible, isolated OTLP -> Collector -> MCP answer key. No rebuilds. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, access, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { CONTRACT_REVISION } from "@ancplua/qyl-api-schema/types";

const repo = resolve(process.env.QYL_COLLECTOR_REPO ?? fileURLToPath(new URL("../../qyl", import.meta.url)));
const dll = process.env.QYL_COLLECTOR_DLL ?? join(repo, "artifacts/bin/qyl.collector/release/qyl.collector.dll");
await access(dll).catch(() => { throw new Error(`Build the collector once before this gate: ${dll}`); });
const temp = await mkdtemp(join(tmpdir(), "qyl-answer-key-"));
const log = await open(join(temp, "collector.log"), "w");
async function port() {
  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const value = socket.address().port; await new Promise(resolve => socket.close(resolve)); return value;
}
const apiPort = await port(), otlpPort = await port();
const base = `http://127.0.0.1:${apiPort}`, otlp = `http://127.0.0.1:${otlpPort}`;
const env = { ...process.env, DOTNET_PROCESSOR_COUNT: "4", ASPNETCORE_ENVIRONMENT: "Development",
  QYL_DATA_PATH: join(temp, "answer-key.duckdb"), QYL_PORT: String(apiPort), QYL_OTLP_PORT: String(otlpPort),
  QYL_GRPC_PORT: "0", QYL_OTLP_AUTH_MODE: "Unsecured", QYL_OTLP_PROJECT_KEYS: "", QYL_ANALYSIS_SIGNING_KEY: "answer-key-isolated-regression-secret",
  OTEL_SDK_DISABLED: "true" };
const collector = spawn("dotnet", [dll], { env, stdio: ["ignore", log.fd, log.fd] });
async function run(command, args, extra = {}) {
  const child = spawn(command, args, { env: { ...env, ...extra }, stdio: "inherit", cwd: fileURLToPath(new URL(".", import.meta.url)) });
  const [code] = await once(child, "exit"); assert.equal(code, 0, `${command} failed; evidence in ${temp}`);
}
let passed = false;
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (collector.exitCode !== null) throw new Error(`Collector exited; see ${temp}/collector.log`);
    const health = await fetch(`${base}/health`).then(r => r.ok ? r.json() : null).catch(() => null);
    if (health) { assert.equal(health.contract_revision, CONTRACT_REVISION); ready = true; break; }
    await delay(250);
  }
  assert(ready, `Collector startup timed out; see ${temp}/collector.log`);
  const fixture = join(temp, "answer-key.json");
  await run("python3", [join(repo, "tests/Qyl.Collector.Tests/Fixtures/seed-answer-key.py"), otlp, fixture]);
  await run(process.execPath, ["--test", "--test-concurrency=1", "verify-answer-key.mjs"], {
    QYL_ANSWER_KEY_FILE: fixture, QYL_ANSWER_KEY_COLLECTOR: base, QYL_ANSWER_KEY_OTLP: otlp,
  });
  passed = true;
} finally {
  collector.kill("SIGTERM");
  await Promise.race([once(collector, "exit"), delay(5000).then(() => { if (collector.exitCode === null) collector.kill("SIGKILL"); })]);
  await log.close();
  if (passed) await rm(temp, { recursive: true, force: true });
  else console.error(`Answer-key failure evidence retained: ${temp}`);
}
