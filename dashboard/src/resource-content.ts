/**
 * MCP App HTML used to be decoded and executed through a nested iframe here.
 * The workbench intentionally rejects that production path: returned content
 * is rendered by fixed, non-interpreting React components instead.
 */
export function decodeMcpAppHtml(): never {
  throw new Error("Executable MCP App HTML is disabled in qyl.mcp.");
}
