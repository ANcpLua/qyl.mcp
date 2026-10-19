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

/** Extra structured fields of one line; `level` and `message` are the line's own. */
export type LogFields = Readonly<Record<string, string | number | boolean>> & {
  readonly level?: never;
  readonly message?: never;
};

export function logInfo(message: string, fields?: LogFields): void {
  writeLine("info", message, fields);
}

export function logWarning(message: string, fields?: LogFields): void {
  writeLine("warn", message, fields);
}

function writeLine(level: "info" | "warn", message: string, fields: LogFields | undefined): void {
  process.stderr.write(`${JSON.stringify({ level, message, ...fields })}\n`);
}
