import type {
  FinalVideoStorage,
  FinalVideoUploadInput,
  StoredFinalVideo,
} from "../../../pipeline/07-compositing/final-video-storage.interface";
import type { R2UploadStorage } from "./r2-upload-presigner";

type StreamingR2UploadStorage = R2UploadStorage & {
  putStreamObject: NonNullable<R2UploadStorage["putStreamObject"]>;
};

export class R2FinalVideoStorage implements FinalVideoStorage {
  private readonly r2: StreamingR2UploadStorage;

  constructor(r2: R2UploadStorage) {
    if (r2.putStreamObject === undefined) {
      throw new Error(
        "R2 final video storage requires streaming upload support",
      );
    }
    this.r2 = r2 as StreamingR2UploadStorage;
  }

  async storeFinalVideo(
    input: FinalVideoUploadInput,
  ): Promise<StoredFinalVideo> {
    const key = createFinalVideoKey(input);

    await this.r2.putStreamObject({
      body: input.body,
      bucket: this.r2.bucket,
      contentLength: input.contentLength,
      contentType: input.contentType,
      key,
    });

    return {
      key,
      r2Url: `r2://${this.r2.bucket}/${key}`,
    };
  }
}

function createFinalVideoKey(input: FinalVideoUploadInput) {
  return `demo-videos/${safePathSegment(input.demoRequestId)}/${safePathSegment(
    input.scriptDigest.replace(/^sha256:/, ""),
  )}/${input.fileName}`;
}

function safePathSegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "");
}
