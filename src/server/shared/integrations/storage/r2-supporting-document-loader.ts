import {
  type NormalizedSupportingDocument,
  normalizeSupportingDocument,
  readSupportingDocumentUpload,
} from "../../../pipeline/01-context-gathering/supporting-documents";
import type { QueuedSupportingDocumentUpload } from "../../persistence/neon-project-demo-generation-queue-store";

export type R2ObjectStorage = {
  bucket: string;
  getObject(input: { bucket: string; key: string }): Promise<Uint8Array>;
};

const textLikeMimeTypes = new Set([
  "application/json",
  "text/csv",
  "text/markdown",
  "text/plain",
]);

export class R2SupportingDocumentLoader {
  private readonly storage: R2ObjectStorage;

  constructor(storage: R2ObjectStorage) {
    this.storage = storage;
  }

  async loadSupportingDocuments(
    input: QueuedSupportingDocumentUpload[],
  ): Promise<NormalizedSupportingDocument[]> {
    return Promise.all(input.map((document) => this.loadDocument(document)));
  }

  private async loadDocument(document: QueuedSupportingDocumentUpload) {
    if (!textLikeMimeTypes.has(document.mimeType)) {
      throw new Error(
        `Supporting Document ${document.fileName} cannot be normalized from ${document.mimeType} yet`,
      );
    }

    const source = readSupportingDocumentUpload({
      artifactId: document.r2Url,
      fileName: document.fileName,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
    });
    const contents = new TextDecoder().decode(
      await this.storage.getObject({
        bucket: this.storage.bucket,
        key: document.r2Key,
      }),
    );

    return normalizeSupportingDocument({ contents, source });
  }
}
