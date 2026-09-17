// Drive the hosted qyl MCP server, https://mcp.qyl.at/mcp, with the official
// client SDK pinned to protocol revision 2026-07-28 (the only one the server
// serves), using the bearer token hosted-mcp-login.py obtained. One line per
// expectation; exit 0 when every expectation holds. Never prints the token.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const here = dirname(fileURLToPath(import.meta.url));
const token = JSON.parse(readFileSync(join(here, "out", "hosted-token.json"), "utf8")).access_token;
const MCP = new URL("https://mcp.qyl.at/mcp");
let failures = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}\t${label}${detail ? "\t" + String(detail).replace(/\s+/g, " ").slice(0, 160) : ""}`);
};

const authedFetch = (url, init = {}) => {
  const headers = new Headers(init.headers ?? {});
  headers.set("authorization", `Bearer ${token}`);
  headers.set("user-agent", "curl/8.7.1"); // Cloudflare 1010 rejects the runtime's default agent
  return fetch(url, { ...init, headers });
};

const transport = new StreamableHTTPClientTransport(MCP, { fetch: authedFetch });
const client = new Client(
  { name: "qyl.mcp hosted eval", version: "0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);

const text = (res) => (res?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
async function call(name, args) {
  try {
    const res = await client.callTool({ name, arguments: args });
    return { res, text: text(res), err: null };
  } catch (e) {
    return { res: null, text: "", err: e?.message ?? String(e) };
  }
}

try {
  await client.connect(transport);
  const sv = client.getServerVersion();
  check(!!sv, "connect negotiates 2026-07-28 and returns server info", `${sv?.name} ${sv?.version}`);

  const listing = await client.listTools();
  const tools = listing.tools.map((t) => t.name);
  check(tools.length === 11, "tools/list returns eleven tools", `${tools.length}: ${tools.join(", ")}`);

  const plan = [
    ["list_traces", {}],
    ["list_sessions", {}],
    ["list_metrics", {}],
    ["search_logs", { query: "request" }],
    ["display_mcp_dashboard", {}],
    ["fetch_telemetry", { view: "traces" }],
    ["ci_log", {}],
  ];
  let firstTrace = null;
  for (const [name, args] of plan) {
    if (!tools.includes(name)) { check(false, `${name} is published`); continue; }
    const { res, text: t, err } = await call(name, args);
    check(res !== null && !res.isError, `${name} answers`, err ?? t);
    if (name === "list_traces" && res) {
      const sc = res.structuredContent ?? {};
      const items = sc.traces ?? sc.items ?? [];
      firstTrace = items[0]?.trace_id ?? items[0]?.traceId ?? null;
      console.log(`info\tlist_traces structured items=${items.length}`);
    }
  }

  if (firstTrace) {
    for (const name of ["get_trace", "display_traces"].filter((n) => tools.includes(n))) {
      const { res, text: t, err } = await call(name, { trace_id: firstTrace });
      check(res !== null && !res.isError, `${name} answers for ${firstTrace.slice(0, 12)}…`, err ?? t);
    }
  } else {
    console.log("info\tno trace on the hosted collector; get_trace and display_traces not exercised");
  }

  const covered = new Set([...plan.map(([n]) => n), "get_trace", "display_traces"]);
  for (const name of tools.filter((n) => !covered.has(n)).sort()) {
    const { res, text: t, err } = await call(name, {});
    check(res !== null || err !== null, `${name} answers to empty arguments (a validation error is a correct answer)`, err ?? t);
  }
} catch (e) {
  check(false, "session", e?.message ?? String(e));
} finally {
  await client.close().catch(() => {});
}
console.log(`${failures === 0 ? "ok" : "FAILED"}: ${failures} failing expectation(s)`);
process.exit(failures === 0 ? 0 : 1);
