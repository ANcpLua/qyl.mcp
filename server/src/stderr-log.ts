/**
 * Informational logging for a process whose stdout belongs to JSON-RPC.
 *
 * On the stdio transport every log line must go to stderr — writing to stdout
 * corrupts the protocol stream. But log collectors (Railway among them) derive
 * severity from the stream when a line is plain text, so an informational
 * message on stderr surfaces as an error. Emitting structured JSON with an
 * explicit level keeps the stream stdio-safe while letting the collector read
 * the severity from the line instead of inferring it from the file descriptor.
 *
 * Genuine errors keep using console.error with plain text: for those the
 * stream-derived severity is the correct one.
 */
export function logInfo(message: string): void {
  process.stderr.write(`${JSON.stringify({ level: "info", message })}\n`);
}
