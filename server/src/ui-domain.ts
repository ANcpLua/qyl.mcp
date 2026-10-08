import { createHash } from "node:crypto";
import { CLIENT_INFO_META_KEY, type ServerContext } from "@modelcontextprotocol/server";

export type UiDomain = string | ((context: ServerContext) => string);

/** Client hints select presentation metadata only, never credentials or access. */
export function hostedUiDomain(publicMcpUrl: string): (context: ServerContext) => string {
  const origin = new URL(publicMcpUrl).origin;
  // Hash the exact configured connector URL, including its path and trailing slash.
  const claudeDomain = `${createHash("sha256").update(publicMcpUrl).digest("hex").slice(0, 32)}.claudemcpcontent.com`;

  return (context) => {
    const envelope = context.mcpReq.envelope;
    const clientInfo = envelope && CLIENT_INFO_META_KEY in envelope
      ? envelope[CLIENT_INFO_META_KEY]
      : undefined;
    const clientName = typeof clientInfo === "object" && clientInfo !== null
      && "name" in clientInfo && typeof clientInfo.name === "string"
      ? clientInfo.name
      : undefined;
    // Stateless legacy HTTP has no retained initialize.clientInfo. Claude's
    // per-request User-Agent is a fallback only when SDK clientInfo is absent.
    const isClaude = clientName === undefined
      ? /^Claude-User(?:[\s/]|$)/iu.test(context.http?.req?.headers.get("user-agent") ?? "")
      : /^(?:claude(?:ai)?(?:[-\s_./]|$)|anthropic\/claude(?:ai)?(?:[-\s_./]|$))/iu.test(clientName);
    return isClaude ? claudeDomain : origin;
  };
}
