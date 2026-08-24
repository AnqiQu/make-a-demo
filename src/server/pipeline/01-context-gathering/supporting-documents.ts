import {
  assertRecord,
  readNonEmptyString,
  readPositiveNumber,
} from "../../shared/artifact-storage/persisted-record-readers";

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
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/x-zip-compressed",
  "application/zip",
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
