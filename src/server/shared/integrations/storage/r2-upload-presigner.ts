import type { Readable } from "node:stream";
import { readSupportingDocumentUpload } from "../../../pipeline/01-context-gathering/supporting-documents";

export type SupportingDocumentUploadRequest = {
  draftId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

export type SupportingDocumentUploadTarget = {
  fileName: string;
  key: string;
  method: "PUT";
  r2Url: string;
  uploadUrl: string;
};

export type StoredSupportingDocumentUpload = {
  fileName: string;
  key: string;
  r2Url: string;
};

export type PutPresignerInput = {
  bucket: string;
  contentType: string;
  key: string;
};

export type GetPresignerInput = {
  bucket: string;
  key: string;
};

export type PutObjectInput = {
  body: Uint8Array;
  bucket: string;
  contentType: string;
  key: string;
};

export type PutStreamObjectInput = {
  body: Readable;
  bucket: string;
  contentLength: number;
  contentType: string;
  key: string;
};

export type R2UploadStorage = {
  bucket: string;
  createId?: () => string;
  putObject(input: PutObjectInput): Promise<void>;
  putStreamObject?(input: PutStreamObjectInput): Promise<void>;
  presignGet(input: GetPresignerInput): Promise<string>;
  presignPut(input: PutPresignerInput): Promise<string>;
};

export async function createSupportingDocumentUpload(
  input: SupportingDocumentUploadRequest,
  dependencies: R2UploadStorage,
): Promise<SupportingDocumentUploadTarget> {
  const key = createSupportingDocumentUploadKey(input, dependencies);
  const uploadUrl = await dependencies.presignPut({
    bucket: dependencies.bucket,
    contentType: input.mimeType,
    key,
  });

  return {
    fileName: input.fileName,
    key,
    method: "PUT",
    r2Url: `r2://${dependencies.bucket}/${key}`,
    uploadUrl,
  };
}

export async function storeSupportingDocumentUpload(
  input: SupportingDocumentUploadRequest & { body: Uint8Array },
  dependencies: R2UploadStorage,
): Promise<StoredSupportingDocumentUpload> {
  const key = createSupportingDocumentUploadKey(input, dependencies);

  await dependencies.putObject({
    body: input.body,
    bucket: dependencies.bucket,
    contentType: input.mimeType,
    key,
  });

  return {
    fileName: input.fileName,
    key,
    r2Url: `r2://${dependencies.bucket}/${key}`,
  };
}

function createSupportingDocumentUploadKey(
  input: SupportingDocumentUploadRequest,
  dependencies: R2UploadStorage,
) {
  readSupportingDocumentUpload({
    artifactId: `draft:${input.draftId}:${input.fileName}`,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
  });

  const id = dependencies.createId?.() ?? crypto.randomUUID();
  return `uploads/${input.draftId}/${id}-${safeFileName(input.fileName)}`;
}

function safeFileName(fileName: string) {
  const trimmedFileName = fileName.trim();
  const extensionMatch = /\.[a-z0-9]+$/i.exec(trimmedFileName);
  const extension = extensionMatch?.[0].toLowerCase() ?? "";
  const baseName =
    extension.length === 0
      ? trimmedFileName
      : trimmedFileName.slice(0, -extension.length);
  const base = baseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return `${base || "document"}${extension}`;
}
