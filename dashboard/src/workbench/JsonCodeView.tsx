import { useState, type ReactNode } from "react";
import { formatJson, type JsonSchema } from "./schema.js";

// Props are widened to `| undefined` rather than left bare-optional: under
// exactOptionalPropertyTypes a caller passing an explicitly-undefined prop is a
// different type from one omitting it, and for React props both are the same
// thing. Types that cross the wire are handled the opposite way — see the
// callers of @ancplua/qyl-api-schema, which omit rather than pass undefined.
export interface JsonCodeViewProps {
  value: unknown;
  label?: string | undefined;
  className?: string | undefined;
  copyLabel?: string | undefined;
  onCopy?: ((formattedJson: string) => void | Promise<void>) | undefined;
}

function highlightedJson(formatted: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const pattern = /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b/gu;
  let previousEnd = 0;
  let tokenIndex = 0;
  for (const match of formatted.matchAll(pattern)) {
    const index = match.index;
    if (index > previousEnd) tokens.push(formatted.slice(previousEnd, index));
    const kind = match[1] !== undefined
      ? "key"
      : match[2] !== undefined
        ? "string"
        : match[3] !== undefined
          ? "number"
          : match[4] !== undefined
            ? "boolean"
            : "null";
    tokens.push(<span className={`json-token-${kind}`} key={tokenIndex++}>{match[0]}</span>);
    previousEnd = index + match[0].length;
  }
  if (previousEnd < formatted.length) tokens.push(formatted.slice(previousEnd));
  return tokens;
}

/**
 * A deliberately non-interpreting JSON view. React renders the formatted value
 * as a text node, so HTML and scripts in server data cannot become markup.
 */
export function JsonCodeView({
  value,
  label = "JSON",
  className,
  copyLabel = "Copy JSON",
  onCopy,
}: JsonCodeViewProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const formatted = formatJson(value);

  return (
    <section className={className ?? "json-code-view"} aria-label={label}>
      <header>
        <span>{label}</span>
        {onCopy ? (
          <button
            type="button"
            onClick={() => {
              setCopyState("idle");
              Promise.resolve(onCopy(formatted)).then(
                () => setCopyState("copied"),
                () => setCopyState("failed"),
              );
            }}
          >
            {copyLabel}
          </button>
        ) : null}
        {copyState !== "idle" ? (
          <span role="status">{copyState === "copied" ? "Copied" : "Copy failed"}</span>
        ) : null}
      </header>
      <pre tabIndex={0}>
        <code>{highlightedJson(formatted)}</code>
      </pre>
    </section>
  );
}

export interface SchemaViewerProps extends Omit<JsonCodeViewProps, "value"> {
  schema: JsonSchema;
}

export function SchemaViewer({ schema, label = "JSON Schema", ...props }: SchemaViewerProps) {
  return <JsonCodeView {...props} value={schema} label={label} />;
}
