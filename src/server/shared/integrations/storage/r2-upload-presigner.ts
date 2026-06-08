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

export type PutObjectInput = {
  body: Uint8Array;
  bucket: string;
  contentType: string;
  key: string;
};

export type R2UploadStorage = {
  bucket: string;
  createId?: () => string;
  putObject(input: PutObjectInput): Promise<void>;
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
  const extensionMatch = /\.[a-z0-9]+$/i.exec(fileName.trim());
  const extension = extensionMatch?.[0].toLowerCase() ?? "";
  const base = fileName
    .trim()
    .replace(extension, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return `${base || "document"}${extension}`;
}
