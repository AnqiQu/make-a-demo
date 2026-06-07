export type SupportingDocumentUpload = {
  artifactId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

export type NormalizedSupportingDocument = {
  normalizedText: string;
  sourceArtifactId: string;
  sourceFileName: string;
};

const documentMimeTypes = new Set([
  "application/json",
  "application/msword",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/csv",
  "text/markdown",
  "text/plain",
]);

export function readSupportingDocumentUpload(
  value: unknown,
): SupportingDocumentUpload {
  const record = assertRecord(value, "Supporting Document upload");
  const upload = {
    artifactId: readNonEmptyString(record, "artifactId"),
    fileName: readNonEmptyString(record, "fileName"),
    mimeType: readNonEmptyString(record, "mimeType"),
    sizeBytes: readPositiveNumber(record, "sizeBytes"),
  };

  if (
    upload.mimeType.startsWith("image/") ||
    upload.mimeType.startsWith("video/") ||
    !documentMimeTypes.has(upload.mimeType)
  ) {
    throw new Error("Supporting Documents cannot be videos or pictures");
  }

  return upload;
}

export function normalizeSupportingDocument(input: {
  contents: string;
  source: SupportingDocumentUpload;
}): NormalizedSupportingDocument {
  return {
    normalizedText: input.contents.trim().replace(/\n{3,}/g, "\n\n"),
    sourceArtifactId: input.source.artifactId,
    sourceFileName: input.source.fileName,
  };
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readNonEmptyString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }

  return value;
}

function readPositiveNumber(
  record: Record<string, unknown>,
  key: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`);
  }

  return value;
}
