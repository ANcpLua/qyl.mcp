import type { WorkbenchServerConfiguration as ServerConfiguration } from "@ancplua/qyl-api-schema/types";

export interface ConnectionSafetyReview {
  title: string;
  body: string;
  acknowledgement: string;
}

export function normalizeRemoteEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value.trim());
  } catch {
    throw new Error("The MCP endpoint must be an absolute HTTP or HTTPS URL.");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("The MCP endpoint must use HTTP or HTTPS.");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("Put credentials in environment-backed header references, not in the endpoint URL.");
  }
  endpoint.hash = "";
  return endpoint.href;
}

export function connectionSafetyReview(configuration: ServerConfiguration): ConnectionSafetyReview | null {
  if (configuration.transport === "stdio") {
    const command = [configuration.command, ...(configuration.arguments ?? [])].join(" ");
    const workingDirectory = configuration.working_directory
      ? ` in ${configuration.working_directory}`
      : "";
    return {
      title: "Start a local MCP process?",
      body: `Connecting will execute “${command}”${workingDirectory} with the current user’s permissions. Secret values are resolved only by the runner from the listed environment references.`,
      acknowledgement: "I reviewed the exact command, arguments, working directory, and environment references.",
    };
  }
  return null;
}
