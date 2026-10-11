import { createHash } from "node:crypto";
import { CLIENT_INFO_META_KEY, type ServerContext } from "@modelcontextprotocol/server";

export type UiDomain = string | ((context: ServerContext) => string | undefined);

/** Client hints select presentation metadata only, never credentials or access. */
export function hostedUiDomain(publicMcpUrl: string): (context: ServerContext) => string | undefined {
  const origin = new URL(publicMcpUrl).origin;
  // Hash the exact configured connector URL, including its path and trailing slash.
  const claudeDomain = `${createHash("sha256").update(publicMcpUrl).digest("hex").slice(0, 32)}.claudemcpcontent.com`;

  const domainForHint = (hint: string): string | undefined => {
    if (/^(?:claude(?:ai)?(?:[-\s_./]|$)|anthropic\/claude(?:ai)?(?:[-\s_./]|$))/iu.test(hint)) {
      return claudeDomain;
    }
    if (/^(?:chatgpt|openai-mcp)(?:[-\s_./]|$)/iu.test(hint)) return origin;
    return undefined;
  };

  return (context) => {
    const envelope = context.mcpReq.envelope;
    const clientInfo = envelope && CLIENT_INFO_META_KEY in envelope
      ? envelope[CLIENT_INFO_META_KEY]
      : undefined;
    const clientName = typeof clientInfo === "object" && clientInfo !== null
      && "name" in clientInfo && typeof clientInfo.name === "string"
      ? clientInfo.name
      : undefined;
    // Check both hints, but a recognized SDK name wins if they disagree.
    // Unknown names and stateless legacy HTTP can still use the User-Agent.
    const nameDomain = domainForHint(clientName ?? "");
    const userAgentDomain = domainForHint(context.http?.req?.headers.get("user-agent") ?? "");
    return nameDomain ?? userAgentDomain;
  };
}
