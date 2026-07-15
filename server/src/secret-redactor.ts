const DEFAULT_REPLACEMENT = "[REDACTED]";
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_STRING_LENGTH = 16_384;

const SecretKeyNames = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "apikey",
  "accesskey",
  "secret",
  "secretkey",
  "clientsecret",
  "password",
  "passwd",
  "pwd",
  "credential",
  "credentials",
  "privatekey",
  "token",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "bearertoken",
  "sessiontoken",
  "sessionkey",
  "idtoken",
]);

const SafeTokenKeys = new Set([
  "inputtokens",
  "outputtokens",
  "tokencount",
  "tokencounts",
  "progresstoken",
  "maxtokens",
  "totaltokens",
  "prompttokens",
  "completiontokens",
  "cachedinputtokens",
  "reasoningtokens",
]);

const EnvironmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const EmbeddedUrlPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+|(?<![:\w])\/\/[^\s<>"'`]+/giu;

export interface SecretRedactorOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  secretValues?: readonly string[];
  replacement?: string;
  maxDepth?: number;
  maxStringLength?: number;
}

/**
 * Redacts credentials from diagnostic values without retaining or emitting the
 * secret source. The result is safe to serialize but deliberately does not
 * preserve object prototypes.
 */
export class SecretRedactor {
  readonly replacement: string;
  private readonly maxDepth: number;
  private readonly maxStringLength: number;
  private readonly registeredSecretValues = new Set<string>();
  private secretValues: readonly string[] = [];

  constructor(options: SecretRedactorOptions = {}) {
    this.replacement = options.replacement ?? DEFAULT_REPLACEMENT;
    this.maxDepth = positiveInteger(options.maxDepth ?? DEFAULT_MAX_DEPTH, "maxDepth");
    this.maxStringLength = positiveInteger(
      options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
      "maxStringLength",
    );

    for (const value of options.secretValues ?? []) {
      addSecretValue(this.registeredSecretValues, value, true);
    }
    for (const [name, value] of Object.entries(options.environment ?? {})) {
      if (isCredentialKey(name) && value !== undefined) {
        addSecretValue(this.registeredSecretValues, value, false);
      }
    }
    this.refreshSecretValues();
  }

  /** Registers credential values resolved after construction. */
  registerSecretValues(values: readonly string[]): void {
    const previousSize = this.registeredSecretValues.size;
    for (const value of values) {
      addSecretValue(this.registeredSecretValues, value, true);
    }
    if (this.registeredSecretValues.size !== previousSize) this.refreshSecretValues();
  }

  redact(value: unknown): unknown {
    return this.redactValue(value, 0, new WeakSet<object>());
  }

  redactText(value: string): string {
    let redacted = redactEmbeddedUrls(value);

    for (const secret of this.secretValues) {
      redacted = redacted.split(secret).join(this.replacement);
    }

    redacted = redacted
      .replace(
        /\b(authorization|proxy-authorization|x[-_]?api[-_]?key|api[-_]?key|x[-_]?otlp[-_]?api[-_]?key)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;}]+)/giu,
        (_match, name: string) => `${name}: ${this.replacement}`,
      )
      .replace(
        /(?<![A-Za-z0-9_])(["']?)(token|access[-_]?token|refresh[-_]?token|auth[-_]?token|session[-_]?token|id[-_]?token|password|passwd|pwd|secret|secret[-_]?key|client[-_]?secret|private[-_]?key)\1(?![A-Za-z0-9_])\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;}]+)/giu,
        (_match, quote: string, name: string) =>
          `${quote}${name}${quote}: ${this.replacement}`,
      )
      .replace(
        /\b(cookie|set-cookie)\s*[:=]\s*[^\r\n]*/giu,
        (_match, name: string) => `${name}: ${this.replacement}`,
      )
      .replace(
        /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu,
        (_match, scheme: string) => `${scheme} ${this.replacement}`,
      );

    if (redacted.length <= this.maxStringLength) return redacted;
    return `${redacted.slice(0, this.maxStringLength - 1)}…`;
  }

  redactUri(value: string): string {
    try {
      const networkPath = value.startsWith("//");
      const url = networkPath
        ? new URL(value, "http://redaction.invalid")
        : new URL(value);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      const result = networkPath
        ? `//${url.host}${url.pathname}`
        : url.toString();
      return this.redactTextWithoutUrls(result);
    } catch {
      return this.redactText(value.split(/[?#]/u, 1)[0]);
    }
  }

  private redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return this.redactText(value);
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "undefined"
    ) {
      return value;
    }
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "symbol" || typeof value === "function") return String(value);
    if (depth >= this.maxDepth) return "[MAX_DEPTH]";

    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => this.redactValue(item, depth + 1, seen));
      }
      if (value instanceof Date) return value.toISOString();
      if (value instanceof URL) return this.redactUri(value.toString());
      if (value instanceof Error) {
        return {
          name: value.name,
          message: this.redactText(value.message),
        };
      }

      const source = value as Record<string, unknown>;
      const semanticKey = semanticCredentialKey(source);
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(source)) {
        if (semanticKey !== undefined && key === "value") {
          result[key] = this.replacement;
        } else if (isCredentialKey(key)) {
          result[key] = this.replacement;
        } else if (typeof child === "string" && isUriKey(key)) {
          result[key] = this.redactUri(child);
        } else {
          result[key] = this.redactValue(child, depth + 1, seen);
        }
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }

  private redactTextWithoutUrls(value: string): string {
    let redacted = value;
    for (const secret of this.secretValues) {
      redacted = redacted.split(secret).join(this.replacement);
    }
    return redacted;
  }

  private refreshSecretValues(): void {
    this.secretValues = [...this.registeredSecretValues]
      .sort((left, right) => right.length - left.length);
  }
}

function semanticCredentialKey(value: Readonly<Record<string, unknown>>): string | undefined {
  if (!("value" in value)) return undefined;
  for (const field of ["key", "name", "header"] as const) {
    const candidate = value[field];
    if (typeof candidate === "string" && isCredentialKey(candidate)) return candidate;
  }
  return undefined;
}

export function isCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if ([...SafeTokenKeys].some((safeKey) => normalized.endsWith(safeKey))) return false;
  if (SecretKeyNames.has(normalized)) return true;
  return (
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("tokens") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("accesskeyid") ||
    normalized.endsWith("clientsecret") ||
    normalized.endsWith("privatekey")
  );
}

export function validateEnvironmentVariableName(name: string): void {
  if (!EnvironmentNamePattern.test(name)) {
    throw new Error(`Invalid environment variable name '${name}'.`);
  }
}

function redactEmbeddedUrls(value: string): string {
  return value.replace(EmbeddedUrlPattern, (candidate) => {
    const punctuation = /[),.!?]$/u.exec(candidate)?.[0] ?? "";
    const urlText = punctuation ? candidate.slice(0, -1) : candidate;
    try {
      const networkPath = urlText.startsWith("//");
      const url = networkPath
        ? new URL(urlText, "http://redaction.invalid")
        : new URL(urlText);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      const result = networkPath
        ? `//${url.host}${url.pathname}`
        : url.toString();
      return `${result}${punctuation}`;
    } catch {
      return candidate;
    }
  });
}

function isUriKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return normalized === "uri" ||
    normalized.endsWith("uri") ||
    normalized === "url" ||
    normalized.endsWith("url") ||
    normalized === "endpoint";
}

function addSecretValue(values: Set<string>, value: string, explicit: boolean): void {
  if (value.length > 0 && (explicit || value.length >= 4)) values.add(value);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}
