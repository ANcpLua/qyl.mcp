import type { RunnerMcpResourceContent } from "@ancplua/qyl-api-schema/types";

/** Decode the exact text-or-blob union emitted by the Qyl product contract. */
export function decodeMcpAppHtml(content: RunnerMcpResourceContent): string {
  if ("text" in content) return content.text;

  const bytes = Uint8Array.from(atob(content.blob), character => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
