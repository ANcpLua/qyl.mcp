import type { CallToolResult } from "@modelcontextprotocol/server";
import { readCollectorProjects } from "./collector-access.js";
import { isCredentialKey, SecretRedactor } from "./secret-redactor.js";

// The standalone server and the runner share this implementation through the
// server package export. Keep one process-local instance so configured secret
// values remain available for every result path without ever being serialized.
const redactor = new SecretRedactor({ environment: process.env });

function registerCurrentEnvironmentSecrets(): void {
  redactor.registerSecretValues(
    Object.entries(process.env)
      .filter(([name, value]) => value !== undefined && isCredentialKey(name))
      .map(([, value]) => value as string),
  );
  // Project credentials live inside JSON rather than individual *_KEY variables.
  // Invalid configuration is rejected at startup/request authorization; reporting
  // that failure must not itself throw from the final redaction guard.
  try {
    const projects = readCollectorProjects();
    if (projects !== undefined) {
      redactor.registerSecretValues([...projects.values()].map((access) => access.apiKey));
    }
  } catch {
    // Keep existing secret registrations when the host configuration is invalid.
  }
}

/** Redact already-validated telemetry while preserving its published shape. */
export function redactTelemetry<T>(value: T): T {
  registerCurrentEnvironmentSecrets();
  return redactor.redact(value) as T;
}

export function redactTelemetryText(value: string): string {
  registerCurrentEnvironmentSecrets();
  return redactor.redactText(value);
}

/** Final MCP result guard for both model text and structured telemetry. */
export function telemetryToolResult<T extends object>(
  text: string,
  output: T,
): CallToolResult {
  const safeOutput = redactTelemetry(output);
  return {
    content: [{ type: "text", text: redactTelemetryText(text) }],
    structuredContent: safeOutput as unknown as Record<string, unknown>,
  };
}
