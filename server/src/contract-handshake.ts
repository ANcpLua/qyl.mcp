/**
 * Startup contract-revision handshake (architecture gate G10c).
 *
 * The collector advertises the revision of the API contract it serves on its
 * health surface; this server compares it to the revision baked into the
 * generated artifacts it was built from and refuses to run on a mismatch. It is
 * the SelfExportGuard pattern applied to the contract axis: lockstep deploys are
 * the honest cost of one contract, and for a solo-operated Railway pair that
 * cost is near zero.
 *
 * What the gate proves is skew, and skew needs evidence: a revision the
 * collector actually advertised. An unreachable collector proves nothing, so it
 * is handled by transport rather than misreported as a mismatch:
 *
 * - hosted HTTP refuses to start after a bounded in-process retry (which covers
 *   private-network DNS warm-up) — a booted mcp.qyl.at must mean a completed
 *   handshake, and the platform restart loop is the outer retry;
 * - stdio starts degraded with a structured warning — a local install without a
 *   running collector is a normal state, and every tool call already surfaces
 *   an actionable collector error until one appears.
 *
 * A reachable collector whose 200 health body carries no contract_revision
 * serves a contract older than this server's: that is evidence of skew and
 * stays fatal on both transports, as does a differing revision.
 */

import { CONTRACT_REVISION } from "@ancplua/qyl-api-schema/types";
import { resolveMode } from "./collector.js";
import { collectorHeaders, collectorUrl } from "./config.js";
import { logInfo, logWarning } from "./stderr-log.js";

/** The contract revision this build's generated artifacts were emitted from. */
export function generatedContractRevision(): string {
  if (typeof CONTRACT_REVISION !== "string" || !/^sha256:[a-f0-9]{16}$/u.test(CONTRACT_REVISION)) {
    throw new Error(
      "this build carries a malformed CONTRACT_REVISION from @ancplua/qyl-api-schema; " +
        "the generated artifacts are broken and the G10c gate cannot run",
    );
  }
  return CONTRACT_REVISION;
}

export type HealthProbeResult =
  | { kind: "advertised"; healthy: boolean; revision: string }
  | { kind: "pre-revision"; detail: string }
  | { kind: "unreachable"; detail: string };

/**
 * Read the one field the handshake needs from whatever the collector serves.
 *
 * Deliberately lenient where the rest of this server validates with the
 * generated contract: the probe must read health bodies emitted by ANY contract
 * revision — older and newer than this build's — because diagnosing skew is its
 * whole purpose, and a validator generated from this build's revision cannot
 * accept a body from the revision it is trying to detect. An unhealthy
 * collector still advertises its revision (the health writer always includes
 * it), so a 503 body with a revision is compared like a 200.
 */
export async function probeCollectorHealth(): Promise<HealthProbeResult> {
  const url = new URL("/health", collectorUrl());
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", ...collectorHeaders() },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    return { kind: "unreachable", detail: describeNetworkFailure(error) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return response.ok
      ? { kind: "pre-revision", detail: "the 200 health body is not JSON" }
      : { kind: "unreachable", detail: `health returned ${response.status} with a non-JSON body` };
  }

  const revision =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).contract_revision
      : undefined;
  if (typeof revision === "string" && revision.length > 0) {
    return { kind: "advertised", healthy: response.ok, revision };
  }
  return response.ok
    ? { kind: "pre-revision", detail: `the ${response.status} health body carries no contract_revision` }
    : { kind: "unreachable", detail: `health returned ${response.status} without a contract_revision` };
}

function describeNetworkFailure(error: unknown): string {
  if (!(error instanceof Error)) return "unknown network failure";
  if (error.cause instanceof Error && error.cause.message) return error.cause.message;
  return error.message || error.name;
}

export interface HandshakeOptions {
  /** Revision this server was generated from; defaults to the build's own. */
  expected?: string;
  /** Defaults to the invocation mode main() derives from the same argv. */
  transport?: "stdio" | "http";
  probe?: () => Promise<HealthProbeResult>;
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Startup gate for both transports. Throws — and so aborts startup — on
 * evidence of contract skew; an unreachable collector aborts the hosted HTTP
 * transport after retries and degrades stdio with a structured warning.
 */
export async function assertCollectorContractRevision(
  options: HandshakeOptions = {},
): Promise<void> {
  // Demo mode never reaches a collector, so there is no peer to handshake with.
  // This is the same condition that decides whether a collector is used at all,
  // not a bypass for live deployments.
  if (await resolveMode() === "demo") return;

  const expected = options.expected ?? generatedContractRevision();
  const transport = options.transport ?? (process.argv.includes("--stdio") ? "stdio" : "http");
  const probe = options.probe ?? probeCollectorHealth;
  const attempts = options.attempts ?? (transport === "http" ? 4 : 1);
  const delayMs = options.delayMs ?? 1_500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastDetail = "collector never probed";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await probe();
    if (result.kind === "advertised") {
      if (result.revision !== expected) {
        fail(
          `collector contract revision ${result.revision} does not match this server's ` +
            `${expected}: deploy the collector and qyl.mcp from the same contract revision`,
        );
      }
      if (!result.healthy) {
        logWarning(
          `collector at ${collectorUrl()} is unhealthy but advertises the matching ` +
            "contract revision; proceeding",
        );
      }
      logInfo(`contract revision ${result.revision} matched at ${collectorUrl()}`);
      return;
    }
    if (result.kind === "pre-revision") {
      fail(
        `collector health surface advertises no contract_revision (${result.detail}): it ` +
          "serves a contract older than the one this server was generated from",
      );
    }
    lastDetail = result.detail;
    if (attempt < attempts) await sleep(delayMs);
  }

  if (transport === "stdio") {
    logWarning(
      `contract revision unverified: collector unreachable at ${collectorUrl()} ` +
        `(${lastDetail}); tools will return actionable collector errors until it is reachable`,
    );
    return;
  }
  fail(
    `collector unreachable at ${collectorUrl()} after ${attempts} attempts (${lastDetail}): ` +
      "refusing to serve the hosted transport without a completed contract-revision handshake",
  );
}

// The handshake's diagnostics are its entire value — which side drifted, which
// revision each side carries — and contain no secrets by construction, so they
// go to stderr in full before the throw that main()'s sanitized reporter sees.
function fail(message: string): never {
  console.error(`contract-revision handshake failed: ${message}`);
  throw new Error(message);
}
