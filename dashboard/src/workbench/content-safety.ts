import type { ImageContent } from "@modelcontextprotocol/server";

export const SAFE_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
] as const;

export const SAFE_EXTERNAL_LINK_PROTOCOLS = ["https:", "http:"] as const;

function normalizedMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]!.trim().toLowerCase();
}

export function isSafeImageMimeType(mimeType: string): boolean {
  const normalized = normalizedMimeType(mimeType);
  return (SAFE_IMAGE_MIME_TYPES as readonly string[]).includes(normalized);
}

function normalizedBase64(data: string): string | null {
  const compact = data.replace(/\s/gu, "");
  if (compact.length === 0) return "";
  if (compact.length % 4 !== 0) return null;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(compact)
    ? compact
    : null;
}

export function safeImageDataUrl(content: ImageContent): string | null {
  const mimeType = normalizedMimeType(content.mimeType);
  if (!isSafeImageMimeType(mimeType)) return null;
  const data = normalizedBase64(content.data);
  return data === null ? null : `data:${mimeType};base64,${data}`;
}

export function estimatedBase64Bytes(data: string): number | undefined {
  const normalized = normalizedBase64(data);
  if (normalized === null) return undefined;
  if (normalized.length === 0) return 0;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return (normalized.length / 4) * 3 - padding;
}

/** Returns a normalized href only for explicitly allowed external schemes. */
export function safeExternalHref(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (!(SAFE_EXTERNAL_LINK_PROTOCOLS as readonly string[]).includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
