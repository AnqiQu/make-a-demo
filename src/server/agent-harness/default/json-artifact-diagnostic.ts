import { createHash } from "node:crypto";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";

export type JsonSyntaxDiagnostic = {
  byteLength: number;
  column: number;
  excerpt: string;
  line: number;
  message: string;
  offset: number;
};

export function fingerprintArtifactText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function diagnoseJsonSyntax(
  value: string,
  nativeError: unknown,
): JsonSyntaxDiagnostic {
  const errors: ParseError[] = [];
  parse(value, errors, {
    allowTrailingComma: false,
    allowEmptyContent: false,
    disallowComments: true,
  });
  const firstError = errors[0];
  const offset = Math.min(firstError?.offset ?? value.length, value.length);
  const beforeError = value.slice(0, offset);
  const lastLineBreak = beforeError.lastIndexOf("\n");
  const line = beforeError.split("\n").length;
  const column = offset - lastLineBreak;
  const nativeMessage =
    nativeError instanceof Error ? nativeError.message : String(nativeError);
  const parserMessage =
    firstError === undefined
      ? "Invalid JSON"
      : printParseErrorCode(firstError.error);
  return {
    byteLength: Buffer.byteLength(value),
    column,
    excerpt: redactSecretText(
      value.slice(
        Math.max(0, offset - 180),
        Math.min(value.length, offset + 180),
      ),
    ),
    line,
    message: `${parserMessage}: ${nativeMessage}`,
    offset,
  };
}

/**
 * Matches field names that must be treated as secrets wherever keys are
 * inspected for redaction. Extend this pattern rather than copying the
 * alternation so every redaction site agrees on what counts as a secret.
 */
export const secretFieldNamePattern =
  /api[_-]?key|authorization|password|secret|token/i;

const secretJsonFieldPattern = new RegExp(
  `"[^"\\n]*(?:${secretFieldNamePattern.source})[^"\\n]*"\\s*:`,
  "i",
);

/**
 * Redacts bearer tokens and truncates at the first secret-named JSON field so
 * excerpts of agent or app output can be safely fed back into prompts and
 * durable logs. Redaction must run on every excerpt that leaves this process.
 */
export function redactSecretText(value: string): string {
  const bearerRedacted = value.replace(
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    "Bearer [Redacted]",
  );
  const secretKey = secretJsonFieldPattern.exec(bearerRedacted);
  if (secretKey?.index === undefined) {
    return bearerRedacted;
  }
  return `${bearerRedacted.slice(0, secretKey.index)}"[Redacted secret field]"`;
}
