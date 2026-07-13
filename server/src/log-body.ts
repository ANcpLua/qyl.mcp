import type { LogBody } from "@ancplua/qyl-api-schema/types";

/** Render every generated OTel LogBody variant without assuming string-only logs. */
export function logBodyText(body: LogBody): string {
  if ("string_value" in body) return body.string_value;
  if ("kv_list_value" in body) {
    return JSON.stringify(Object.fromEntries(body.kv_list_value.map(({ key, value }) => [key, value])));
  }
  if ("array_value" in body) return JSON.stringify(body.array_value);
  return `[base64 bytes: ${body.bytes_value.length} characters]`;
}
