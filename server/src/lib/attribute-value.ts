// TODO: this belongs in `@ancplua/qyl-api-schema/runtime`, emitted from the
// AttributeValue union node so it cannot drift from the C# converter. Copied
// verbatim from qyl/services/qyl.dashboard/src/lib/attribute-value.ts until then.
import type { AttributeValue } from "@ancplua/qyl-api-schema/types";

type TaggedAttributeValue = {
  type?: unknown;
  value?: unknown;
  base64?: unknown;
  values?: unknown;
};

/** Decode the generated lossless AttributeValue union into a presentation-safe value. */
export function decodeAttributeValue(value: AttributeValue): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeAttributeValue);

  const tagged = value as TaggedAttributeValue;
  switch (tagged.type) {
    case "int":
      return typeof tagged.value === "string" ? tagged.value : value;
    case "double":
      return typeof tagged.value === "number" || typeof tagged.value === "string"
        ? tagged.value
        : value;
    case "bytes":
      return typeof tagged.base64 === "string"
        ? { type: "bytes", base64: tagged.base64 }
        : value;
    case "kvlist": {
      if (!isRecord(tagged.values)) return value;
      return Object.fromEntries(
        Object.entries(tagged.values).map(([key, nested]) => [
          key,
          decodeAttributeValue(nested as AttributeValue),
        ]),
      );
    }
    default:
      return value;
  }
}

export function formatAttributeValue(value: AttributeValue): string {
  const decoded = decodeAttributeValue(value);
  if (decoded === null || decoded === undefined) return "null";
  if (typeof decoded === "string") return decoded;
  if (typeof decoded === "number" || typeof decoded === "boolean" || typeof decoded === "bigint") return String(decoded);
  return JSON.stringify(decoded);
}

export function attributeString(value: AttributeValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function attributeNumber(value: AttributeValue | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;

  const tagged = value as TaggedAttributeValue;
  if (tagged.type === "int" && typeof tagged.value === "string") {
    const parsed = Number(tagged.value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  if (tagged.type === "double" &&
    (typeof tagged.value === "number" || typeof tagged.value === "string")) {
    return Number(tagged.value);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
