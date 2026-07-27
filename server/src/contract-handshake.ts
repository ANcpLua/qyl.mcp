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
 * An unreachable collector fails startup too. That is deliberate: a server that
 * boots without ever completing the handshake has the gate in name only, and the
 * live-mode server has nothing to serve without a collector anyway.
 */

import * as generatedContract from "@ancplua/qyl-api-schema/types";
import { collectorGet, resolveMode } from "./collector.js";
import { collectorUrl } from "./config.js";

// Read rather than imported: the pinned @ancplua/qyl-api-schema predates the
// revision export, and a named import would not compile against the pin — the
// handshake could not land at all until after the next publish. The absent case
// is handled once, in assertCollectorContractRevision.
const generated = generatedContract as unknown as { CONTRACT_REVISION?: unknown };

/** The contract revision this build's generated artifacts were emitted from. */
export function generatedContractRevision(): string | undefined {
  const revision = generated.CONTRACT_REVISION;
  return typeof revision === "string" && revision.length > 0 ? revision : undefined;
}

/** The revision a health body advertises, or a throw naming what was wrong. */
export function advertisedContractRevision(health: unknown): string {
  if (typeof health !== "object" || health === null || Array.isArray(health)) {
    throw new Error("collector health surface did not return an object");
  }
  const revision = (health as Record<string, unknown>).contract_revision;
  if (typeof revision !== "string" || revision.length === 0) {
    throw new Error(
      "collector health surface advertises no contract_revision: it serves a contract " +
        "older than the one this server was generated from",
    );
  }
  return revision;
}

export interface ContractRevisionCheck {
  /** Revision this server was generated from. */
  expected: string;
  /** Reads the collector's health surface. */
  fetchHealth: () => Promise<unknown>;
}

/** Fail-closed comparison, injectable so the gate is testable without a collector. */
export async function verifyContractRevision(check: ContractRevisionCheck): Promise<string> {
  const advertised = advertisedContractRevision(await check.fetchHealth());
  if (advertised !== check.expected) {
    throw new Error(
      `collector contract revision ${advertised} does not match this server's ${check.expected}: ` +
        "deploy the collector and qyl.mcp from the same contract revision",
    );
  }
  return advertised;
}

/**
 * Startup gate for both transports. Throws — and so aborts startup — unless the
 * collector serves the same contract revision this server was generated from.
 */
export async function assertCollectorContractRevision(): Promise<void> {
  // Demo mode never reaches a collector, so there is no peer to handshake with.
  // This is the same condition that decides whether a collector is used at all,
  // not a bypass for live deployments.
  if (await resolveMode() === "demo") return;

  const expected = generatedContractRevision();
  if (expected === undefined) {
    console.error(
      "contract-revision handshake inert: the pinned @ancplua/qyl-api-schema exports no " +
        "CONTRACT_REVISION, so this server cannot know its own revision. The gate activates " +
        "on the next @ancplua/qyl-api-schema publish and pin bump.",
    );
    return;
  }

  const advertised = await verifyContractRevision({
    expected,
    fetchHealth: () => collectorGet("/health"),
  });
  console.error(`contract revision ${advertised} matched at ${collectorUrl()}`);
}
